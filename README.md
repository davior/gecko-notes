# Gecko Notes

A full-featured, self-hosted notes application with a block editor, an agentic AI assistant, voice (read-aloud and dictation), folders and note hierarchies, version history, categories, tags, and rich export/share options.

## Features

### Editing & organization
- Block-based editor powered by BlockNote (headings, lists, code, images, tables, and more)
- Folders with a collapsible folder icon bar and drag-and-drop organization
- Child notes / note hierarchies — send a section to a child note and navigate between parent and children
- Note references — link notes together with inline reference pills
- Collapsible, resizable document outline for quick navigation
- Pinned notes, surfaced separately from regular notes
- Categories with custom emoji and color
- Tags with AI-powered tag generation
- Block-level annotations (highlight a block and attach notes, with AI assistance)
- Version history with periodic snapshots, checksum deduplication, and a side-by-side diff view

### AI assistant
- Conversational AI assistant (Anthropic, OpenAI, Ollama, or any OpenAI-compatible endpoint)
- **Agentic note plans** — the assistant turns requests into executable, multi-step plans that edit the note (insert/edit sections, add references, move notes) with per-step checkboxes
- **Web search** via Anthropic's built-in tool
- Context scope controls (current note, selection, attachments) with prompt-cache freezing to reduce token cost
- File and PDF attachments as context
- Per-note AI session history
- One-click **Generate Metadata** (AI tags + summary)
- Configurable system prompts, temperature, and prefill

### Voice
- **Read-aloud (TTS)** powered by Deepgram Aura voices, with floating draggable playback controls (play/pause/stop, volume, speed)
- **Voice dictation (STT)** powered by Deepgram, with a browser speech-recognition fallback when no key is set
- Record button and TTS Insert Mode in a dockable speech control bar
- Dictation directly into the AI assistant chat
- MP3 export of read-aloud audio
- Usage monitoring for Deepgram TTS/STT and AI provider tokens

### Sharing & export
- Export to PDF, Word (.docx), Markdown, HTML, MP3, or clipboard
- Public note sharing with social-media preview metadata (Open Graph / Twitter cards)
- Shared pages include social share + like buttons (with optional Umami analytics) and a print option
- Share via Email, Facebook, X (Twitter), or Substack
- Print-friendly output

### Platform
- Full-text search (in the title bar) and category filters
- Infinite scroll note list with list/card view toggle
- Light/dark theme and custom background themes (colors, gradients, images)
- User accounts with registration, JWT-based authentication, and an admin user manager
- Reverse-proxy aware (honors `X-Forwarded-*` headers, HTTPS by default behind a proxy)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript + Zustand + Tailwind CSS v3 |
| Editor | BlockNote (`@blocknote/react`) |
| Backend | FastAPI + SQLModel (SQLite) |
| AI | Anthropic / OpenAI / Ollama / OpenAI-compatible; web search via Anthropic |
| Voice | Deepgram (TTS + STT) |
| Container | Docker Compose + Nginx |

## Quick Start

### Prerequisites

- Docker and Docker Compose installed

### 1. Clone and configure

```bash
git clone <repo-url> gecko-notes
cd gecko-notes
cp .env.example .env
# Edit .env if needed
```

### 2. Start the app

```bash
docker compose up -d
```

The app will be available at **http://localhost:18081** by default, or whatever port you set in `.env`.

For production behind an external reverse proxy that already provides a `web` Docker network, run:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 3. Access on your LAN

If your machine's IP is `192.168.1.100`, the app is available at `http://192.168.1.100:18081` from any device on the same network.

## Configuration

Edit `.env` before starting:

```env
APP_PORT=18081       # Port to expose on your host machine (default: 18081)
JWT_SECRET_KEY=      # REQUIRED — generate with: openssl rand -hex 32
CORS_ORIGIN=         # Optional — your public domain, e.g. https://notes.example.com
```

