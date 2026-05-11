import uuid
from sqlmodel import Session, select
from app.models import Category, AppSetting

DEFAULT_CATEGORIES = [
    {"label": "Article", "emoji": "📝", "color": "#3B82F6"},
    {"label": "Project Management", "emoji": "📋", "color": "#8B5CF6"},
    {"label": "Social Media", "emoji": "📣", "color": "#EC4899"},
    {"label": "Diary/Testimony", "emoji": "📖", "color": "#F59E0B"},
    {"label": "Scratchpad/Other", "emoji": "🗒️", "color": "#6B7280"},
    {"label": "Idea", "emoji": "💡", "color": "#10B981"},
]

DEFAULT_SETTINGS = {
    "default_sort_order": '"modified_at"',
}


def seed_categories(session: Session):
    existing = session.exec(select(Category)).all()
    if existing:
        return

    for i, cat in enumerate(DEFAULT_CATEGORIES):
        category = Category(
            id=str(uuid.uuid4()),
            label=cat["label"],
            emoji=cat["emoji"],
            color=cat["color"],
            is_default=True,
            sort_order=i,
        )
        session.add(category)
    session.commit()


def seed_settings(session: Session):
    for key, value in DEFAULT_SETTINGS.items():
        existing = session.get(AppSetting, key)
        if not existing:
            setting = AppSetting(key=key, value=value)
            session.add(setting)
    session.commit()


def run_seed(session: Session):
    seed_categories(session)
    seed_settings(session)
