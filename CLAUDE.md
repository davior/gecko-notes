# gecko-notes — Claude Instructions

## After Every Change (dev environment)

After making any code change, output the following dev build / refresh instructions so the change can be seen locally.

**Live dev servers** (recommended — auto-reload, no manual build per change):

```bash
# Frontend — http://localhost:5173 (Vite HMR; proxies /api and /media to :8000)
cd frontend && npm run dev

# Backend — http://localhost:8000 (auto-reloads on save)
cd backend && uvicorn app.main:app --reload --port 8000
```

**Docker workflow** (the frontend is a compiled static bundle served by Nginx, so source edits only take effect after a rebuild):

```bash
docker compose up --build -d
```

Then hard-refresh the browser (Ctrl/Cmd+Shift+R) to bypass cached assets.

**Notes:**
- Frontend changes need either the Vite dev server (HMR) or a `--build`; a plain `docker compose up -d` keeps serving the previously built bundle.
- Backend changes auto-reload under `uvicorn --reload`, or need `--build` under Docker.
- The app is served at **http://localhost:18081** (frontend port mapping in `docker-compose.yml`).

## After Committing to an Open Branch (pull request info)

After every set of changes committed and pushed to an open (non-`main`) branch, return the pull request information for that branch:

- Look up the PR via the GitHub MCP (list pull requests with `head` = the current branch, or read the PR directly).
- Report the PR number, URL, title, and draft / CI status.
- If no PR exists yet for the branch, create a **draft** PR and return its info.

## After Every Commit to main (production deployment)

Whenever a commit lands on `main` — including a PR merge (e.g. a `<github-webhook-activity>` event indicating a merge) — automatically output the following production deployment instructions:

---

**Deploy to production** (run on the server from the repo root):

```bash
git pull origin main
docker compose up --build -d
```

**Verify the deployment:**

```bash
docker compose ps
curl -f http://localhost:18081/api/health
```

**Notes:**
- `data/db/` and `data/media/` are bind-mounted volumes — they survive rebuilds, no data migration needed.
- Database schema migrations run automatically on backend startup (`init_db()` in `database.py`).
- `JWT_SECRET_KEY` must be set in `.env`; app will refuse to start without it.
- The app is exposed on port `18081` (frontend service in `docker-compose.yml`); the backend listens on `8000` internally.

### Deploying Behind a Reverse Proxy (Caddy, Nginx, etc.)

If the app is deployed behind an external reverse proxy on a shared Docker network (e.g., `davior/infra` with Caddy on a `web` network):

**Setup:** Ensure `.env` contains:
```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
```

This tells Docker Compose to always include the prod overlay, which joins the frontend to the external `web` network. With this set, plain `docker compose up --build -d` will correctly attach to the reverse proxy's network.

Alternatively, use the explicit form (no `.env` change needed):
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

**Why:** `docker-compose.prod.yml` attaches the frontend to an external `web` network created by the infra repo. Without it, the frontend is isolated on the local `gecko-notes_default` network and unreachable from the reverse proxy (resulting in 502 errors). The `COMPOSE_FILE` setting automates this so it's never forgotten.

