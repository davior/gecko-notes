"""Watching a reply the browser is not receiving.

The Anthropic blocking proxy has always streamed internally; the other two posted once
and waited. Planning now runs on a worker, and a four-minute planning call with no
sign of life is the thing the whole change was meant to fix — so all three protocols
grew one shape, ("delta", text) then ("final", <the dict the blocking path returns>),
and the SSE routes and the worker drain the same generator.

That "same dict" is the load-bearing claim: `extract_text` and the stall recovery read
`stop_reason` / `finish_reason` / `done_reason` and the message body out of it, and a
reassembly that quietly dropped one would look like an empty reply rather than an
error. So the shape is what these pin, not the deltas.

No httpx mocking library is in the project, so upstream is a small fake client rather
than a new dependency.
"""

import asyncio
import json

import pytest

import app.routers.settings as settings
from app.routers.settings import _drain, _iter_ollama_events, _iter_openai_events


# ─── a fake upstream ─────────────────────────────────────────────────────────


class FakeResponse:
    def __init__(self, lines, status=200):
        self._lines = lines
        self.status_code = status
        self.is_success = 200 <= status < 300
        self.text = "" if self.is_success else "upstream said no"

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""


class FakeStream:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *exc):
        return False


class FakeClient:
    """Stands in for httpx.AsyncClient. Records what it was asked to send."""

    sent = None

    def __init__(self, lines, status=200):
        self._lines = lines
        self._status = status

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, **kwargs):
        FakeClient.sent = {"method": method, "url": url, **kwargs}
        return FakeStream(FakeResponse(self._lines, self._status))


@pytest.fixture
def upstream(monkeypatch):
    def install(lines, status=200):
        client = FakeClient(lines, status)
        monkeypatch.setattr(settings.httpx, "AsyncClient", client)
        return client

    return install


def sse(payload):
    return f"data: {json.dumps(payload)}"


def run(coro):
    return asyncio.run(coro)


# ─── OpenAI-compatible ───────────────────────────────────────────────────────


OPENAI_LINES = [
    sse({"choices": [{"delta": {"content": "Hello"}}]}),
    sse({"choices": [{"delta": {"content": " world"}}]}),
    sse({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
    sse({"usage": {"prompt_tokens": 11, "completion_tokens": 3}, "choices": []}),
    "data: [DONE]",
]


def test_an_openai_stream_reassembles_the_blocking_shape(upstream):
    upstream(OPENAI_LINES)
    final = run(_drain(
        _iter_openai_events("http://x/v1/chat/completions", headers={}, json_body={}, read_timeout=1.0),
        None,
    ))

    assert final["choices"][0]["message"] == {"role": "assistant", "content": "Hello world"}
    assert final["choices"][0]["finish_reason"] == "stop"
    assert final["usage"] == {"prompt_tokens": 11, "completion_tokens": 3}


def test_usage_is_asked_for_or_a_streamed_completion_reports_none(upstream):
    # Without stream_options.include_usage an OpenAI stream carries no token counts at
    # all, and every worker call would cost nothing on the usage dashboard.
    client = upstream(OPENAI_LINES)
    run(_drain(_iter_openai_events("http://x", headers={}, json_body={"model": "m"}, read_timeout=1.0), None))

    sent = client.sent["json"]
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}
    assert sent["model"] == "m"


def test_the_deltas_arrive_in_order(upstream):
    upstream(OPENAI_LINES)
    seen = []
    run(_drain(
        _iter_openai_events("http://x", headers={}, json_body={}, read_timeout=1.0),
        seen.append,
    ))
    assert seen == ["Hello", " world"]


def test_unparseable_lines_are_skipped_rather_than_fatal(upstream):
    upstream(["", "data:", "data: {not json", ": a comment", *OPENAI_LINES])
    final = run(_drain(_iter_openai_events("http://x", headers={}, json_body={}, read_timeout=1.0), None))
    assert final["choices"][0]["message"]["content"] == "Hello world"


def test_an_upstream_error_is_raised_not_swallowed(upstream):
    from fastapi import HTTPException

    upstream([], status=429)
    with pytest.raises(HTTPException) as caught:
        run(_drain(_iter_openai_events("http://x", headers={}, json_body={}, read_timeout=1.0), None))
    assert caught.value.status_code == 429


# ─── Ollama ──────────────────────────────────────────────────────────────────


OLLAMA_LINES = [
    json.dumps({"message": {"content": "Hel"}}),
    json.dumps({"message": {"content": "lo"}}),
    json.dumps({"done": True, "done_reason": "stop", "prompt_eval_count": 7, "eval_count": 2}),
]


def test_an_ollama_stream_reassembles_the_blocking_shape(upstream):
    # Ollama sends newline-delimited JSON, not SSE.
    upstream(OLLAMA_LINES)
    final = run(_drain(_iter_ollama_events("http://x/api/chat", json_body={}, read_timeout=1.0), None))

    assert final["message"] == {"role": "assistant", "content": "Hello"}
    assert final["done_reason"] == "stop"
    assert final["prompt_eval_count"] == 7
    assert final["eval_count"] == 2


def test_the_ollama_body_asks_to_stream(upstream):
    client = upstream(OLLAMA_LINES)
    run(_drain(_iter_ollama_events("http://x", json_body={"stream": False}, read_timeout=1.0), None))
    assert client.sent["json"]["stream"] is True


# ─── the sink ────────────────────────────────────────────────────────────────


def test_a_sink_that_raises_does_not_take_the_generation_down(upstream):
    # The sink writes to a database row. A preview that stops updating is a nuisance;
    # a generation killed by one is minutes of work thrown away.
    upstream(OPENAI_LINES)

    def explode(_text):
        raise RuntimeError("the row is gone")

    final = run(_drain(
        _iter_openai_events("http://x", headers={}, json_body={}, read_timeout=1.0),
        explode,
    ))
    assert final["choices"][0]["message"]["content"] == "Hello world"


def test_no_sink_means_no_watching(upstream):
    upstream(OPENAI_LINES)
    final = run(_drain(_iter_openai_events("http://x", headers={}, json_body={}, read_timeout=1.0), None))
    assert final["choices"][0]["message"]["content"] == "Hello world"
