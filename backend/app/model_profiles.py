"""Per-model request-parameter helpers for the LLM proxies.

Two concerns live here:

1. ``parse_extra_params`` — decode a provider's stored ``extra_params`` JSON blob into a
   dict that is safe to merge into an outgoing request body. Uncommon / provider-specific
   parameters (and ``temperature`` itself) are configured per provider and merged at send
   time, so the base request sends nothing optional by default.

2. ``anthropic_supports_temperature`` — the Anthropic model families that reject the
   ``temperature`` sampling parameter. This is now used only by the one-time DB migration
   that backfills ``extra_params`` for existing providers (so a provider already on a
   temperature-rejecting model isn't given a ``temperature`` it would 400 on). It is no
   longer consulted at request time.

Matching mirrors ``pricing.py``: a lowercased substring test against the model id, so a
dated snapshot (``...-20260101``) matches the same family.
"""

import json
from typing import Any, Optional

# Request-body keys the proxies build themselves. An `extra_params` blob must never
# override these — doing so could break routing, auth, the message payload, or the
# output cap — so they are stripped before the merge.
_PROTECTED_PARAM_KEYS = frozenset({
    "model",
    "max_tokens",
    "messages",
    "system",
    "tools",
    "stream",
    "stream_options",
    "provider_id",
})


def parse_extra_params(raw: Optional[str]) -> dict[str, Any]:
    """Decode a provider's ``extra_params`` JSON text into a dict safe to merge into a
    request body. Returns ``{}`` for missing / invalid / non-object JSON, and drops any
    protected structural key so the blob can only add optional parameters."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if k not in _PROTECTED_PARAM_KEYS}


# Anthropic model families whose Messages API rejects the `temperature` sampling
# parameter. Opus 4.7 / 4.8 / 5, Sonnet 5, and Fable/Mythos 5 all 400 on it;
# Opus 4.6 / Sonnet 4.6 and earlier still accept it. Add a family here when
# Anthropic ships a new model that drops the parameter.
_ANTHROPIC_TEMPERATURE_UNSUPPORTED: tuple[str, ...] = (
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
)


def anthropic_supports_temperature(model: str) -> bool:
    """Whether the Anthropic model accepts a ``temperature`` sampling parameter.

    Unknown / older model ids default to True. Used by the DB migration that backfills
    ``extra_params``, not at request time."""
    m = (model or "").lower()
    return not any(needle in m for needle in _ANTHROPIC_TEMPERATURE_UNSUPPORTED)
