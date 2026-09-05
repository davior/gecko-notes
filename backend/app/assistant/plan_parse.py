"""Reading a plan out of whatever the model actually said.

A faithful port of `parsePlan` and its helpers in `frontend/src/services/aiPlan.ts`.
Planning moved to the server, and the worker has to know what came back before it can
do anything with it: whether the reply is a plain answer, whether it wants a search
run first, and — when plan mode is off — whether it is safe to start executing without
a browser in the loop. None of those questions can be answered without parsing.

This is deliberately a port rather than a tidy-up, for the same reason `executor.py`
was. Every helper here exists because some model actually emitted the shape it
handles: prose wrapped around the JSON, a ```json fence, an XML-ish <actions> block
from DeepSeek, Claude's text tool-call markup, a bare action object instead of the
envelope, and — the fiddly one — a stray unescaped `"` inside a note body that ends
its JSON string early and takes the whole plan down with it. Simplifying any of them
means losing a reply that used to survive.

Two implementations of one contract will drift, so they are checked against each
other: `backend/tools/plan_parse_diff/` runs a corpus through both this module and the
TypeScript original and diffs the result. Run it after touching either side.

The JavaScript semantics that do NOT come across for free are isolated in `_js_str`
and `_js_number` at the bottom, with the divergences they paper over spelled out.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple

# Defensive ceiling so a runaway model can't queue thousands of mutations.
# Mirrors MAX_PLAN_ACTIONS in aiPlan.ts.
MAX_PLAN_ACTIONS = 50

# Hits a single web_search action may ask for. Mirrors MAX_WEB_SEARCH_RESULTS.
MAX_WEB_SEARCH_RESULTS = 10

NO_RESPONSE = "(no response)"
NO_VALID_PLAN = (
    "I couldn't come up with a valid plan for that — could you rephrase your request?"
)

# Action types that are retrieval steps: resolved before the plan runs, never executed.
RETRIEVAL_TYPES = frozenset({"find_notes", "web_search"})


# ─── validation ──────────────────────────────────────────────────────────────


def _as_string(value: Any) -> Optional[str]:
    """`asString`: the value if it is a string, else absent."""
    return value if isinstance(value, str) else None


def validate_action(raw: Any) -> Optional[Dict[str, Any]]:
    """One action, normalised — or None when it is unusable and should be dropped.

    Key order matches the TypeScript object literals so a diff of the two outputs
    reads cleanly; only the content is load-bearing.
    """
    if not isinstance(raw, dict):
        return None

    kind = raw.get("type")

    # Optional trailers shared by most actions. Each is dropped when empty, matching
    # `desc ? { description: desc } : {}` — an empty string is not carried.
    description = _as_string(raw.get("description"))
    trailer: Dict[str, Any] = {"description": description} if description else {}
    ref = _as_string(raw.get("ref"))
    ref_field: Dict[str, Any] = {"ref": ref} if ref else {}
    # Deferred-body description on content-bearing actions (see the `spec` mechanism).
    spec = _as_string(raw.get("spec"))
    spec_field: Dict[str, Any] = {"spec": spec} if spec else {}

    if kind == "respond":
        text = _as_string(raw.get("text"))
        if text is None:
            return None
        return {"type": "respond", "text": text, **trailer}

    if kind == "find_notes":
        query = _as_string(raw.get("query"))
        # "absent" (no folder scope) and an explicit null (the root) mean different
        # things, so this cannot go through _as_string, which collapses both.
        folder_raw = raw.get("folderId")
        # `a.folderId === null` is true only for a key that is PRESENT and null;
        # .get() collapses "absent" and "null" into None, so ask for the key too.
        explicit_null = "folderId" in raw and folder_raw is None
        folder_given = explicit_null or isinstance(folder_raw, str)
        if not query and not folder_given:
            return None
        action: Dict[str, Any] = {"type": "find_notes"}
        if query:
            action["query"] = query
        if folder_given:
            action["folderId"] = folder_raw if isinstance(folder_raw, str) else None
        if raw.get("recursive") is True:
            action["recursive"] = True
        return {**action, **trailer}

    if kind == "web_search":
        query = _as_string(raw.get("query"))
        query = query.strip() if query else None
        if not query:
            return None
        # `"maxResults": "5"` from a model that quoted the number is still a number.
        asked = _js_number(raw.get("maxResults"))
        max_results = (
            min(_js_round(asked), MAX_WEB_SEARCH_RESULTS)
            if math.isfinite(asked) and asked > 0
            else 0
        )
        action = {"type": "web_search", "query": query}
        if max_results:
            action["maxResults"] = max_results
        return {**action, **trailer}

    if kind == "create_note":
        title = _as_string(raw.get("title"))
        # Strictly `undefined`, not falsy: an empty title is a legal (if odd) note.
        if title is None:
            return None
        return {
            "type": "create_note",
            "title": title,
            "content": _as_string(raw.get("content")) or "",
            **spec_field,
            **ref_field,
            **trailer,
        }

    if kind == "edit_note":
        note_id = _as_string(raw.get("noteId"))
        if not note_id:
            return None
        return {
            "type": "edit_note",
            "noteId": note_id,
            # Anything but an explicit "replace" amends — the safer of the two.
            "mode": "replace" if raw.get("mode") == "replace" else "amend",
            "content": _as_string(raw.get("content")) or "",
            **spec_field,
            **trailer,
        }

    if kind == "edit_section":
        note_id = _as_string(raw.get("noteId"))
        section = _as_string(raw.get("section"))
        if not note_id or not section:
            return None
        return {
            "type": "edit_section",
            "noteId": note_id,
            "section": section,
            "content": _as_string(raw.get("content")) or "",
            **spec_field,
            **trailer,
        }

    if kind == "append_note":
        note_id = _as_string(raw.get("noteId"))
        if not note_id:
            return None
        return {
            "type": "append_note",
            "noteId": note_id,
            "content": _as_string(raw.get("content")) or "",
            **spec_field,
            **trailer,
        }

    if kind == "rename_note":
        note_id = _as_string(raw.get("noteId"))
        title = _as_string(raw.get("title"))
        if not note_id or title is None:
            return None
        return {"type": "rename_note", "noteId": note_id, "title": title, **trailer}

    if kind == "create_child_note":
        parent_id = _as_string(raw.get("parentId"))
        title = _as_string(raw.get("title"))
        if not parent_id or title is None:
            return None
        return {
            "type": "create_child_note",
            "parentId": parent_id,
            "title": title,
            "content": _as_string(raw.get("content")) or "",
            **spec_field,
            **ref_field,
            **trailer,
        }

    if kind == "move_note":
        note_id = _as_string(raw.get("noteId"))
        if not note_id:
            return None
        folder_raw = raw.get("folderId")
        return {
            "type": "move_note",
            "noteId": note_id,
            # Always present: a missing or non-string folder means the root, same as
            # an explicit null.
            "folderId": folder_raw if isinstance(folder_raw, str) else None,
            **trailer,
        }

    if kind == "set_tags":
        note_id = _as_string(raw.get("noteId"))
        tags = raw.get("tags")
        if not note_id or not isinstance(tags, list):
            return None
        return {
            "type": "set_tags",
            "noteId": note_id,
            "tags": [_js_str(t) for t in tags],
            "mode": "add" if raw.get("mode") == "add" else "replace",
            **trailer,
        }

    if kind == "set_category":
        note_id = _as_string(raw.get("noteId"))
        category_id = _as_string(raw.get("categoryId"))
        if not note_id or not category_id:
            return None
        return {
            "type": "set_category",
            "noteId": note_id,
            "categoryId": category_id,
            **trailer,
        }

    if kind == "create_folder":
        name = _as_string(raw.get("name"))
        if not name:
            return None
        parent_raw = raw.get("parentFolderId")
        return {
            "type": "create_folder",
            "name": name,
            "parentFolderId": parent_raw if isinstance(parent_raw, str) else None,
            **ref_field,
            **trailer,
        }

    if kind == "add_reference":
        note_id = _as_string(raw.get("noteId"))
        reference_note_id = _as_string(raw.get("referenceNoteId"))
        reference_title = _as_string(raw.get("referenceTitle"))
        if not note_id or not reference_note_id or reference_title is None:
            return None
        action = {
            "type": "add_reference",
            "noteId": note_id,
            "referenceNoteId": reference_note_id,
            "referenceTitle": reference_title,
        }
        # The TS assigns this unconditionally, so it is `undefined` when absent —
        # which JSON.stringify drops. Omitting the key is the same thing on the wire.
        insert_after = _as_string(raw.get("insertAfterSection"))
        if insert_after is not None:
            action["insertAfterSection"] = insert_after
        return {**action, **trailer}

    if kind == "add_annotation":
        note_id = _as_string(raw.get("noteId"))
        anchor_text = _as_string(raw.get("anchorText"))
        if not note_id or not anchor_text:
            return None
        return {
            "type": "add_annotation",
            "noteId": note_id,
            "anchorText": anchor_text,
            "text": _as_string(raw.get("text")) or "",
            **trailer,
        }

    if kind == "edit_annotation":
        note_id = _as_string(raw.get("noteId"))
        annotation_id = _as_string(raw.get("annotationId"))
        if not note_id or not annotation_id:
            return None
        return {
            "type": "edit_annotation",
            "noteId": note_id,
            "annotationId": annotation_id,
            "text": _as_string(raw.get("text")) or "",
            **trailer,
        }

    if kind == "delete_annotation":
        note_id = _as_string(raw.get("noteId"))
        annotation_id = _as_string(raw.get("annotationId"))
        if not note_id or not annotation_id:
            return None
        return {
            "type": "delete_annotation",
            "noteId": note_id,
            "annotationId": annotation_id,
            **trailer,
        }

    if kind == "create_diagram":
        note_id = _as_string(raw.get("noteId"))
        source = _as_string(raw.get("source"))
        if not note_id or not source or not source.strip():
            return None
        return {"type": "create_diagram", "noteId": note_id, "source": source, **trailer}

    if kind == "edit_diagram":
        note_id = _as_string(raw.get("noteId"))
        diagram_id = _as_string(raw.get("diagramId"))
        source = _as_string(raw.get("source"))
        if not note_id or not diagram_id or not source or not source.strip():
            return None
        return {
            "type": "edit_diagram",
            "noteId": note_id,
            "diagramId": diagram_id,
            "source": source,
            **trailer,
        }

    if kind == "generate_image":
        note_id = _as_string(raw.get("noteId"))
        prompt = _as_string(raw.get("prompt"))
        if not note_id or not prompt or not prompt.strip():
            return None
        action = {"type": "generate_image", "noteId": note_id, "prompt": prompt}
        section = _as_string(raw.get("section"))
        if section:
            action["section"] = section
        alt = _as_string(raw.get("alt"))
        if alt:
            action["alt"] = alt
        return {**action, **trailer}

    if kind == "create_recipe":
        name = _as_string(raw.get("name"))
        prompt = _as_string(raw.get("prompt"))
        if not name or not prompt or not prompt.strip():
            return None
        action = {"type": "create_recipe", "name": name, "prompt": prompt}
        tags = raw.get("tags")
        if isinstance(tags, list):
            action["tags"] = [_js_str(t) for t in tags]
        return {**action, **trailer}

    if kind == "update_recipe":
        recipe_id = _as_string(raw.get("recipeId"))
        if not recipe_id:
            return None
        action = {"type": "update_recipe", "recipeId": recipe_id}
        name = _as_string(raw.get("name"))
        if name:
            action["name"] = name
        prompt = _as_string(raw.get("prompt"))
        if prompt:
            action["prompt"] = prompt
        tags = raw.get("tags")
        if isinstance(tags, list):
            action["tags"] = [_js_str(t) for t in tags]
        return {**action, **trailer}

    if kind == "delete_recipe":
        recipe_id = _as_string(raw.get("recipeId"))
        if not recipe_id:
            return None
        return {"type": "delete_recipe", "recipeId": recipe_id, **trailer}

    return None


# ─── locating the JSON ───────────────────────────────────────────────────────


def _looks_like_plan(parsed: Any) -> bool:
    """A parsed value that could be a plan: the {actions:[…]} envelope, or a bare
    {type:…} action, which the model sometimes emits instead."""
    if not isinstance(parsed, dict):
        return False
    return isinstance(parsed.get("actions"), list) or isinstance(parsed.get("type"), str)


def _json_loads(text: str) -> Any:
    """`JSON.parse`, including its refusal of NaN/Infinity.

    Python's json accepts those by default; JavaScript's does not, and a candidate
    slice that only "parses" because of that leniency must not be treated as a plan.
    """
    return json.loads(text, parse_constant=_reject_constant)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def match_brace(text: str, open_at: int) -> int:
    """Index of the '}' matching the '{' at `open_at`, or -1 when unbalanced.

    Braces inside JSON string literals (and their backslash escapes) are ignored, so
    prose like `the set {a, b}` embedded in a string doesn't throw off the depth count.
    """
    depth = 0
    in_string = False
    escaped = False
    for i in range(open_at, len(text)):
        char = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


_WS = " \t\n\r"


def repair_unescaped_quotes(src: str) -> str:
    """Best-effort repair for the one malformation strict JSON can't survive.

    A double quote left UNESCAPED inside a string value — a note body writing
    `*Note: "Many report…"` with straight ASCII quotes rather than \\" or typographic
    ones — ends the string early and turns the rest of the object into a syntax error,
    losing the whole plan and dumping the raw reply as text instead.

    This walks the JSON and escapes any `"` that is clearly interior to a string
    rather than a real terminator. It runs ONLY after strict parsing has already
    failed, and its output is used only if it then parses to a plan, so it can rescue
    an unparseable reply but never alters one that was already fine.
    """
    out: List[str] = []
    stack: List[str] = []  # enclosing containers ('{' / '['), tracked outside strings
    n = len(src)

    def skip_ws(j: int) -> int:
        while j < n and src[j] in _WS:
            j += 1
        return j

    def is_real_close(after: int) -> bool:
        """Given the index just after a candidate closing quote, is that quote a real
        string terminator rather than a stray quote inside the string?

        A terminator is followed by a structural token: ':' ends a key, '}' or ']'
        ends the last value or element, and ',' separates values. The comma is the
        ambiguous one — `"phrase",` sits happily inside prose — so in an object a real
        value-close must be followed by the next KEY (a string then ':'); if it isn't,
        the quote was interior. Array elements are always comma-separated, so there a
        comma does close the element.
        """
        k = skip_ws(after)
        if k >= n:
            return True
        char = src[k]
        if char in ":}]":
            return True
        if char != ",":
            return False
        m = skip_ws(k + 1)
        if m >= n:
            return True
        following = src[m]
        if following in "}]":
            return True  # tolerated trailing comma
        if not stack or stack[-1] != "{":
            return True  # array element separator
        if following != '"':
            return False  # an object value-close needs a key next
        m += 1  # scan the following (escape-aware) key
        while m < n:
            if src[m] == "\\":
                m += 2
                continue
            if src[m] == '"':
                break
            m += 1
        after_key = skip_ws(m + 1)  # …a key is a string followed by ':'
        return after_key < n and src[after_key] == ":"

    i = 0
    while i < n:
        char = src[i]
        if char != '"':
            if char in "{[":
                stack.append(char)
            elif char in "}]":
                if stack:
                    stack.pop()
            out.append(char)
            i += 1
            continue

        out.append('"')  # opening quote — scan to its true end, escaping stray quotes
        i += 1
        while i < n:
            ch = src[i]
            if ch == "\\":
                out.append(ch)
                if i + 1 < n:
                    out.append(src[i + 1])
                i += 2
                continue
            if ch == '"':
                if is_real_close(i + 1):
                    out.append('"')
                    i += 1
                    break
                out.append('\\"')
                i += 1
                continue
            out.append(ch)
            i += 1
    return "".join(out)


def _plan_json_or_repair(candidate: str) -> Optional[str]:
    """Strict parse of a candidate slice, falling back to a quote-repair pass.

    Returns the JSON text to use — the original when already valid, the repaired text
    when repair makes it a plan — or None when neither yields one.
    """
    try:
        if _looks_like_plan(_json_loads(candidate)):
            return candidate
    except (ValueError, TypeError):
        pass  # fall through to the repair attempt
    try:
        repaired = repair_unescaped_quotes(candidate)
        if repaired != candidate and _looks_like_plan(_json_loads(repaired)):
            return repaired
    except (ValueError, TypeError):
        pass  # unrepairable — give up on this candidate
    return None


_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


class LocatedPlan:
    """The plan's JSON slice, plus the prose the model wrote around it."""

    __slots__ = ("json", "before", "after")

    def __init__(self, json_text: str, before: str, after: str) -> None:
        self.json = json_text
        self.before = before
        self.after = after


