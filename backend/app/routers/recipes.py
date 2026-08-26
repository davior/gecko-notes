import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from app.database import get_session
from app.models import Recipe
from app.schemas import RecipeCreate, RecipeUpdate, RecipeRead, DataResponse, ListResponse

router = APIRouter()


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _read(recipe: Recipe) -> RecipeRead:
    try:
        tags = json.loads(recipe.tags)
    except (TypeError, ValueError):
        tags = []
    return RecipeRead(
        id=recipe.id,
        name=recipe.name,
        prompt=recipe.prompt,
        tags=tags,
        sort_order=recipe.sort_order,
        created_at=recipe.created_at,
        updated_at=recipe.updated_at,
    )


def _get_recipe(recipe_id: str, user_id: str, session: Session) -> Recipe:
    recipe = session.get(Recipe, recipe_id)
    if not recipe or recipe.user_id != user_id:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


@router.get("", response_model=ListResponse[RecipeRead])
def list_recipes(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    rows = session.exec(
        select(Recipe).where(Recipe.user_id == user_id).order_by(Recipe.sort_order, Recipe.name)
    ).all()
    data = [_read(r) for r in rows]
    return ListResponse(data=data, total=len(data), limit=len(data), offset=0)


@router.post("", response_model=DataResponse[RecipeRead], status_code=201)
def create_recipe(body: RecipeCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    now = datetime.utcnow()
    obj = Recipe(
        id=str(uuid.uuid4()),
        user_id=user_id,
        name=body.name,
        prompt=body.prompt,
        tags=json.dumps(body.tags),
        sort_order=body.sort_order,
        created_at=now,
        updated_at=now,
    )
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return DataResponse(data=_read(obj))


@router.patch("/{recipe_id}", response_model=DataResponse[RecipeRead])
def update_recipe(recipe_id: str, body: RecipeUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    obj = _get_recipe(recipe_id, user_id, session)
    if body.name is not None:
        obj.name = body.name
    if body.prompt is not None:
        obj.prompt = body.prompt
    if body.tags is not None:
        obj.tags = json.dumps(body.tags)
    if body.sort_order is not None:
        obj.sort_order = body.sort_order
    obj.updated_at = datetime.utcnow()
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return DataResponse(data=_read(obj))


@router.delete("/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    obj = _get_recipe(recipe_id, user_id, session)
    session.delete(obj)
    session.commit()
