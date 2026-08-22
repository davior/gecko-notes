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
- Per-note statistics (word/character count, reading time, size including attachments, versions, and likes) from an info button in the status bar

### AI assistant
- Conversational AI assistant (Anthropic, OpenAI, DeepSeek, Ollama, or any OpenAI-compatible endpoint)
- **Agentic note plans** — the assistant turns requests into executable, multi-step plans that edit the note (insert/edit sections, add references, move notes) with per-step checkboxes
- **Web search** via Anthropic's built-in tool
- Context scope controls (current note, selection, attachments) with prompt-cache freezing to reduce token cost
- File and PDF attachments as context
- Per-note AI session history
- One-click **Generate Metadata** (AI tags + summary)
- Configurable system prompts, temperature, and prefill

### Voice
- **Read-aloud (TTS)** powered by fal.ai voices, with floating draggable playback controls (play/pause/stop, volume, speed)
- **Voice dictation (STT)** powered by fal.ai, with a browser speech-recognition fallback when no key is set
- Record button and TTS Insert Mode in a dockable speech control bar
- Dictation directly into the AI assistant chat
- MP3 export of read-aloud audio
- Usage monitoring for TTS/STT and AI provider tokens, with per-provider cost breakdown and usage-over-time charts

### Video
- **Record video** from a camera/microphone of your choice, directly from the slash menu (works in Chrome, Firefox, Safari, and Edge)
- Selectable **video/audio quality** (resolution + bitrate presets), remembered per device
- **Presentation mode** — share your screen, a window, or a browser tab with your camera composited as a picture-in-picture inset, toggleable on/off at any time, including mid-recording
- Recorded video is saved into the note as a playable video block
- Optional **async transcript generation** — the audio track is extracted and sent to fal.ai in the background, and the resulting transcript is attached to the note as a file once ready, without blocking the editor

### Article to video
- **Generate video from article** — turns a note into a narrated MP4: each image or video in the document becomes the background for the text beneath it, read aloud in your chosen TTS voice
- Videos in the article play with their own audio (the narration waits for them) or loop silently under the narration when they have no sound
- **Aspect presets** for 16:9 (YouTube), 9:16 (Shorts/TikTok) and 1:1 (Instagram) at 720p/1080p/4K, with a fast 480p preview pass — narration is cached, so a full render afterwards costs no extra speech
- Optional **animated waveform** (style, colour, position, height), **watermark** with an uploaded icon and caption, and a **fixed text overlay**
- **Title screens**, optional chapter screens, chapter markers embedded in the MP4, an automatic thumbnail, and **subtitles** as an `.srt` sidecar, a track inside the MP4, or burned into the picture
- Renders in the background with progress in the header and the browser tab, and can be cancelled mid-render — the finished video is attached to the note by the server, so it arrives even if you close the tab

### Sharing & export
- Export to PDF, Word (.docx), Markdown, HTML, MP3, MP4 video, or clipboard
- Public note sharing with social-media preview metadata (Open Graph / Twitter cards)
- Shared pages include social share + like buttons (with optional Umami analytics) and a print option
- Share via Email, Facebook, X (Twitter), or Substack
- Print-friendly output

