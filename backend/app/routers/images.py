"""fal.ai image generation.

A thin, blocking proxy: it takes a prompt + model, calls the fal.ai synchronous
endpoint (https://fal.run/<model>) with the user's stored key, downloads the
resulting image, and saves it into the user's media dir so it survives (fal's
returned URLs are ephemeral). Returns a stable /media/... URL the frontend drops
into a BlockNote `image` block. Usage is recorded as a `kind="image"` UsageEvent.
"""

import logging
import os
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.routers.media import get_user_media_dir
from app.routers.settings import (
    DEFAULT_IMAGE_SIZE,
    _post_upstream,
    _record_usage,
    _require_safe_external_url,
    allowed_fal_models,
    get_cached_fal_price,
    load_fal_api_key,
    load_fal_config,
)

router = APIRouter()

logger = logging.getLogger(__name__)

# fal FLUX generation is typically 5–30s; allow generous headroom for [dev]/[pro].
_GENERATE_TIMEOUT = 180.0
# Cap the downloaded image so a hostile/broken upstream can't fill the disk.
_MAX_IMAGE_BYTES = 25 * 1024 * 1024

_CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
}


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


class ImageGenerateRequest(BaseModel):
    prompt: str
    model: Optional[str] = None
    image_size: Optional[str] = None


class ImageGenerateResponse(BaseModel):
    url: str
    model: str
    prompt: str
    width: Optional[int] = None
    height: Optional[int] = None
    cost: Optional[float] = None      # actual fal charge, when the price is known
    currency: Optional[str] = None


@router.post("/generate", response_model=ImageGenerateResponse)
async def generate_image(
    payload: ImageGenerateRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)

    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail={"code": "empty_prompt", "message": "A prompt is required"})

    api_key = load_fal_api_key(session, user_id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_fal_key", "message": "fal.ai API key is not configured"},
        )

    cfg = load_fal_config(session, user_id)
    model = (payload.model or cfg["default_model"]).strip()
    if model not in allowed_fal_models(cfg):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_model", "message": f"Model '{model}' is not in the configured model list"},
        )
    image_size = payload.image_size or cfg["image_size"] or DEFAULT_IMAGE_SIZE

    # 1) Ask fal to generate the image (blocking synchronous endpoint).
    resp = await _post_upstream(
        f"https://fal.run/{model}",
        headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
        json_body={"prompt": prompt, "image_size": image_size, "num_images": 1},
        timeout=_GENERATE_TIMEOUT,
        provider_label="fal.ai",
    )
    if not resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "fal_error", "message": resp.text[:500]})

    try:
        body = resp.json()
        images = body.get("images") or []
        first = images[0]
        image_url = first["url"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail={"code": "fal_parse_error", "message": "Unexpected fal.ai response"})

    width = first.get("width") if isinstance(first, dict) else None
    height = first.get("height") if isinstance(first, dict) else None

    # 2) Download the generated image and persist it into the user's media dir.
    _require_safe_external_url(image_url)
    try:
        async with httpx.AsyncClient(timeout=120.0) as http:
            img_resp = await http.get(image_url)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail={"code": "download_failed", "message": f"Could not download image: {type(e).__name__}"})
    if not img_resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "download_failed", "message": f"Image download returned HTTP {img_resp.status_code}"})

    data = img_resp.content
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=502, detail={"code": "image_too_large", "message": "Generated image exceeds the size limit"})

    content_type = (first.get("content_type") if isinstance(first, dict) else None) or img_resp.headers.get("content-type", "")
    ext = _CONTENT_TYPE_EXT.get(content_type.split(";")[0].strip().lower(), ".png")

    user_dir = get_user_media_dir(user_id)
    filename = f"{uuid.uuid4()}{ext}"
    with open(os.path.join(user_dir, filename), "wb") as f:
        f.write(data)

    # 3) Attribute the actual cost: fal returns the request id and billed quantity as
    #    response headers; multiplied by the endpoint's cached unit price this gives the
    #    exact charge for this image (null when the price isn't cached yet).
    request_id = resp.headers.get("x-fal-request-id")
    billable_raw = resp.headers.get("x-fal-billable-units")
    cost: Optional[float] = None
    currency: Optional[str] = None
    price = get_cached_fal_price(session, user_id, model)
    if price and billable_raw is not None:
        try:
            cost = round(float(billable_raw) * float(price["unit_price"]), 6)
            currency = price.get("currency")
        except (ValueError, TypeError, KeyError):
            cost = None

    # 4) Record usage (surfaced in Settings → Usage as kind "image").
    _record_usage(session, user_id, "image", model, 1, "images", external_ref=request_id, cost=cost, currency=currency)

    return ImageGenerateResponse(
        url=f"/media/{user_id}/{filename}",
        model=model,
        prompt=prompt,
        width=width,
        height=height,
        cost=cost,
        currency=currency,
    )
