"""Tests for the assistant's web search backends.

Pure functions only — the HTML/JSON normalisers and the pre-flight validation in
`search_web`, which all run before any socket is opened. No database, no network.

The DuckDuckGo cases carry the most weight: it is the keyless default, so it is the
backend most installs will actually use, and it is the only one whose results are
scraped rather than handed over as JSON. Its markup wraps every hit in a redirect
(`/l/?uddg=…`), interleaves sponsored rows with real ones, and nests the snippet
under the same row as the title.
"""

import asyncio

import pytest

from app.web_search import (
    DEFAULT_PROVIDER,
    MAX_RESULTS,
    MAX_SNIPPET_CHARS,
    PROVIDERS,
    SearchError,
    _clamp_count,
    _collect,
    _parse_duckduckgo_html,
    _result,
    _unwrap_duckduckgo_link,
    search_web,
)


def _ddg_row(title: str, target: str, snippet: str, ad: bool = False) -> str:
    """One results row in DuckDuckGo's no-JS markup, links wrapped as the site wraps them."""
    href = f"//duckduckgo.com/l/?uddg={target}&amp;rut=6f1c"
    classes = "result results_links results_links_deep web-result"
    if ad:
        classes += " result--ad result--ad--small"
    return f"""
    <div class="{classes}">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="{href}">{title}</a>
        </h2>
        <a class="result__snippet" href="{href}">{snippet}</a>
      </div>
    </div>
    """


def _ddg_page(*rows: str) -> str:
    return f'<html><body><div class="results">{"".join(rows)}</div></body></html>'


# ─── DuckDuckGo scraping ──────────────────────────────────────────────────────


def test_duckduckgo_unwraps_redirect_links():
    """Every hit arrives as a /l/?uddg=<encoded> redirect; the model must get the target."""
    page = _ddg_page(
        _ddg_row(
            "Gecko facts",
            "https%3A%2F%2Fexample.com%2Fgeckos%3Fpage%3D2",
            "Everything about <b>geckos</b>.",
        )
    )

    results = _parse_duckduckgo_html(page, 5)

    assert len(results) == 1
    assert results[0].url == "https://example.com/geckos?page=2"
    assert results[0].title == "Gecko facts"
    # Tags are stripped, whitespace collapsed.
    assert results[0].snippet == "Everything about geckos."


def test_duckduckgo_skips_sponsored_rows():
    page = _ddg_page(
        _ddg_row("Buy geckos now", "https%3A%2F%2Fads.example.com", "Sponsored.", ad=True),
        _ddg_row("Gecko care", "https%3A%2F%2Fexample.org%2Fcare", "How to care for one."),
    )

    results = _parse_duckduckgo_html(page, 5)

    assert [r.url for r in results] == ["https://example.org/care"]


def test_duckduckgo_dedupes_and_honours_the_count():
    page = _ddg_page(
        _ddg_row("First", "https%3A%2F%2Fexample.com%2Fa", "A."),
        _ddg_row("First again", "https%3A%2F%2Fexample.com%2Fa", "The same URL."),
        _ddg_row("Second", "https%3A%2F%2Fexample.com%2Fb", "B."),
        _ddg_row("Third", "https%3A%2F%2Fexample.com%2Fc", "C."),
    )

    assert [r.url for r in _parse_duckduckgo_html(page, 5)] == [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
    ]
    assert len(_parse_duckduckgo_html(page, 2)) == 2


def test_duckduckgo_reads_an_unwrapped_link():
    """Not every row is redirect-wrapped (and the wrapper has changed before)."""
    page = _ddg_page("").replace(
        "</div></body>",
        '<div class="result web-result"><a class="result__a" href="https://example.net/direct">Direct</a>'
        '<div class="result__snippet">Straight through.</div></div></div></body>',
    )

    results = _parse_duckduckgo_html(page, 5)

    assert [(r.url, r.snippet) for r in results] == [("https://example.net/direct", "Straight through.")]


