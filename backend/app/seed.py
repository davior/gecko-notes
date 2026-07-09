import json
import uuid
from sqlmodel import Session, select
from app.models import Category, AppSetting, UserSetting, Theme, ModelCatalogEntry

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


_FAL_TTS_VOICES_SEED = [
    "Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River",
    "Liam", "Charlotte", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris",
    "Brian", "Daniel", "Lily", "Bill",
]

DEFAULT_IMAGE_CATALOG = [
    # The 5 pre-existing curated models.
    {"model_id": "fal-ai/flux/schnell", "label": "FLUX.1 [schnell]", "maker_note": "fastest, low cost"},
    {"model_id": "fal-ai/flux/dev", "label": "FLUX.1 [dev]", "maker_note": "high quality"},
    {"model_id": "fal-ai/flux-pro/v1.1", "label": "FLUX1.1 [pro]", "maker_note": "top quality"},
    {"model_id": "fal-ai/recraft-v3", "label": "Recraft V3", "maker_note": "styles, text, vectors"},
    {"model_id": "fal-ai/stable-diffusion-v35-large", "label": "Stable Diffusion 3.5 Large", "maker_note": None},
    # New additions.
    {"model_id": "fal-ai/flux-2-pro", "label": "FLUX.2 [pro]", "maker_note": "Black Forest Labs — top-tier photorealism & detail"},
    {"model_id": "fal-ai/flux-2/dev", "label": "FLUX.2 [dev]", "maker_note": "Black Forest Labs — realism + native editing"},
    {"model_id": "fal-ai/flux-2/dev/turbo", "label": "FLUX.2 [dev] Turbo", "maker_note": "fal's distilled version — cheap, fast"},
    {"model_id": "fal-ai/flux-pro/v1.1-ultra", "label": "FLUX1.1 [pro] ultra", "maker_note": "Black Forest Labs — up to 2K, print-scale"},
    {"model_id": "fal-ai/flux-pro/kontext", "label": "FLUX.1 Kontext [pro]", "maker_note": "Black Forest Labs — context-aware editing"},
    {"model_id": "fal-ai/nano-banana-2", "label": "Nano Banana 2", "maker_note": "Google (Gemini 3.1 Flash Image) — fast, vibrant, text-aware"},
    {"model_id": "fal-ai/nano-banana-pro", "label": "Nano Banana Pro", "maker_note": "Google (Gemini 3 Pro Image) — SOTA high-fidelity"},
    {"model_id": "fal-ai/bytedance/seedream/v4.5/text-to-image", "label": "Seedream V4.5", "maker_note": "ByteDance — photoreal, unified gen+edit"},
    {"model_id": "fal-ai/bytedance/seedream/v4/text-to-image", "label": "Seedream V4", "maker_note": "ByteDance — photoreal, unified gen+edit"},
    {"model_id": "fal-ai/qwen-image", "label": "Qwen Image (Max)", "maker_note": "Alibaba — LLM-based, best complex text rendering"},
    {"model_id": "fal-ai/gpt-image-2", "label": "GPT Image 2", "maker_note": "OpenAI — strong instruction-following, multilingual text"},
    {"model_id": "fal-ai/gpt-image-1.5", "label": "GPT Image 1.5", "maker_note": "OpenAI — high-fidelity, strong prompt adherence"},
    {"model_id": "fal-ai/ideogram/v3", "label": "Ideogram V3", "maker_note": "Ideogram — best-in-class typography, posters/logos"},
    {"model_id": "fal-ai/krea-2", "label": "Krea 2 (Large)", "maker_note": "Krea — aesthetic-focused, stylized"},
    {"model_id": "fal-ai/z-image/turbo", "label": "Z-Image Turbo", "maker_note": "Tongyi-MAI — 6B, ultra-fast, bilingual EN/CN"},
    {"model_id": "fal-ai/fast-sdxl", "label": "Fast SDXL", "maker_note": "Stability (SDXL) — for existing SDXL prompts/LoRAs"},
]

DEFAULT_TTS_CATALOG = [
    {"model_id": "fal-ai/elevenlabs/tts/eleven-v3", "label": "ElevenLabs v3", "maker_note": None,
     "voices": _FAL_TTS_VOICES_SEED},
    {"model_id": "fal-ai/elevenlabs/tts/turbo-v2.5", "label": "ElevenLabs Turbo v2.5 (faster)", "maker_note": None,
     "voices": _FAL_TTS_VOICES_SEED},
    {"model_id": "fal-ai/kokoro/american-english", "label": "Kokoro TTS (American English)", "maker_note": None,
     "voices": ["af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
                "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam",
                "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
                "am_puck", "am_santa"],
     "text_field": "prompt"},
    {"model_id": "fal-ai/gemini-tts", "label": "Gemini TTS", "maker_note": None,
     "voices": ["Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe",
                "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome", "Fenrir",
                "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Pulcherrima",
                "Puck", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat",
                "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi"],
     "text_field": "prompt"},
    {"model_id": "xai/tts/v1", "label": "xAI TTS", "maker_note": None,
     "voices": ["eve", "ara", "rex", "sal", "leo"],
     "extra_params": {"language": "auto"}},
]

DEFAULT_STT_CATALOG = [
    {"model_id": "fal-ai/wizper", "label": "Wizper (Whisper v3 Large)",
     "maker_note": "fal — Whisper v3 Large optimized, ~2x speed, 99-lang translate"},
    {"model_id": "fal-ai/elevenlabs/speech-to-text/scribe-v2", "label": "ElevenLabs Scribe v2",
     "maker_note": "ElevenLabs — top accuracy, 99 langs, word timestamps, diarization, audio-event detection"},
    {"model_id": "fal-ai/elevenlabs/speech-to-text", "label": "ElevenLabs Scribe v1",
     "maker_note": "ElevenLabs — 99 langs, word timestamps, audio-event tagging"},
    {"model_id": "fal-ai/whisper", "label": "Whisper (OpenAI, via fal)",
     "maker_note": "OpenAI — transcription + translation, batch, cheap baseline"},
]


def seed_model_catalog(session: Session):
    existing = session.exec(select(ModelCatalogEntry)).first()
    if existing:
        return
    for kind, items in (("image", DEFAULT_IMAGE_CATALOG), ("tts", DEFAULT_TTS_CATALOG), ("stt", DEFAULT_STT_CATALOG)):
        for i, item in enumerate(items):
            session.add(ModelCatalogEntry(
                id=str(uuid.uuid4()),
                kind=kind,
                model_id=item["model_id"],
                label=item["label"],
                maker_note=item.get("maker_note"),
                sort_order=i,
                is_active=True,
                voices=json.dumps(item["voices"]) if item.get("voices") else None,
                text_field=item.get("text_field"),
                voice_field=item.get("voice_field"),
                extra_params=json.dumps(item["extra_params"]) if item.get("extra_params") else None,
            ))
    session.commit()


def run_seed(session: Session):
    seed_categories(session)
    seed_settings(session)
    seed_global_themes(session)
    seed_model_catalog(session)