def locate_plan_json(text: str) -> Optional[LocatedPlan]:
    """Find the plan JSON inside a (possibly prose-wrapped) reply.

    Prefers a fenced ```json block; otherwise scans for the FIRST brace-balanced slice
    that parses to a plan, so a stray '{' in prose (an inline example, say) can't
    hijack the parse the way a naive first-brace-to-last-brace span would, and the
    prose around the JSON is preserved rather than swallowed.
    """
    fence = _FENCE_RE.search(text)
    if fence:
        inner = fence.group(1).strip()
        if inner.startswith("{"):
            found = _plan_json_or_repair(inner)
            if found:
                return LocatedPlan(found, text[: fence.start()], text[fence.end():])

    for i, char in enumerate(text):
        if char != "{":
            continue
        end = match_brace(text, i)
        if end == -1:
            continue
        found = _plan_json_or_repair(text[i: end + 1])
        if found:
            return LocatedPlan(found, text[:i], text[end + 1:])

    # Last resort: an unescaped quote can desync match_brace's string tracking so that
    # no balanced slice is found above. Try the widest {…} span with a repair pass —
    # reached only when the precise scan found nothing, so it never overrides a
    # cleaner match.
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last > first:
        found = _plan_json_or_repair(text[first: last + 1])
        if found:
            return LocatedPlan(found, text[:first], text[last + 1:])
    return None


