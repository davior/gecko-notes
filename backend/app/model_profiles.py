"""Per-model request-parameter profiles for the LLM proxies.

Some request parameters are model-dependent: a value that one model accepts,
a newer model may reject outright. The Anthropic Messages API removed the
`temperature` sampling parameter on its newer model families — sending it now
returns a 400 (`invalid_request_error: "temperature is deprecated for this
model."`). Older families still accept it, as do the OpenAI-compatible
providers.

Rather than hardcode assumptions at each call site, this module answers "does
this model support parameter X?" from the model id, so switching a provider to
a newer model "just works" without the caller needing to track the schema.

Only parameters whose *presence* depends on the model belong here. Values that
are always sent but merely have a different ceiling per model (e.g.
`max_tokens`) are intentionally out of scope.

Matching mirrors `pricing.py`: a lowercased substring test against the model
id, so a dated snapshot (`...-20260101`) matches the same family.
"""

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
    """Whether the Anthropic model accepts a `temperature` sampling parameter.

    Unknown / older model ids default to True so current behaviour is preserved
    for everything except the families known to reject it."""
    m = (model or "").lower()
    return not any(needle in m for needle in _ANTHROPIC_TEMPERATURE_UNSUPPORTED)
