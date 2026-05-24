# gecko-notes — Claude Instructions

## On PR Merge

Whenever a `<github-webhook-activity>` event indicates a PR has been merged, automatically output the following production deployment instructions:

---

**Deploy to production** (run on the server from the repo root):

```bash
git pull origin main
docker compose up --build -d
```

**Verify the deployment:**

```bash
docker compose ps
curl -f http://localhost:${APP_PORT:-8080}/api/health
```

**Notes:**
- `data/db/` and `data/media/` are bind-mounted volumes — they survive rebuilds, no data migration needed.
- Database schema migrations run automatically on backend startup (`init_db()` in `database.py`).
- `JWT_SECRET_KEY` must be set in `.env`; app will refuse to start without it.
- Default port is `8080` unless overridden via `APP_PORT` in `.env`.
