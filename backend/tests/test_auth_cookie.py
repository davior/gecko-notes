"""Tests for the parent-domain SSO cookie (GN-1).

Login sets an HttpOnly `gecko_session` cookie alongside the existing JSON token, the
auth middleware accepts it as a fallback behind the `Authorization: Bearer` header,
and logout clears it. Because a cookie is an ambient credential the browser attaches
on its own, a cookie-authenticated write is only accepted from a known Origin/Referer
(header-authenticated requests are exempt, since a cross-site page can't attach one).

Runs the real app (`app.main.app`) — including the real middleware and the real
`auth` router — with `get_session` overridden onto an isolated in-memory database, so
this exercises actual login/logout/middleware behavior rather than a substitute.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine
from starlette.testclient import TestClient

import app.main as main_module
from app.auth import ACCESS_TOKEN_EXPIRE_DAYS, hash_password
from app.database import get_session
from app.limiter import limiter
from app.main import app
from app.models import User
from app.routers import auth as auth_router

USERNAME = "gecko"
PASSWORD = "correct-horse-battery"
ALLOWED_ORIGIN = "https://notes.geckopico.com"
FOREIGN_ORIGIN = "https://evil.example"


def _make_user(session: Session, *, user_id: str, username: str) -> None:
    session.add(User(
        id=user_id,
        username=username,
        email=f"{username}@example.com",
        hashed_password=hash_password(PASSWORD),
        email_verified=True,
        created_at=datetime.now(timezone.utc),
    ))
    session.commit()


@pytest.fixture
def engine():
    # StaticPool: a bare "sqlite://" URL otherwise hands out a fresh, empty
    # in-memory database to every new connection, which would lose state (e.g. the
    # seeded user) between requests within the same test.
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture
def client(engine, monkeypatch):
    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    # Deterministic CSRF allowlist, independent of the ambient CORS_ORIGIN env var.
    monkeypatch.setattr(main_module, "_cors_origins", [ALLOWED_ORIGIN])
    # Each test logs in at least once; the login limiter is process-global (keyed by
    # client IP), so without a reset the 5/minute cap would bleed across tests.
    limiter.reset()

    with Session(engine) as session:
        _make_user(session, user_id="user-1", username=USERNAME)

    # Deliberately not used as a context manager: that would run app.main's real
    # lifespan (init_db, background workers) against the real on-disk database,
    # which get_session's override above is precisely trying to avoid touching.
    # base_url is https:// because the cookie is Secure by default (AUTH_COOKIE_SECURE
    # defaults to true) — a compliant cookie jar (httpx's included) won't resend a
    # Secure cookie over plain http, which is exactly what a real browser does too.
    test_client = TestClient(app, base_url="https://testserver")
    yield test_client
    app.dependency_overrides.clear()


def _login(client: TestClient, username: str = USERNAME):
    return client.post("/api/auth/login", json={"username": username, "password": PASSWORD})


# ─── Cookie set on login ────────────────────────────────────────────────────────


def test_login_sets_the_session_cookie(client):
    res = _login(client)
    assert res.status_code == 200
    set_cookie = res.headers.get("set-cookie", "")
    assert "gecko_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert f"Max-Age={ACCESS_TOKEN_EXPIRE_DAYS * 24 * 3600}" in set_cookie
    # The cookie carries the same token returned in the JSON body.
    assert res.cookies.get("gecko_session") == res.json()["access_token"]


def test_no_cookie_domain_configured_means_no_domain_attribute(client, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_COOKIE_DOMAIN", None)
    res = _login(client)
    assert "Domain=" not in res.headers.get("set-cookie", "")


def test_a_configured_cookie_domain_is_sent(client, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_COOKIE_DOMAIN", ".geckopico.com")
    res = _login(client)
    assert "Domain=.geckopico.com" in res.headers.get("set-cookie", "")


# ─── Precedence: header over cookie ─────────────────────────────────────────────


def test_cookie_only_request_authenticates(client):
    _login(client)  # the client's cookie jar now holds gecko_session
    res = client.get("/api/auth/me")  # no Authorization header sent
    assert res.status_code == 200
    assert res.json()["username"] == USERNAME


def test_header_wins_over_a_differing_cookie(client, engine):
    token_1 = _login(client).json()["access_token"]
    with Session(engine) as session:
        _make_user(session, user_id="user-2", username="other")
    # Logging in as "other" overwrites the jar's cookie with user-2's token.
    _login(client, username="other")

    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_1}"})
    assert res.status_code == 200
    assert res.json()["username"] == USERNAME  # the header's user, not the cookie's


# ─── Logout ──────────────────────────────────────────────────────────────────────


def test_logout_clears_the_cookie(client):
    _login(client)
    assert client.cookies.get("gecko_session")

    logout_res = client.post("/api/auth/logout")
    assert logout_res.status_code == 204
    assert client.cookies.get("gecko_session") is None

    res = client.get("/api/auth/me")
    assert res.status_code == 401


# ─── CSRF guard on the cookie path ──────────────────────────────────────────────


def test_cookie_write_from_a_foreign_origin_is_refused(client):
    _login(client)
    res = client.patch(
        "/api/auth/me", json={"avatar_url": "https://x.test/a.png"},
        headers={"Origin": FOREIGN_ORIGIN},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "forbidden_origin"


def test_cookie_write_with_no_origin_is_refused(client):
    """Fail closed: a same-origin browser write always sends an Origin or Referer."""
    _login(client)
    res = client.patch("/api/auth/me", json={"avatar_url": "https://x.test/a.png"})
    assert res.status_code == 403


def test_cookie_read_from_a_foreign_origin_is_allowed(client):
    """Safe methods change nothing, so the CSRF guard doesn't apply to them."""
    _login(client)
    res = client.get("/api/auth/me", headers={"Origin": FOREIGN_ORIGIN})
    assert res.status_code == 200


def test_header_write_from_a_foreign_origin_is_allowed(client):
    """A cross-site page can't attach a Bearer header, so header auth is exempt."""
    token = _login(client).json()["access_token"]
    client.cookies.clear()  # only the header carries auth on this request
    res = client.patch(
        "/api/auth/me", json={"avatar_url": "https://x.test/a.png"},
        headers={"Authorization": f"Bearer {token}", "Origin": FOREIGN_ORIGIN},
    )
    assert res.status_code == 200
