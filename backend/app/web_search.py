"""Web search for the AI assistant, run by the app rather than by the model's provider.

Anthropic's Messages API can search server-side (the `web_search_20250305` tool the
Anthropic proxy attaches), but nothing else the app talks to can: DeepSeek, OpenAI,
OpenAI-compatible endpoints and Ollama expose no such tool. A model that is merely
*told* it has one either emits Claude's text tool-call markup as ordinary output
(`<tool_calls><invoke name="web_search">…`) or — more often — tells the user it has no
web access at all. So the search is run here, by the backend, and the hits are handed
back to the model as ordinary conversation text (see the `web_search` plan action in
the frontend). That makes search a capability of the *assistant* instead of one
provider, so every model gets it.

Four backends, chosen per user in Settings → AI → Assistant:

* **duckduckgo** — no account, no key. Scrapes the same HTML endpoint the site's own
  no-JS form posts to, so it can be rate-limited or refused; the error says so and
  points at the keyed backends.
* **brave** — Brave's Search API (`X-Subscription-Token`), a real search API with a
  free tier.
* **tavily** — a search API built for LLMs: its hits carry an extracted content
  passage rather than a one-line snippet.
* **searxng** — a SearXNG instance's JSON API, for people who run their own.

Every backend is normalised to a list of :class:`SearchResult`, and failures are
raised as :class:`SearchError` with a message that is safe (and useful) to show the
user. Nothing here trusts the network: result counts are capped, snippets truncated,
and the SearXNG base URL is validated by the caller (`_require_safe_external_url` in
the settings router) before it is ever stored.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
from lxml import html as lxml_html

logger = logging.getLogger(__name__)

# One search should never hold a chat turn open for long: the model is waiting on it,
# and the assistant may run several in a round.
SEARCH_TIMEOUT = 20.0

DEFAULT_RESULTS = 5
MAX_RESULTS = 10
# Snippets go straight into the model's context, so cap what one hit can contribute.
# Tavily in particular returns multi-paragraph extracts.
MAX_SNIPPET_CHARS = 700

# Browser-ish UA for the HTML-scraping backend. DuckDuckGo's no-JS endpoint answers a
# bare client with an empty page; this is the same "look like a browser" posture as
# app.web_fetch, not an attempt to get around a block.
_SCRAPER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class ProviderSpec:
    """What a backend is called and what the user has to supply for it."""

    label: str
    needs_api_key: bool
    needs_base_url: bool


PROVIDERS: Dict[str, ProviderSpec] = {
    "duckduckgo": ProviderSpec("DuckDuckGo", needs_api_key=False, needs_base_url=False),
    "brave": ProviderSpec("Brave Search API", needs_api_key=True, needs_base_url=False),
    "tavily": ProviderSpec("Tavily", needs_api_key=True, needs_base_url=False),
    "searxng": ProviderSpec("SearXNG", needs_api_key=False, needs_base_url=True),
}

# The keyless backend, so a fresh install has working search before any signup.
DEFAULT_PROVIDER = "duckduckgo"


class SearchError(Exception):
    """A search failed in a way worth reporting to the user verbatim."""

    def __init__(self, code: str, message: str, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    published: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {"title": self.title, "url": self.url, "snippet": self.snippet}
        if self.published:
            data["published"] = self.published
        return data


def _clean(text: Any) -> str:
    """Collapse whitespace in a value that may not even be a string."""
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())


def _truncate(text: str, limit: int = MAX_SNIPPET_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _result(title: str, url: str, snippet: str, published: Optional[str] = None) -> Optional[SearchResult]:
    """Build a result, dropping anything without a usable http(s) URL."""
    url = _clean(url)
    if not url.startswith(("http://", "https://")):
        return None
    return SearchResult(
        title=_clean(title) or url,
        url=url,
        snippet=_truncate(_clean(snippet)),
        published=_clean(published) or None,
    )


def _clamp_count(count: Optional[int]) -> int:
    if not count:
        return DEFAULT_RESULTS
    return max(1, min(int(count), MAX_RESULTS))


def _http_error(provider_label: str, status: int) -> SearchError:
    """Map an upstream status onto an actionable message."""
    if status in (401, 403):
        return SearchError(
            "search_auth_failed",
            f"{provider_label} rejected the API key (HTTP {status}). Check it in Settings → AI → Assistant.",
        )
    if status == 429:
        return SearchError(
            "search_rate_limited",
            f"{provider_label} is rate-limiting the search (HTTP 429). Try again shortly, or switch backend.",
        )
    return SearchError("search_failed", f"{provider_label} returned HTTP {status}.")


# ─── Backends ─────────────────────────────────────────────────────────────────


async def _search_duckduckgo(client: httpx.AsyncClient, query: str, count: int) -> List[SearchResult]:
    """DuckDuckGo's no-JS HTML endpoint — the one its own `<form>` posts to."""
    try:
        response = await client.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query, "kl": "wt-wt"},
            headers={
                "User-Agent": _SCRAPER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://html.duckduckgo.com/",
            },
        )
    except httpx.RequestError as exc:
        raise SearchError("search_unreachable", f"Could not reach DuckDuckGo: {type(exc).__name__}")

    if not response.is_success:
        raise _http_error("DuckDuckGo", response.status_code)

    results = _parse_duckduckgo_html(response.text, count)
    if not results:
        # Worth a log line: it separates "throttled" (a short interstitial) from "their
        # markup changed" (a full-size page the parser no longer recognises).
        logger.info("duckduckgo returned no parseable results (%d bytes)", len(response.text))
        raise SearchError(
            "search_blocked",
            "DuckDuckGo returned no results — it throttles automated requests from shared/server "
            "addresses. Try again, or configure Brave or Tavily in Settings → AI → Assistant.",
        )
    return results