_FENCE_MARKER_RE = re.compile(r"```(?:json)?", re.IGNORECASE)
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def extract_outside_prose(located: LocatedPlan) -> str:
    """Prose the model wrote outside the JSON envelope, cleaned but with its Markdown
    structure intact.

    This is the real answer in the failure mode where the model puts its reply in
    prose and only a meta-summary in `respond.text`.
    """
    parts = [
        _FENCE_MARKER_RE.sub("", part).strip()
        for part in (located.before, located.after)
    ]
    joined = "\n\n".join(part for part in parts if part)
    return _BLANK_RUN_RE.sub("\n\n", joined).strip()


# ─── normalising the model's wrappers ────────────────────────────────────────

_ACTIONS_BLOCK_RE = re.compile(
    r"<actions\b[^>]*>([\s\S]*?)</actions>|<actions\b[^>]*/>", re.IGNORECASE
)
_ACTIONS_TAG_RE = re.compile(r"</?actions\b[^>]*>", re.IGNORECASE)
_TOOL_CALL_BLOCK_RE = re.compile(
    r"<(function_calls|tool_calls)\b[^>]*>[\s\S]*?</\1>", re.IGNORECASE
)
_TOOL_CALL_TAG_RE = re.compile(
    r"</?(?:function_calls|tool_calls)\b[^>]*>", re.IGNORECASE
)


