"""The editor's window onto the person's GAM library.

A thin pass-through: GAM decides what the caller may see, and this only turns its
answers into Notes' shapes and its failures into sentences. Nothing here stores anything;
copying a file into a note is `routers/assets.py`'s, because the result is a note asset.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from app import gam_client
from app.gam_client import GamClient, GamError

router = APIRouter()


def _client(request: Request) -> GamClient:
    if not getattr(request.state, "user_id", None):
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return GamClient(gam_client.request_token(request))
    except GamError as exc:
        raise exc.http()


@router.get("/status")
def status():
    """Whether Notes can reach a GAM at all. The editor hides `/GAM`, the Assets panel's
    tab and the block's actions when it cannot, rather than offering them and failing."""
    return {"data": {"enabled": gam_client.enabled(),
                     "public_url": gam_client.public_url() or None}}


@router.get("/search")
def search(
    request: Request,
    q: str = Query(default="", max_length=500),
    asset_type: Optional[str] = Query(default=None),
    limit: int = Query(default=30, ge=1, le=100),
):
    if asset_type and asset_type not in gam_client.ASSET_TYPES:
        raise HTTPException(status_code=400, detail={
            "code": "bad_request", "message": f"Unknown asset type: {asset_type}"})
    try:
        with _client(request) as gam:
            result = gam.search(q, asset_type=asset_type, limit=limit)
    except GamError as exc:
        raise exc.http()
    for hit in result["data"]:
        hit["asset"] = gam_client.public(hit["asset"])
    return {"data": result["data"], "total": result["total"], "limit": limit, "offset": 0,
            "query": result["query"], "semantic": result["semantic"]}


@router.get("/assets/{asset_id}")
def get_asset(asset_id: str, request: Request):
    """One asset with fresh signed addresses: what a `gamAsset` block asks for each time
    it is shown, since the addresses expire."""
    try:
        with _client(request) as gam:
            asset = gam.get_asset(asset_id)
    except GamError as exc:
        raise exc.http()
    if asset is None:
        raise HTTPException(status_code=404, detail={
            "code": "gam_asset_not_found",
            "message": "This asset is no longer in your library, or is not yours."})
    return {"data": gam_client.public(asset)}