def _unwrap_duckduckgo_link(href: str) -> str:
    """DuckDuckGo wraps every hit in a redirect (`/l/?uddg=<encoded target>`); unwrap it."""
    href = (href or "").strip()
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if parsed.path.startswith("/l/") or "uddg" in (parsed.query or ""):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target:
            return target
    return href


# Class-token XPath tests. A plain contains(@class, 'result') would also match the
# `results` wrapper (and `result__body`, `result__snippet`, …), so each token is matched
# with its surrounding spaces — the standard way to test one class in XPath 1.0.
def _has_class(token: str) -> str:
    return f"contains(concat(' ', normalize-space(@class), ' '), ' {token} ')"


def _parse_duckduckgo_html(body: str, count: int) -> List[SearchResult]:
    """Pull (title, url, snippet) out of the results page. Kept separate from the fetch
    so it is directly testable against a saved page."""
    try:
        tree = lxml_html.fromstring(body)
    except Exception:  # malformed markup — treat as "no results"
        return []

    results: List[SearchResult] = []
    seen: set = set()
    for row in tree.xpath(f"//div[{_has_class('result')}]"):
        # Sponsored rows carry result--ad; they are not search hits.
        if "result--ad" in (row.get("class") or ""):
            continue

        anchors = row.xpath(f".//a[{_has_class('result__a')}]")
        if not anchors:
            continue

        url = _unwrap_duckduckgo_link(anchors[0].get("href") or "")
        if not url or url in seen:
            continue

        snippet_nodes = row.xpath(f".//*[{_has_class('result__snippet')}]")
        snippet = snippet_nodes[0].text_content() if snippet_nodes else ""

        hit = _result(anchors[0].text_content(), url, snippet)
        if hit:
            seen.add(hit.url)
            results.append(hit)
        if len(results) >= count:
            break
    return results


async def _search_brave(client: httpx.AsyncClient, query: str, count: int, api_key: str) -> List[SearchResult]:
    try:
        response = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": count, "safesearch": "moderate", "result_filter": "web"},
            headers={
                "X-Subscription-Token": api_key,
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            },
        )
    except httpx.RequestError as exc:
        raise SearchError("search_unreachable", f"Could not reach the Brave Search API: {type(exc).__name__}")

    if not response.is_success:
        raise _http_error("The Brave Search API", response.status_code)

    payload = _json_body(response, "Brave Search")
    raw = ((payload.get("web") or {}).get("results")) or []
    return _collect(raw, count, title="title", url="url", snippet="description", published="page_age")