`JWT_SECRET_KEY` is required; the app will refuse to start without it. It is used to sign authentication tokens and to encrypt stored AI provider and Deepgram API keys. `CORS_ORIGIN` accepts a comma-separated list and is only needed if the API is accessed from a different origin than the frontend.

Additional optional settings (see `.env.example` for the full list):

| Variable | Purpose |
|----------|---------|
| `UPLOAD_MAX_SIZE` | Maximum upload size in nginx format (default `1g`) |
| `NOTE_VERSION_INTERVAL_MINUTES` | How often the editor snapshots a note version while focused (default `5`) |
| `NOTE_VERSION_MAX_COUNT` | Maximum versions kept per note before older ones are pruned (default `50`) |
| `COMPOSE_FILE` | Set to `docker-compose.yml:docker-compose.prod.yml` to always include the reverse-proxy overlay |

## AI Providers

Go to **Settings → AI Providers** to configure an AI provider:

| Provider | Notes |
|----------|-------|
| Anthropic | Requires an API key from console.anthropic.com. Required for the AI assistant's web search tool. |
| OpenAI | Requires an API key from platform.openai.com |
| Ollama | Point to your local Ollama instance (e.g. `http://localhost:11434`) |
| Custom | Any OpenAI-compatible endpoint |

Tune assistant behavior under **Settings → AI Settings** (system prompts, temperature, prefill) and review token usage under **Settings → Usage**.

API keys are stored encrypted in the local SQLite database — never transmitted to any third party except the AI provider you configure.

## Speech (Read-Aloud & Dictation)

Go to **Settings → Speech** to add a [Deepgram](https://console.deepgram.com/) API key, which powers both text-to-speech read-aloud (choose from curated Deepgram Aura voices) and voice dictation.

- **With a Deepgram key:** read-aloud and dictation work in all browsers via Deepgram's API.
- **Without a key:** dictation falls back to the browser's built-in speech recognition where available; read-aloud is disabled.

Deepgram TTS/STT usage is tracked under **Settings → Usage**.

## Backup

Two items to back up regularly:

| Item | Path |
|------|------|
| SQLite database | `./data/db/notes.db` |
| Uploaded media files | `./data/media/` |

Example backup command:
```bash
tar -czf gecko-notes-backup-$(date +%Y%m%d).tar.gz data/
```

## Development

### Backend (FastAPI)

```bash
python3.12 -m venv .venv312
source .venv312/bin/activate
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Use Python 3.12 for local backend development. The current backend dependency stack may not start cleanly on newer Python releases such as 3.14.

Local backend runs and Docker Compose both use the same persistent paths by default:
`./data/db/notes.db` and `./data/media/`.

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/media` to `http://localhost:8000`.

## Project Structure

```
gecko-notes/
├── docker-compose.yml
├── .env.example
├── frontend/           # React SPA
│   ├── src/
│   │   ├── views/      # ListView, EditorView, SettingsView, LoginView, ProfileView, SharedNoteView
│   │   ├── components/ # NoteCard, AIConversationPanel, AnnotationLayer, DocumentOutline,
│   │   │               #   FolderIconBar, TTSPlaybackControls, ShareMenu, ExportMenu, settings/, etc.
│   │   ├── stores/     # Zustand stores (notes, categories, folders, settings, auth)
│   │   ├── api/        # Axios API client modules
│   │   ├── services/   # AI provider abstraction, aiPlan, planExecutor
│   │   ├── hooks/      # useTextToSpeech and other hooks
│   │   └── utils/      # Export and share utilities
│   └── Dockerfile
└── backend/            # FastAPI + SQLModel
    ├── app/
    │   ├── main.py
    │   ├── models.py
    │   ├── schemas.py
    │   ├── database.py
    │   ├── limiter.py
    │   ├── seed.py
    │   └── routers/    # notes, annotations, ai_sessions, categories, folders,
    │   │               #   media, settings, data, shared, auth, users
    └── Dockerfile
```

## Stopping and Updating

```bash
# Stop
docker compose down

# Update (after pulling new code)
docker compose build --no-cache
docker compose up -d

# Production deployment with external proxy network
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