### Platform
- Full-text search (in the title bar) and category filters
- Infinite scroll note list with list/card view toggle
- Light/dark theme and custom background themes (colors, gradients, images)
- User accounts with registration, JWT-based authentication, and an admin user manager with per-user metrics (note/folder/shared counts, total likes, last login, and on-demand media folder size)
- Optional email flows (welcome/verification, self-service password reset) and opt-in two-factor authentication via authenticator app (TOTP) or email codes — see [Email & Two-Factor Authentication](#email--two-factor-authentication)
- Admin control to disable new registrations
- Reverse-proxy aware (honors `X-Forwarded-*` headers, HTTPS by default behind a proxy)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript + Zustand + Tailwind CSS v3 |
| Editor | BlockNote (`@blocknote/react`) |
| Backend | FastAPI + SQLModel (SQLite) |
| AI | Anthropic / OpenAI / DeepSeek / Ollama / OpenAI-compatible; web search via Anthropic |
| Voice & Images | fal.ai (TTS + STT + image generation) |
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

`JWT_SECRET_KEY` is required; the app will refuse to start without it. It is used to sign authentication tokens and to encrypt stored AI provider and fal.ai API keys. `CORS_ORIGIN` accepts a comma-separated list and is only needed if the API is accessed from a different origin than the frontend.

Additional optional settings (see `.env.example` for the full list):

| Variable | Purpose |
|----------|---------|
| `UPLOAD_MAX_SIZE` | Maximum upload size in nginx format (default `1g`) |
| `NOTE_VERSION_INTERVAL_MINUTES` | How often the editor snapshots a note version while focused (default `5`) |
| `NOTE_VERSION_MAX_COUNT` | Maximum versions kept per note before older ones are pruned (default `50`) |
| `RENDER_MAX_CONCURRENCY` | How many article-to-video renders may run at once (default `1`) |
| `VIDEO_MAX_SHOTS` | Refuse a render needing more segments than this (default `200`) |
| `VIDEO_MAX_NARRATION_CHARS` | Refuse a render with more narration than this (default `60000`) |
| `VIDEO_JOB_RETENTION_DAYS` | Delete render artefacts older than this, unless the video was added to a note (default `14`; `0` keeps everything) |
| `COMPOSE_FILE` | Set to `docker-compose.yml:docker-compose.prod.yml` to always include the reverse-proxy overlay |
| `APP_BASE_URL` | Public origin used to build links in emails (e.g. `https://notes.example.com`) |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server host and port (default port `587`) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | SMTP credentials |
| `SMTP_FROM` | From address on outgoing mail, e.g. `Gecko Notes <admin@geckopico.com>` |
| `SMTP_STARTTLS` / `SMTP_SSL` | Transport security — STARTTLS (default) or implicit TLS |

## Email & Two-Factor Authentication

Email powers the welcome/verification email sent at sign-up, self-service password
reset, and email-based two-factor codes. **Email features are optional and stay off
until both `SMTP_HOST` and `SMTP_FROM` are set.** With no SMTP configured the app
works exactly as before — new accounts are usable immediately and password reset /
email-2FA are simply not offered.

When email is configured:

- **Verification** — new sign-ups receive a welcome email with a verification link
  and cannot sign in until they click it. Admins can turn this requirement off under
  **Settings → Users → Registration**.
- **Password reset** — the sign-in screen shows a **Forgot password?** link that
  emails a one-time reset link.
- **Two-factor authentication** — each user can enable 2FA from **Settings →
  Profile**, choosing an **authenticator app (TOTP)** or **email codes**. It's
  opt-in and off by default.

Admins can also **disable new registrations** entirely under **Settings → Users →
Registration** (the first account is always allowed, so an instance can bootstrap
its admin).

### SMTP setup with SMTP2Go + ImprovMX

A concrete recipe for sending as `admin@geckopico.com`:

**Outbound (SMTP2Go)** — create an SMTP user in the [SMTP2Go](https://www.smtp2go.com/)
dashboard and set in `.env`:

```env
APP_BASE_URL=https://notes.geckopico.com
SMTP_HOST=mail.smtp2go.com
SMTP_PORT=2525            # or 587; use 465/8465 with SMTP_SSL=true
SMTP_USERNAME=your-smtp2go-user
SMTP_PASSWORD=your-smtp2go-password
SMTP_FROM=Gecko Notes <admin@geckopico.com>
SMTP_STARTTLS=true
```

In SMTP2Go, **verify the `geckopico.com` sender domain** and add the **SPF + DKIM**
DNS records it provides so mail isn't spam-filtered.

**Inbound (ImprovMX)** — [ImprovMX](https://improvmx.com/) forwards mail *to* the
address for free (it does not send). Point the `geckopico.com` **MX records** at
`mx1.improvmx.com` / `mx2.improvmx.com` and create an alias
`admin@geckopico.com → your-inbox@example.com`, so replies to the From address reach
you.

> **DNS note:** a domain may have only **one** SPF (`TXT`) record. If you use both
> services, merge their includes into a single record (e.g.
> `v=spf1 include:spf.smtp2go.com include:spf.improvmx.com ~all`) rather than adding
> two separate SPF lines.

## AI Providers

Go to **Settings → AI Providers** to configure an AI provider:

| Provider | Notes |
|----------|-------|
| Anthropic | Requires an API key from console.anthropic.com. Required for the AI assistant's web search tool. |
| OpenAI | Requires an API key from platform.openai.com |
| DeepSeek | Requires an API key from platform.deepseek.com. Models: `deepseek-chat` or `deepseek-reasoner` |
| Ollama | Point to your local Ollama instance (e.g. `http://localhost:11434`) |
| Custom | Any OpenAI-compatible endpoint |

Tune assistant behavior under **Settings → AI Settings** (system prompts, temperature, prefill) and review token usage under **Settings → Usage**.

API keys are stored encrypted in the local SQLite database — never transmitted to any third party except the AI provider you configure.

## Speech (Read-Aloud & Dictation)

Speech shares the same [fal.ai](https://fal.ai/dashboard/keys) API key as image generation — add it under **Settings → AI Services → Images**. It powers both text-to-speech read-aloud (choose from curated voices under **Settings → AI Services → Speech**) and voice dictation.

- **With a fal.ai key:** read-aloud and dictation work in all browsers via fal.ai.
- **Without a key:** dictation falls back to the browser's built-in speech recognition where available; read-aloud is disabled.

TTS/STT usage is tracked under **Settings → AI Services → Usage**. The same key also powers optional video transcript generation (see **Video** above).

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

`ffmpeg` must be on `PATH` for video transcript generation (extracts the audio track before sending it to fal.ai) and for article-to-video rendering. Install it with your OS package manager, e.g. `apt install ffmpeg` or `brew install ffmpeg`. The Docker image installs it automatically.

Article-to-video also uses `ffprobe` (shipped alongside ffmpeg) and the `showwaves`, `gblur` and `subtitles` filters. The backend probes for these at startup and degrades gracefully — the waveform is skipped, and burned-in subtitles fall back to an `.srt` sidecar — logging a warning rather than failing a render partway through.

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
    │   │               #   media, settings, transcription, video, data, shared, auth, users
    │   ├── video/      # Article-to-video: segmenter, narration, ffmpeg builders,
    │   │               #   Pillow composition, renderer, render worker
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
