"""The voice a video is read in: the one picked in the video dialog.

`RenderOptions.voice` used to be accepted and ignored — every render was read in
the account's voice. Now the worker passes it on when it is a voice of the
engine doing the reading, and the speech core honours a Flux voice id for
Deepgram the way it already honoured a voice name for fal.ai. Providers are
faked; nothing here calls out.
"""

import asyncio
import json

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.models import UserSetting
from app.routers import settings
from app.video import worker

USER = "u1"


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _set(session, key, value):
    session.add(UserSetting(user_id=USER, key=key, value=json.dumps(value)))
    session.commit()


@pytest.fixture
def account(session):
    """An account whose read-aloud voice is "Rex" on fal.ai and Haley on Deepgram."""
    _set(session, "tts_model", "Rex")
    _set(session, settings._SPEECH_CONFIG, {"deepgram_tts_model": "flux-haley-en"})
    return session


FAL_VOICE = settings.FAL_TTS_VOICES[1]


@pytest.mark.parametrize("provider, chosen, expected", [
    ("deepgram", "flux-kit-en", "flux-kit-en"),   # a Flux voice, read by Deepgram
    ("fal", FAL_VOICE, FAL_VOICE),                # a voice of the fal.ai model
    # A choice saved under the other engine, or none at all: the account's.
    ("deepgram", FAL_VOICE, "Rex"),
    ("fal", "flux-kit-en", "Rex"),
    ("fal", "Nobody", "Rex"),
    ("fal", None, "Rex"),
    ("deepgram", None, "Rex"),
])
def test_the_dialogs_voice_is_used_when_it_belongs_to_the_engine(account, provider, chosen, expected):
    assert worker._render_voice(account, USER, provider, chosen) == expected


def _fake_providers(monkeypatch):
    heard = []

    async def deepgram(api_key, voice, text, expressivity, speed):
        heard.append(("deepgram", voice))
        return b"mp3"

    async def fal(session, user_id, api_key, text, voice_hint=None):
        heard.append(("fal", voice_hint))
        return b"mp3", "audio/mpeg"

    monkeypatch.setattr(settings, "_deepgram_tts", deepgram)
    monkeypatch.setattr(settings, "_fal_tts", fal)
    monkeypatch.setattr(settings, "load_deepgram_api_key", lambda s, u: "dg-key")
    monkeypatch.setattr(settings, "load_fal_api_key", lambda s, u: "fal-key")
    monkeypatch.setattr(settings, "_tts_cache_get", lambda key: None)
    monkeypatch.setattr(settings, "_tts_cache_put", lambda key, data: None)
    monkeypatch.setattr(settings, "_record_usage", lambda *a, **k: None)
    return heard


@pytest.mark.parametrize("voice, expected", [
    ("flux-kit-en", "flux-kit-en"),      # named by the video dialog
    ("Rex", "flux-haley-en"),            # read-aloud's fal.ai name: the account's Flux voice
    (None, "flux-haley-en"),
])
def test_deepgram_reads_a_named_flux_voice_and_otherwise_the_accounts(account, monkeypatch, voice, expected):
    heard = _fake_providers(monkeypatch)
    asyncio.run(settings.synthesize_tts_bytes(account, USER, "Hello.", voice=voice,
                                              provider_override="deepgram"))
    assert heard == [("deepgram", expected)]


@pytest.mark.parametrize("tts_provider, chosen, expected", [
    ("auto", "flux-kit-en", ("deepgram", "flux-kit-en")),   # auto + a Deepgram key: Deepgram
    ("auto", None, ("deepgram", "flux-haley-en")),
    ("fal", FAL_VOICE, ("fal", FAL_VOICE)),
    ("fal", "flux-kit-en", ("fal", "Rex")),                 # saved under Deepgram: the account's
])
def test_a_render_is_read_in_the_dialogs_voice_on_the_engine_it_pins(
        session, monkeypatch, tts_provider, chosen, expected):
    _set(session, "tts_model", "Rex")
    _set(session, settings._SPEECH_CONFIG,
         {"tts_provider": tts_provider, "deepgram_tts_model": "flux-haley-en"})
    heard = _fake_providers(monkeypatch)
    monkeypatch.setattr(worker, "engine", session.get_bind())

    worker._tts_caller(USER, chosen)("A chunk of narration.")
    assert heard == [expected]