def test_duckduckgo_empty_or_broken_page_yields_nothing():
    """A throttled/anomaly page parses fine but has no result rows — the caller turns
    that into an actionable error rather than an empty answer."""
    assert _parse_duckduckgo_html("<html><body><p>No results.</p></body></html>", 5) == []
    assert _parse_duckduckgo_html("", 5) == []


def test_unwrap_ignores_a_plain_url():
    assert _unwrap_duckduckgo_link("https://example.com/x") == "https://example.com/x"
    assert _unwrap_duckduckgo_link("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example") == "https://a.example"


# ─── JSON backends ────────────────────────────────────────────────────────────


def test_collect_normalises_brave_results():
    raw = [
        {"title": "Brave hit", "url": "https://example.com/1", "description": "A  snippet", "page_age": "2026-01-02"},
        {"title": "No URL", "description": "dropped"},
    ]

    results = _collect(raw, 5, title="title", url="url", snippet="description", published="page_age")

    assert len(results) == 1
    assert results[0].as_dict() == {
        "title": "Brave hit",
        "url": "https://example.com/1",
        "snippet": "A snippet",
        "published": "2026-01-02",
    }


def test_collect_normalises_tavily_results():
    raw = [{"title": "T", "url": "https://example.com/t", "content": "An extracted passage.", "score": 0.9}]

    results = _collect(raw, 5, title="title", url="url", snippet="content", published="published_date")

    assert results[0].snippet == "An extracted passage."
    assert results[0].published is None  # absent → omitted, not "None"
    assert "published" not in results[0].as_dict()


def test_collect_survives_a_garbage_payload():
    assert _collect(None, 5, title="t", url="u", snippet="s", published="p") == []
    assert _collect(["not a dict", 7], 5, title="t", url="u", snippet="s", published="p") == []


def test_non_http_urls_are_dropped():
    assert _result("Bad", "javascript:alert(1)", "") is None
    assert _result("Bad", "/relative/path", "") is None
    assert _result("Good", "http://example.com", "") is not None


def test_long_snippets_are_truncated():
    hit = _result("T", "https://example.com", "x" * (MAX_SNIPPET_CHARS + 500))

    assert hit is not None
    assert len(hit.snippet) == MAX_SNIPPET_CHARS
    assert hit.snippet.endswith("…")


def test_result_count_is_clamped():
    assert _clamp_count(None) == 5
    assert _clamp_count(0) == 5
    assert _clamp_count(3) == 3
    assert _clamp_count(999) == MAX_RESULTS
    assert _clamp_count(-4) == 1


# ─── Pre-flight validation (no network reached) ───────────────────────────────


def _error(**kwargs) -> SearchError:
    with pytest.raises(SearchError) as excinfo:
        asyncio.run(search_web(**kwargs))
    return excinfo.value


def test_unknown_provider_is_rejected():
    assert _error(provider="bing", query="geckos").code == "unknown_provider"


def test_empty_query_is_rejected():
    assert _error(provider=DEFAULT_PROVIDER, query="   ").code == "empty_query"


def test_a_keyed_backend_without_a_key_is_reported_as_unconfigured():
    for provider in ("brave", "tavily"):
        error = _error(provider=provider, query="geckos")
        assert error.code == "search_unconfigured"
        assert error.status_code == 400
        assert PROVIDERS[provider].label in error.message


def test_searxng_without_an_instance_url_is_reported_as_unconfigured():
    error = _error(provider="searxng", query="geckos", api_key="irrelevant")

    assert error.code == "search_unconfigured"
    assert "instance URL" in error.message


def test_the_default_backend_needs_no_configuration():
    """The point of shipping DuckDuckGo as the default: search works before any signup."""
    spec = PROVIDERS[DEFAULT_PROVIDER]

    assert not spec.needs_api_key
    assert not spec.needs_base_url
