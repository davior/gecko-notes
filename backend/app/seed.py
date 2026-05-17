import uuid
from sqlmodel import Session, select
from app.models import Category, AppSetting, UserSetting, Theme

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

DEFAULT_USER_SETTINGS = {
    "default_sort_order": '"modified_at"',
    "ai_temperature": "0.8",
    "ai_prefill": '""',
    "summary_prompt": '""',
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


def seed_user_settings(session: Session, user_id: str):
    for key, value in DEFAULT_USER_SETTINGS.items():
        existing = session.exec(
            select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == key)
        ).first()
        if not existing:
            session.add(UserSetting(user_id=user_id, key=key, value=value))
    session.commit()


DEFAULT_GLOBAL_THEMES = [
    {
        "name": "Ocean Breeze",
        "mode": "light",
        "bg_type": "gradient",
        "bg_color1": "#e0f2fe",
        "bg_color2": "#bfdbfe",
        "bg_blur": 0.0,
        "glass_opacity": 0.30,
        "glass_blur": 12.0,
        "shadow_size": 4.0,
        "shadow_blur": 12.0,
    },
    {
        "name": "Midnight",
        "mode": "dark",
        "bg_type": "gradient",
        "bg_color1": "#0f172a",
        "bg_color2": "#1e293b",
        "bg_blur": 0.0,
        "glass_opacity": 0.30,
        "glass_blur": 16.0,
        "shadow_size": 6.0,
        "shadow_blur": 20.0,
    },
    {
        "name": "Sunset Warm",
        "mode": "light",
        "bg_type": "gradient",
        "bg_color1": "#fff7ed",
        "bg_color2": "#fef3c7",
        "bg_blur": 0.0,
        "glass_opacity": 0.25,
        "glass_blur": 10.0,
        "shadow_size": 4.0,
        "shadow_blur": 10.0,
    },
    {
        "name": "Forest Dark",
        "mode": "dark",
        "bg_type": "gradient",
        "bg_color1": "#052e16",
        "bg_color2": "#14532d",
        "bg_blur": 0.0,
        "glass_opacity": 0.35,
        "glass_blur": 14.0,
        "shadow_size": 6.0,
        "shadow_blur": 18.0,
    },
    {
        "name": "Pure Light",
        "mode": "light",
        "bg_type": "flat",
        "bg_color1": "#f8fafc",
        "bg_color2": None,
        "bg_blur": 0.0,
        "glass_opacity": 0.20,
        "glass_blur": 8.0,
        "shadow_size": 2.0,
        "shadow_blur": 8.0,
    },
]


def seed_global_themes(session: Session):
    existing = session.exec(select(Theme).where(Theme.is_global == True)).all()
    if existing:
        return
    for t in DEFAULT_GLOBAL_THEMES:
        theme = Theme(
            id=str(uuid.uuid4()),
            name=t["name"],
            user_id=None,
            is_global=True,
            mode=t["mode"],
            bg_type=t["bg_type"],
            bg_color1=t["bg_color1"],
            bg_color2=t.get("bg_color2"),
            bg_image_url=None,
            bg_image_mode="fill",
            bg_blur=t["bg_blur"],
            glass_opacity=t["glass_opacity"],
            glass_blur=t["glass_blur"],
            shadow_size=t["shadow_size"],
            shadow_blur=t["shadow_blur"],
        )
        session.add(theme)
    session.commit()


def run_seed(session: Session):
    seed_categories(session)
    seed_settings(session)
    seed_global_themes(session)