def normalize_action_tags(raw: str) -> str:
    """Fold the model's non-JSON wrappers back into the shape the parser expects.

    Some OpenAI-compatible models — DeepSeek most notably — ignore the "JSON only"
    contract and wrap their plan in an XML-ish <actions>…</actions> block, or append
    an EMPTY <actions></actions> after an ordinary conversational reply. Neither is
    valid plan JSON, so the locator misses it and the tags render verbatim in the
    chat. An array inner becomes an `{"actions": …}` envelope, an object or full
    envelope is passed through, and an empty one is dropped, leaving the surrounding
    prose as the reply.

    Claude's TEXT tool-call markup goes the same way. A model told it has a tool whose
    provider wired up none "calls" it by emitting <function_calls>/<tool_calls> as
    ordinary output; providers are no longer told about tools they lack, so this is a
    backstop for any model that emits it regardless.

    A no-op for well-formed replies — the patterns simply never match.
    """

    def fold(match: "re.Match[str]") -> str:
        inner = (match.group(1) or "").strip()
        if not inner:
            return ""  # empty container → strip the tags
        if inner.startswith("["):
            return f'{{"actions": {inner}}}'  # bare action array → envelope
        return inner  # object / full envelope → hand to the JSON locator

    out = _ACTIONS_BLOCK_RE.sub(fold, raw)
    # Orphan or unclosed markers left behind by a reply truncated mid-block: container
    # noise, never content.
    out = _ACTIONS_TAG_RE.sub("", out)
    out = _TOOL_CALL_BLOCK_RE.sub("", out)
    out = _TOOL_CALL_TAG_RE.sub("", out)
    return out


