"""Per-model image parameters — the free-text JSON a user attaches to a fal model.

The merge is what keeps a user's JSON from fighting the size dropdown (two size fields
in one request 422s on most endpoints) or from breaking the one-image-per-request
assumption the cost accounting and download path are built on. The settings round trip
checks the other half: the params persist per model, and bad ones are refused rather
than stored.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine

from app.auth import encrypt_api_key
from app.models import ModelCatalogEntry
from app.routers import images
from app.routers.settings import (
    _FAL_CONFIG,
    _FAL_KEY,
    ImageSettingsUpdate,
    _upsert_user_setting,
    build_fal_image_body,
    get_image_settings,
    load_fal_config,
    update_image_settings,
)

FLUX_2_PRO = "fal-ai/flux-2-pro"
NANO_BANANA = "fal-ai/nano-banana-2"
USER = "user-1"


# ─── build_fal_image_body ────────────────────────────────────────────────────


def test_no_params_matches_the_plain_preset_body():
    assert build_fal_image_body(FLUX_2_PRO, "a gecko", "landscape_16_9") == {
        "prompt": "a gecko", "num_images": 1, "image_size": "landscape_16_9",
    }
    assert build_fal_image_body(FLUX_2_PRO, "a gecko", "landscape_16_9", {}) == build_fal_image_body(
        FLUX_2_PRO, "a gecko", "landscape_16_9", None
    )


@pytest.mark.parametrize("model, expected", [
    ("fal-ai/gpt-image-1.5", {"image_size": "1536x1024"}),
    ("fal-ai/flux-pro/v1.1-ultra", {"aspect_ratio": "16:9"}),
    ("fal-ai/krea/v2/large/text-to-image", {"aspect_ratio": "16:9"}),
    (NANO_BANANA, {"aspect_ratio": "16:9"}),
])
def test_existing_size_dialects_are_untouched_without_params(model, expected):
    body = build_fal_image_body(model, "p", "landscape_16_9")
    assert body == {"prompt": "p", "num_images": 1, **expected}


def test_image_size_object_replaces_the_computed_size():
    body = build_fal_image_body(
        FLUX_2_PRO, "p", "landscape_16_9", {"image_size": {"width": 1600, "height": 900}}
    )
    assert body["image_size"] == {"width": 1600, "height": 900}


def test_aspect_ratio_override_drops_the_computed_image_size():
    body = build_fal_image_body(FLUX_2_PRO, "p", "landscape_16_9", {"aspect_ratio": "21:9"})
    assert "image_size" not in body
    assert body["aspect_ratio"] == "21:9"


def test_image_size_override_drops_the_computed_aspect_ratio():
    body = build_fal_image_body(NANO_BANANA, "p", "landscape_16_9", {"image_size": "auto"})
    assert "aspect_ratio" not in body
    assert body["image_size"] == "auto"


def test_non_size_params_merge_alongside_the_computed_size():
    # `resolution` is a separate dimension from aspect_ratio on nano-banana, so the
    # dropdown's aspect ratio must still go out.
    body = build_fal_image_body(NANO_BANANA, "p", "landscape_16_9", {"resolution": "2K", "seed": 7})
    assert body == {
        "prompt": "p", "num_images": 1, "aspect_ratio": "16:9", "resolution": "2K", "seed": 7,
    }


@pytest.mark.parametrize("key, value", [
    ("prompt", "hijacked"),
    ("num_images", 4),
    ("sync_mode", True),
])
def test_protected_keys_cannot_be_overridden(key, value):
    body = build_fal_image_body(FLUX_2_PRO, "real prompt", "square", {key: value})
    assert body["prompt"] == "real prompt"
    assert body["num_images"] == 1
    assert "sync_mode" not in body


def test_build_does_not_mutate_the_stored_params():
    params = {"image_size": {"width": 1024, "height": 1024}, "prompt": "x"}
    build_fal_image_body(FLUX_2_PRO, "p", "square", params)
    assert params == {"image_size": {"width": 1024, "height": 1024}, "prompt": "x"}


# ─── settings round trip ─────────────────────────────────────────────────────


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(ModelCatalogEntry(id="m1", kind="image", model_id=FLUX_2_PRO, label="FLUX.2 [pro]"))
        s.add(ModelCatalogEntry(id="m2", kind="image", model_id=NANO_BANANA, label="Nano Banana 2"))
        s.commit()
        yield s


@pytest.fixture
def request_():
    return SimpleNamespace(state=SimpleNamespace(user_id=USER))


def save(session, request_, **fields):
    return update_image_settings(ImageSettingsUpdate(**fields), request_, session)


def test_params_persist_per_model(session, request_):
    px = {"image_size": {"width": 1600, "height": 900}}
    out = save(session, request_, model_params={FLUX_2_PRO: px, NANO_BANANA: {"resolution": "2K"}})
    assert out["model_params"] == {FLUX_2_PRO: px, NANO_BANANA: {"resolution": "2K"}}
    # A fresh read goes back through the stored blob, not the update's return value.
    assert load_fal_config(session, USER)["model_params"][FLUX_2_PRO] == px


def test_patch_leaves_other_models_alone(session, request_):
    save(session, request_, model_params={FLUX_2_PRO: {"seed": 1}, NANO_BANANA: {"resolution": "2K"}})
    out = save(session, request_, model_params={FLUX_2_PRO: {"seed": 2}})
    assert out["model_params"] == {FLUX_2_PRO: {"seed": 2}, NANO_BANANA: {"resolution": "2K"}}


@pytest.mark.parametrize("empty", [None, {}])
def test_null_or_empty_clears_a_models_params(session, request_, empty):
    save(session, request_, model_params={FLUX_2_PRO: {"seed": 1}, NANO_BANANA: {"resolution": "2K"}})
    out = save(session, request_, model_params={FLUX_2_PRO: empty})
    assert out["model_params"] == {NANO_BANANA: {"resolution": "2K"}}


def test_saving_other_settings_keeps_params(session, request_):
    # The PUT rewrites the whole blob, so a dropped key here would silently lose params
    # every time the user changes the default model.
    save(session, request_, model_params={FLUX_2_PRO: {"seed": 1}})
    out = save(session, request_, default_model=NANO_BANANA, image_size="square")
    assert out["model_params"] == {FLUX_2_PRO: {"seed": 1}}


def test_custom_model_can_carry_params_in_the_same_save(session, request_):
    out = save(
        session, request_,
        custom_models=["fal-ai/some-new-model"],
        model_params={"fal-ai/some-new-model": {"num_inference_steps": 20}},
    )
    assert out["model_params"] == {"fal-ai/some-new-model": {"num_inference_steps": 20}}


def test_removing_a_custom_model_can_clear_its_params_in_the_same_save(session, request_):
    save(session, request_, custom_models=["fal-ai/x"], model_params={"fal-ai/x": {"seed": 1}})
    out = save(session, request_, custom_models=[], model_params={"fal-ai/x": None})
    assert out["custom_models"] == []
    assert out["model_params"] == {}


@pytest.mark.parametrize("key", ["prompt", "num_images", "sync_mode"])
def test_protected_key_is_rejected_with_a_message(session, request_, key):
    with pytest.raises(HTTPException) as exc:
        save(session, request_, model_params={FLUX_2_PRO: {key: 1}})
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "invalid_model_params"
    assert key in exc.value.detail["message"]
    assert load_fal_config(session, USER)["model_params"] == {}


def test_unknown_model_is_rejected(session, request_):
    with pytest.raises(HTTPException) as exc:
        save(session, request_, model_params={"fal-ai/not-configured": {"seed": 1}})
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "invalid_model_params"


def test_oversized_params_are_rejected(session, request_):
    with pytest.raises(HTTPException) as exc:
        save(session, request_, model_params={FLUX_2_PRO: {"blob": "x" * 5000}})
    assert exc.value.status_code == 400
    assert "too large" in exc.value.detail["message"]


def test_a_rejected_save_stores_nothing_for_the_other_models_in_it(session, request_):
    with pytest.raises(HTTPException):
        save(session, request_, model_params={NANO_BANANA: {"seed": 1}, FLUX_2_PRO: {"prompt": "x"}})
    assert load_fal_config(session, USER)["model_params"] == {}


def test_get_reports_the_reserved_keys_for_the_ui(session, request_):
    out = get_image_settings(request_, session)
    assert out["reserved_param_keys"] == ["num_images", "prompt", "sync_mode"]
    assert out["model_params"] == {}


def test_hand_edited_blob_is_normalised_on_load(session, request_):
    # A blob written through the generic settings API bypasses the validation above, so
    # load must still never hand a protected key or a non-object entry to the request.
    _upsert_user_setting(session, USER, _FAL_CONFIG, json.dumps({
        "model_params": {
            FLUX_2_PRO: {"prompt": "x", "seed": 3},
            NANO_BANANA: "not-an-object",
            "fal-ai/flux-pro/kontext": {"seed": 5},   # a renamed legacy id
        },
    }))
    session.commit()
    params = load_fal_config(session, USER)["model_params"]
    assert params == {
        FLUX_2_PRO: {"seed": 3},
        "fal-ai/flux-pro/kontext/text-to-image": {"seed": 5},
    }


# ─── wiring into the generate call ───────────────────────────────────────────


class _Captured(Exception):
    """Raised by the stub in place of fal so the call stops before any download."""

    def __init__(self, url, json_body):
        self.url = url
        self.json_body = json_body


def _body_sent_for(session, **generate_kwargs):
    async def stub(url, *, json_body, **_):
        raise _Captured(url, json_body)

    original = images._post_upstream
    images._post_upstream = stub
    try:
        with pytest.raises(_Captured) as sent:
            asyncio.run(images.generate_image_for_user(session, USER, "a gecko", **generate_kwargs))
    finally:
        images._post_upstream = original
    return sent.value


def test_generate_sends_the_saved_params_for_that_model(session, request_):
    _upsert_user_setting(session, USER, _FAL_KEY, json.dumps(encrypt_api_key("test-key")))
    session.commit()
    px = {"image_size": {"width": 1600, "height": 900}, "seed": 11}
    save(session, request_, model_params={FLUX_2_PRO: px})

    sent = _body_sent_for(session, model=FLUX_2_PRO, image_size="square")

    assert sent.url == f"https://fal.run/{FLUX_2_PRO}"
    assert sent.json_body == {"prompt": "a gecko", "num_images": 1, **px}


def test_generate_leaves_other_models_on_the_preset_path(session, request_):
    _upsert_user_setting(session, USER, _FAL_KEY, json.dumps(encrypt_api_key("test-key")))
    session.commit()
    save(session, request_, model_params={FLUX_2_PRO: {"seed": 11}})

    sent = _body_sent_for(session, model=NANO_BANANA, image_size="landscape_16_9")

    assert sent.json_body == {"prompt": "a gecko", "num_images": 1, "aspect_ratio": "16:9"}
