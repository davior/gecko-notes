"""Tests for routing a provider over the Anthropic Messages protocol.

The protocol is no longer only Anthropic's: DeepSeek publishes an Anthropic-compatible
endpoint, and that endpoint runs the same server-side web_search tool Claude does. So a
DeepSeek provider pointed at it searches the web natively — which is why these helpers
key off the PROTOCOL a provider speaks rather than its vendor name.

Pure functions only: which upstream a provider resolves to, which headers it is sent,
and which providers are allowed onto that path at all. No database, no network.
"""

import pytest

from app.models import AIProvider
from app.routers.settings import (
    _anthropic_base,
    _anthropic_headers,
    _requests_web_search,
    _speaks_anthropic,
)

WEB_SEARCH_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}


def provider(**kwargs) -> AIProvider:
    """An AIProvider with only the fields these helpers read."""
    defaults = dict(id="p1", name="p", provider_type="anthropic", api_key="secret-key", model="m")
    return AIProvider(**{**defaults, **kwargs})


# ─── Who speaks the protocol ──────────────────────────────────────────────────


def test_anthropic_always_speaks_it():
    assert _speaks_anthropic(provider(provider_type="anthropic")) is True
    assert _speaks_anthropic(provider(provider_type="anthropic", use_anthropic_api=False)) is True


def test_deepseek_speaks_it_only_when_opted_in():
    """The whole point of the flag: the same vendor, two protocols, one of which searches."""
    assert _speaks_anthropic(provider(provider_type="deepseek")) is False
    assert _speaks_anthropic(provider(provider_type="deepseek", use_anthropic_api=True)) is True


def test_a_custom_gateway_may_opt_in():
    assert _speaks_anthropic(
        provider(provider_type="custom", base_url="https://gateway.example.com", use_anthropic_api=True)
    ) is True


def test_ollama_never_speaks_it_even_if_the_flag_is_set():
    """Ollama is the one provider allowed a private base_url, so honouring the flag there
    would aim the Messages proxy at an internal host. The flag is ignored, not obeyed."""
    assert _speaks_anthropic(
        provider(provider_type="ollama", base_url="http://localhost:11434", use_anthropic_api=True)
    ) is False


def test_openai_does_not_speak_it():
    # OpenAI's own API is not Anthropic-compatible; nothing to point at.
    assert _speaks_anthropic(provider(provider_type="openai", use_anthropic_api=True)) is False


# ─── Which upstream it resolves to ────────────────────────────────────────────


def test_anthropic_goes_to_anthropic():
    assert _anthropic_base(provider(provider_type="anthropic")) == "https://api.anthropic.com"


def test_deepseek_goes_to_its_published_endpoint():
    assert _anthropic_base(
        provider(provider_type="deepseek", use_anthropic_api=True)
    ) == "https://api.deepseek.com/anthropic"


def test_deepseek_ignores_a_stored_base_url():
    """A DeepSeek row's base_url describes its OpenAI-compatible endpoint, so it must not
    be reused here — same reasoning as _openai_compat_base pinning the managed endpoint."""
    assert _anthropic_base(
        provider(provider_type="deepseek", base_url="https://api.deepseek.com", use_anthropic_api=True)
    ) == "https://api.deepseek.com/anthropic"


def test_a_custom_gateway_uses_its_own_url_without_a_trailing_slash():
    assert _anthropic_base(
        provider(provider_type="custom", base_url="https://gateway.example.com/", use_anthropic_api=True)
    ) == "https://gateway.example.com"


# ─── Headers ──────────────────────────────────────────────────────────────────


def test_anthropic_gets_the_beta_flags():
    headers = _anthropic_headers(provider(provider_type="anthropic"), uses_web_search=False)

    assert headers["x-api-key"] == "secret-key"
    assert headers["anthropic-version"] == "2023-06-01"
    assert headers["anthropic-beta"] == "pdfs-2024-09-25"
    # Anthropic reads x-api-key; no bearer token is added for it.
    assert "Authorization" not in headers


def test_the_web_search_beta_is_added_only_when_a_search_tool_is_sent():
    headers = _anthropic_headers(provider(provider_type="anthropic"), uses_web_search=True)

    assert headers["anthropic-beta"] == "pdfs-2024-09-25,web-search-2025-03-05"


def test_a_gateway_gets_both_auth_headers_and_no_betas():
    """Compatible gateways disagree on which auth header to read (DeepSeek documents
    x-api-key; Claude Code's own token path sends a bearer), and a beta flag names an
    Anthropic-internal feature a gateway could reject the whole request over."""
    headers = _anthropic_headers(
        provider(provider_type="deepseek", use_anthropic_api=True), uses_web_search=True
    )

    assert headers["x-api-key"] == "secret-key"
    assert headers["Authorization"] == "Bearer secret-key"
    assert "anthropic-beta" not in headers
    assert headers["anthropic-version"] == "2023-06-01"


# ─── Tool detection ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "tools, expected",
    [
        (None, False),
        ([], False),
        ([WEB_SEARCH_TOOL], True),
        # A future-dated server tool still reads as web search (the beta flag is a prefix match).
        ([{"type": "web_search_20260209", "name": "web_search"}], True),
        ([{"type": "code_execution_20250522", "name": "code"}], False),
        ([{"type": "code_execution_20250522"}, WEB_SEARCH_TOOL], True),
    ],
)
def test_web_search_tool_detection(tools, expected):
    assert _requests_web_search(tools) is expected
