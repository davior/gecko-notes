"""List-price estimates for LLM token costs (USD per 1,000,000 tokens).

These are best-effort published list prices, used only to *estimate* the cost of
LLM (`kind="ai"`) usage in the usage dashboard. They are NOT authoritative billing
figures — providers change prices and offer volume/cache discounts this table does
not model, so any cost derived here is flagged `cost_estimated=True` in the UI.

fal.ai image and speech costs are billed exactly (derived from provider response
headers) and never use this table. Ollama runs locally and is free.
"""

from typing import List, Optional, Tuple

# provider_type -> [(model-id substring, input_$/1M, output_$/1M), ...].
# Checked in order; the first substring contained in the model id wins, so list
# the more specific ids before their shorter prefixes. Each family ends with a
# catch-all so an unrecognised model in a known family still gets an estimate.
_PRICES: dict[str, List[Tuple[str, float, float]]] = {
    "anthropic": [
        ("claude-opus-4-8", 5.0, 25.0),
        ("claude-opus-4-7", 5.0, 25.0),
        ("claude-opus-4-6", 5.0, 25.0),
        ("claude-opus-4-5", 5.0, 25.0),
        ("claude-opus-4-1", 15.0, 75.0),
        ("claude-opus-4", 15.0, 75.0),
        ("claude-opus", 15.0, 75.0),
        ("claude-haiku-4-5", 1.0, 5.0),
        ("claude-3-5-haiku", 0.80, 4.0),
        ("claude-3-haiku", 0.25, 1.25),
        ("claude-haiku", 1.0, 5.0),
        ("claude-3-7-sonnet", 3.0, 15.0),
        ("claude-3-5-sonnet", 3.0, 15.0),
        ("claude-sonnet", 3.0, 15.0),
        ("claude", 3.0, 15.0),  # unknown Claude model — assume Sonnet-tier
    ],
    "openai": [
        ("gpt-4o-mini", 0.15, 0.60),
        ("gpt-4o", 2.50, 10.0),
        ("gpt-4.1-nano", 0.10, 0.40),
        ("gpt-4.1-mini", 0.40, 1.60),
        ("gpt-4.1", 2.0, 8.0),
        ("gpt-4-turbo", 10.0, 30.0),
        ("gpt-4", 30.0, 60.0),
        ("gpt-3.5", 0.50, 1.50),
        ("gpt-5-mini", 0.25, 2.0),
        ("gpt-5", 1.25, 10.0),
        ("o4-mini", 1.10, 4.40),
        ("o3-mini", 1.10, 4.40),
        ("o3", 2.0, 8.0),
        ("o1-mini", 1.10, 4.40),
        ("o1", 15.0, 60.0),
        ("gpt", 2.50, 10.0),  # unknown GPT model — assume 4o-tier
    ],
    # DeepSeek's OpenAI-compatible API. Standard (cache-miss) list prices; the
    # dashboard flags these as estimates and does not model DeepSeek's cache-hit
    # discount. List the specific model ids before the chat-tier catch-all.
    "deepseek": [
        ("deepseek-reasoner", 0.55, 2.19),
        ("deepseek-chat", 0.27, 1.10),
        ("deepseek", 0.27, 1.10),  # unknown DeepSeek model — assume chat-tier
    ],
}


def cost_for(
    provider_type: Optional[str],
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> Optional[Tuple[float, str]]:
    """Estimate the (cost_usd, currency) of an LLM call from list prices.

    Returns None when no estimate is possible (an OpenAI-compatible `custom`
    endpoint, or a model family not in the table) so no misleading cost is stored.
    Ollama is local and free, so it returns (0.0, "USD")."""
    ptype = (provider_type or "").lower()
    if ptype == "ollama":
        return (0.0, "USD")
    table = _PRICES.get(ptype)
    if not table:
        return None
    m = (model or "").lower()
    for needle, in_price, out_price in table:
        if needle in m:
            cost = (input_tokens / 1_000_000.0) * in_price + (output_tokens / 1_000_000.0) * out_price
            return (round(cost, 6), "USD")
    return None
