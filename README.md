# Gecko Notes

A full-featured, self-hosted notes application with a block editor, AI assistance, categories, tags, and rich export/share options.

## Features

- Block-based editor powered by BlockNote (headings, lists, code, images, tables, and more)
- Categories with custom emoji and color
- Tags with AI-powered tag generation
- AI writing assistant (Anthropic, OpenAI, Ollama, or any OpenAI-compatible endpoint)
- AI-generated note summaries
- Pinned notes
- Export to PDF, Word (.docx), Markdown, HTML, or clipboard
- Share via Email, Facebook, X (Twitter), or Substack
- Full-text search and category filters
- Infinite scroll note list with list/card view toggle
- Light/dark theme and custom background themes (colors, gradients, images)
- User accounts with registration and JWT-based authentication
- Print-friendly output

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript + Zustand + Tailwind CSS v3 |
| Editor | BlockNote (`@blocknote/react`) |
| Backend | FastAPI + SQLModel (SQLite) |
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

The app will be available at **http://localhost:8080** (or the port you set in `.env`).

### 3. Access on your LAN

If your machine's IP is `192.168.1.100`, the app is available at `http://192.168.1.100:8080` from any device on the same network.

## Configuration

Edit `.env` before starting:

```env
APP_PORT=8080        # Port to expose on your host machine (default: 8080)
JWT_SECRET_KEY=      # REQUIRED — generate with: openssl rand -hex 32
CORS_ORIGIN=         # Optional — your public domain, e.g. https://notes.example.com
```

`JWT_SECRET_KEY` is required; the app will refuse to start without it. It is used to sign authentication tokens and to encrypt stored AI provider API keys. `CORS_ORIGIN` accepts a comma-separated list and is only needed if the API is accessed from a different origin than the frontend.

## AI Providers

Go to **Settings → AI Providers** to configure an AI provider:

| Provider | Notes |
|----------|-------|
| Anthropic | Requires an API key from console.anthropic.com |
| OpenAI | Requires an API key from platform.openai.com |
| Ollama | Point to your local Ollama instance (e.g. `http://localhost:11434`) |
| Custom | Any OpenAI-compatible endpoint |

API keys are stored in the local SQLite database — never transmitted to any third party except the AI provider you configure.

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
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

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
│   │   ├── views/      # ListView, EditorView, SettingsView, LoginView, ProfileView
│   │   ├── components/ # NoteCard, CategoryPicker, AIPanel, ExportMenu, etc.
│   │   ├── stores/     # Zustand stores (notes, categories, settings, auth)
│   │   ├── api/        # Axios API client modules
│   │   ├── services/   # AI provider abstraction layer
│   │   └── utils/      # Export and share utilities
│   └── Dockerfile
└── backend/            # FastAPI + SQLModel
    ├── app/
    │   ├── main.py
    │   ├── models.py
    │   ├── schemas.py
    │   ├── database.py
    │   ├── seed.py
    │   └── routers/    # notes, categories, media, settings, auth, users, data
    └── Dockerfile
```

## Stopping and Updating

```bash
# Stop
docker compose down

# Update (after pulling new code)
docker compose build --no-cache
docker compose up -d
```