async def _search_tavily(client: httpx.AsyncClient, query: str, count: int, api_key: str) -> List[SearchResult]:
    try:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "query": query,
                "max_results": count,
                "search_depth": "basic",
                "include_answer": False,
                "include_raw_content": False,
            },
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
    except httpx.RequestError as exc:
        raise SearchError("search_unreachable", f"Could not reach Tavily: {type(exc).__name__}")

    if not response.is_success:
        raise _http_error("Tavily", response.status_code)

    payload = _json_body(response, "Tavily")
    raw = payload.get("results") or []
    # Tavily's "content" is an extracted passage, not a one-line snippet — the reason
    # it is worth configuring for research-heavy use.
    return _collect(raw, count, title="title", url="url", snippet="content", published="published_date")


async def _search_searxng(client: httpx.AsyncClient, query: str, count: int, base_url: str) -> List[SearchResult]:
    url = urljoin(base_url.rstrip("/") + "/", "search")
    try:
        response = await client.get(
            url,
            params={"q": query, "format": "json", "safesearch": 1, "language": "en"},
            headers={"Accept": "application/json", "User-Agent": _SCRAPER_UA},
        )
    except httpx.RequestError as exc:
        raise SearchError("search_unreachable", f"Could not reach the SearXNG instance: {type(exc).__name__}")

    if not response.is_success:
        # A SearXNG instance that hasn't enabled the JSON format answers 403 here, which
        # is a configuration problem rather than a bad key — say so.
        if response.status_code == 403:
            raise SearchError(
                "search_forbidden",
                "The SearXNG instance refused the request. Its settings.yml must list `json` "
                "under `search.formats` for the API to work.",
            )
        raise _http_error("The SearXNG instance", response.status_code)

    payload = _json_body(response, "SearXNG")
    raw = payload.get("results") or []
    return _collect(raw, count, title="title", url="url", snippet="content", published="publishedDate")


def _json_body(response: httpx.Response, label: str) -> Dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        raise SearchError("search_failed", f"{label} returned a response that wasn't JSON.")
    if not isinstance(payload, dict):
        raise SearchError("search_failed", f"{label} returned an unexpected response shape.")
    return payload


def _collect(raw: Any, count: int, *, title: str, url: str, snippet: str, published: str) -> List[SearchResult]:
    """Normalise a backend's result list, skipping entries that aren't usable."""
    results: List[SearchResult] = []
    if not isinstance(raw, list):
        return results
    for item in raw:
        if not isinstance(item, dict):
            continue
        hit = _result(item.get(title, ""), item.get(url, ""), item.get(snippet, ""), item.get(published))
        if hit:
            results.append(hit)
        if len(results) >= count:
            break
    return results


# ─── Entry point ──────────────────────────────────────────────────────────────


async def search_web(
    *,
    provider: str,
    query: str,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    count: Optional[int] = None,
) -> List[SearchResult]:
    """Run one search against the configured backend.

    Raises :class:`SearchError` for anything the user needs to know about — an unknown
    or unconfigured backend, an auth failure, a throttle, an unreachable endpoint. An
    empty list is a legitimate answer (the query genuinely matched nothing) for every
    backend except the scraper, which cannot tell "no hits" from "refused".
    """
    query = (query or "").strip()
    if not query:
        raise SearchError("empty_query", "The search query was empty.", 400)

    spec = PROVIDERS.get(provider)
    if not spec:
        raise SearchError("unknown_provider", f"Unknown web search backend “{provider}”.", 400)

    api_key = (api_key or "").strip()
    base_url = (base_url or "").strip()
    if spec.needs_api_key and not api_key:
        raise SearchError(
            "search_unconfigured",
            f"{spec.label} needs an API key. Add one in Settings → AI → Assistant.",
            400,
        )
    if spec.needs_base_url and not base_url:
        raise SearchError(
            "search_unconfigured",
            f"{spec.label} needs an instance URL. Add one in Settings → AI → Assistant.",
            400,
        )

    count = _clamp_count(count)
    timeout = httpx.Timeout(SEARCH_TIMEOUT, connect=10.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            if provider == "duckduckgo":
                return await _search_duckduckgo(client, query, count)
            if provider == "brave":
                return await _search_brave(client, query, count, api_key)
            if provider == "tavily":
                return await _search_tavily(client, query, count, api_key)
            return await _search_searxng(client, query, count, base_url)
        except httpx.TimeoutException:
            raise SearchError(
                "search_timeout",
                f"{spec.label} did not respond within {SEARCH_TIMEOUT:.0f}s.",
                504,
            )