# ─── the parse ───────────────────────────────────────────────────────────────


def _respond_only(text: str) -> Dict[str, Any]:
    return {"actions": [{"type": "respond", "text": text}]}


def parse_plan(raw: str) -> Dict[str, Any]:
    """The model's reply as a plan. Never raises, and never loses the reply.

    Every failure path still returns something sayable: when no plan JSON can be
    found the whole message *is* the answer, and when an envelope was found but held
    no usable action, only the prose around it is shown — never the literal JSON.
    """
    text = normalize_action_tags(raw or "")
    if not text or not text.strip():
        return _respond_only(NO_RESPONSE)

    try:
        located = locate_plan_json(text)
        if located is None:
            return _respond_only(text.strip() or NO_RESPONSE)

        parsed = _json_loads(located.json)
        # A bare action object (e.g. {"type":"respond",…}) is wrapped so it is
        # validated and rendered as a normal reply rather than shown as raw JSON.
        is_bare_action = isinstance(parsed, dict) and "type" in parsed
        actions_raw = [parsed] if is_bare_action else (
            parsed.get("actions") if isinstance(parsed, dict) else None
        )
        if not isinstance(actions_raw, list):
            return _respond_only(extract_outside_prose(located) or NO_VALID_PLAN)

        actions: List[Dict[str, Any]] = []
        for candidate in actions_raw[:MAX_PLAN_ACTIONS]:
            valid = validate_action(candidate)
            if valid:
                actions.append(valid)
        if not actions:
            return _respond_only(extract_outside_prose(located) or NO_VALID_PLAN)

        # Any prose outside the envelope goes first, so it reads above the mutation
        # list and survives a cancelled plan.
        outside = extract_outside_prose(located)
        if outside:
            actions.insert(0, {"type": "respond", "text": outside})

        if len(actions_raw) > MAX_PLAN_ACTIONS:
            actions.append({
                "type": "respond",
                "text": f"_(Plan truncated to the first {MAX_PLAN_ACTIONS} actions.)_",
            })
        return {"actions": actions}
    except Exception:
        return _respond_only(text.strip() or NO_RESPONSE)


