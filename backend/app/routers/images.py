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
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.routers.media import get_user_media_dir
from app.thumbnails import generate_thumbnail
from app.routers.settings import (
    DEFAULT_IMAGE_SIZE,
    FAL_IMAGE_SIZES,
    FAL_MODEL_ID_RENAMES,
    _post_upstream,
    _record_usage,
    _require_safe_external_url,
    allowed_fal_models,
    compute_fal_cost,
    load_fal_api_key,
    load_fal_config,
    resolve_fal_size_params,
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
    background_tasks: BackgroundTasks,
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
    model = FAL_MODEL_ID_RENAMES.get(model, model)
    if model not in allowed_fal_models(session, cfg):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_model", "message": f"Model '{model}' is not in the configured model list"},
        )
    image_size = payload.image_size or cfg["image_size"] or DEFAULT_IMAGE_SIZE
    if image_size not in FAL_IMAGE_SIZES:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_image_size", "message": f"image_size must be one of: {', '.join(FAL_IMAGE_SIZES)}"},
        )

    # 1) Ask fal to generate the image (blocking synchronous endpoint). The named
    #    size preset is translated per endpoint (image_size / aspect_ratio / WxH).
    resp = await _post_upstream(
        f"https://fal.run/{model}",
        headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
        json_body={"prompt": prompt, "num_images": 1, **resolve_fal_size_params(model, image_size)},
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
    file_path = os.path.join(user_dir, filename)
    with open(file_path, "wb") as f:
        f.write(data)

    background_tasks.add_task(generate_thumbnail, Path(file_path))

    # 3) Attribute the actual cost: fal returns the request id and billed quantity as
    #    response headers; multiplied by the endpoint's cached unit price this gives the
    #    exact charge for this image (null when the price isn't cached yet).
    cost, currency, request_id, cost_estimated = compute_fal_cost(session, user_id, model, resp)

    # 4) Record usage (surfaced in Settings → Usage as kind "image"). cost is the
    #    exact fal-billed amount (not an estimate), so cost_estimated stays False.
    _record_usage(
        session, user_id, "image", model, 1, "images",
        provider="fal.ai", external_ref=request_id, cost=cost, currency=currency,
        cost_estimated=cost_estimated,
    )

    return ImageGenerateResponse(
        url=f"/media/{user_id}/{filename}",
        model=model,
        prompt=prompt,
        width=width,
        height=height,
        cost=cost,
        currency=currency,
    )
