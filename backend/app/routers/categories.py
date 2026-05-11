import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.models import Category
from app.schemas import (
    CategoryCreate, CategoryUpdate, CategoryRead,
    DataResponse, ListResponse
)

router = APIRouter()


@router.get("", response_model=ListResponse[CategoryRead])
def list_categories(session: Session = Depends(get_session)):
    categories = session.exec(select(Category).order_by(Category.sort_order)).all()
    return ListResponse(
        data=[CategoryRead.model_validate(c) for c in categories],
        total=len(categories),
        limit=len(categories),
        offset=0,
    )


@router.post("", response_model=DataResponse[CategoryRead], status_code=201)
def create_category(payload: CategoryCreate, session: Session = Depends(get_session)):
    category = Category(
        id=str(uuid.uuid4()),
        label=payload.label,
        emoji=payload.emoji,
        color=payload.color,
        is_default=payload.is_default,
        sort_order=payload.sort_order,
    )
    session.add(category)
    session.commit()
    session.refresh(category)
    return DataResponse(data=CategoryRead.model_validate(category))


@router.put("/{category_id}", response_model=DataResponse[CategoryRead])
def update_category(
    category_id: str,
    payload: CategoryUpdate,
    session: Session = Depends(get_session),
):
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Category not found"})

    if payload.label is not None:
        category.label = payload.label
    if payload.emoji is not None:
        category.emoji = payload.emoji
    if payload.color is not None:
        category.color = payload.color
    if payload.sort_order is not None:
        category.sort_order = payload.sort_order

    session.add(category)
    session.commit()
    session.refresh(category)
    return DataResponse(data=CategoryRead.model_validate(category))


@router.delete("/{category_id}", status_code=204)
def delete_category(category_id: str, session: Session = Depends(get_session)):
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Category not found"})
    if category.is_default:
        raise HTTPException(
            status_code=400,
            detail={"code": "cannot_delete_default", "message": "Default categories cannot be deleted"},
        )
    session.delete(category)
    session.commit()