# ─── reading a plan ──────────────────────────────────────────────────────────


def is_respond_only(plan: Dict[str, Any]) -> bool:
    """True when the plan only talks — nothing to approve, nothing to execute."""
    actions = plan.get("actions") or []
    return bool(actions) and all(a.get("type") == "respond" for a in actions)


def respond_text(plan: Dict[str, Any]) -> str:
    """The conversational half of a plan, as one message."""
    parts = [
        a.get("text") or ""
        for a in plan.get("actions") or []
        if a.get("type") == "respond"
    ]
    return "\n\n".join(part for part in parts if part)


def split_retrieval(plan: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(retrieval actions, everything else). Retrieval is resolved before the plan
    runs and is never handed to the executor."""
    actions = plan.get("actions") or []
    retrieval = [a for a in actions if a.get("type") in RETRIEVAL_TYPES]
    rest = [a for a in actions if a.get("type") not in RETRIEVAL_TYPES]
    return retrieval, rest


# ─── JavaScript semantics that don't come across for free ────────────────────


def _js_str(value: Any) -> str:
    """`String(v)` for the values JSON can produce.

    Python's `str` disagrees with JavaScript's on almost all of them — `str(True)` is
    "True" not "true", `str(None)` is "None" not "null", `str(1.0)` is "1.0" not "1" —
    and this feeds `set_tags`, where a model quoting a numeric tag would otherwise
    produce a different tag on each side.
    """
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):  # before int: bool is a subclass of int
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number_str(value)
    if isinstance(value, list):
        # Array.prototype.toString joins with commas; null/undefined render empty.
        return ",".join("" if v is None else _js_str(v) for v in value)
    return "[object Object]"


def _js_number_str(value: float) -> str:
    """JavaScript prints a whole number without a decimal point: 1.0 is "1"."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def _js_number(value: Any) -> float:
    """`Number(v)`, returning NaN where JavaScript would.

    Only `maxResults` needs this, but it needs the whole shape of it: `Number("5")` is
    5, `Number("")` is 0, `Number(null)` is 0, and `Number("abc")` is NaN — where
    Python would variously raise or refuse.
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        if "_" in text:  # Number("1_000") is NaN; float("1_000") is not
            return math.nan
        try:
            return float(text)
        except ValueError:
            try:  # Number() also reads 0x/0o/0b literals
                return float(int(text, 0))
            except ValueError:
                return math.nan
    if isinstance(value, list):
        # Number([]) is 0 and Number([5]) is 5, via the string conversion.
        return _js_number(_js_str(value)) if len(value) < 2 else math.nan
    return math.nan


def _js_round(value: float) -> int:
    """`Math.round`: halves go up, toward +Infinity. Python's round() would send 2.5
    to 2 (banker's rounding) and 0.5 to 0."""
    return math.floor(value + 0.5)


__all__ = [
    "MAX_PLAN_ACTIONS",
    "MAX_WEB_SEARCH_RESULTS",
    "RETRIEVAL_TYPES",
    "parse_plan",
    "validate_action",
    "normalize_action_tags",
    "locate_plan_json",
    "extract_outside_prose",
    "repair_unescaped_quotes",
    "match_brace",
    "is_respond_only",
    "respond_text",
    "split_retrieval",
]
