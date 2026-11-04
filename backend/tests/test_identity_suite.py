"""Notes as a verifier: IDENTITY_PROVIDER=suite (M6).

The suite keeps the accounts and signs the same HS256 token with the same secret, adding
`email` and `is_admin`. These run the real app, middleware and routers against an
in-memory database, with tokens minted the way the suite mints them, and pin:

- someone Notes has never seen gets a row (and their default settings) on first sight;
- the token's claims keep that row current, and a Notes-minted token (no email, no admin
  claim) leaves those fields alone;
- every route that creates or changes an account answers 410 pointing at the suite, and
  works as before with IDENTITY_PROVIDER=notes;
- the admin split: data views stay, account actions move.
"""

from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from starlette.testclient import TestClient

from app import identity
from app.auth import ALGORITHM, SECRET_KEY, hash_password
from app.database import get_session
from app.limiter import limiter
from app.main import app
from app.models import User, UserSetting

SUITE = "https://suite.example.test"


def suite_token(sub, username, email=None, is_admin=None):
    """What the suite's `tokens.session_token` mints."""
    claims = {"sub": sub, "username": username, "exp": datetime.now(timezone.utc) + timedelta(days=1)}
    if email is not None:
        claims["email"] = email
    if is_admin is not None:
        claims["is_admin"] = is_admin
    return jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture
def client(engine, monkeypatch):
    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setenv("IDENTITY_PROVIDER", "suite")
    monkeypatch.setenv("SUITE_PUBLIC_URL", SUITE)
    limiter.reset()
    yield TestClient(app, base_url="https://testserver")
    app.dependency_overrides.clear()


def add_local(engine, user_id, username, email, *, admin=False):
    with Session(engine) as s:
        s.add(User(id=user_id, username=username, email=email, hashed_password=hash_password("pw-123456789"),
                   is_admin=admin, email_verified=True, created_at=datetime.utcnow()))
        s.commit()


# ─── shadow rows ─────────────────────────────────────────────────────────────


def test_someone_new_gets_a_row_and_their_settings_on_first_sight(client, engine):
    res = client.get("/api/auth/me", headers=bearer(suite_token("u-new", "newbie", "new@example.test", False)))
    assert res.status_code == 200, res.text
    assert (res.json()["id"], res.json()["username"], res.json()["email"]) == ("u-new", "newbie", "new@example.test")
    with Session(engine) as s:
        user = s.get(User, "u-new")
        assert user.hashed_password == ""  # nothing can sign in to it here
        assert s.exec(select(UserSetting).where(UserSetting.user_id == "u-new")).first() is not None


def test_the_claims_keep_the_row_current(client, engine):
    add_local(engine, "u1", "old-name", "old@example.test")
    token = suite_token("u1", "new-name", "new@example.test", True)
    me = client.get("/api/auth/me", headers=bearer(token)).json()
    assert (me["username"], me["email"], me["is_admin"]) == ("new-name", "new@example.test", True)


def test_a_notes_minted_token_leaves_email_and_admin_alone(client, engine):
    add_local(engine, "u1", "gecko", "gecko@example.test", admin=True)
    me = client.get("/api/auth/me", headers=bearer(suite_token("u1", "gecko"))).json()
    assert (me["email"], me["is_admin"]) == ("gecko@example.test", True)


def test_a_name_someone_else_holds_here_does_not_fail_the_request(client, engine):
    add_local(engine, "local-1", "gecko", "local@example.test")
    res = client.get("/api/auth/me", headers=bearer(suite_token("u-suite", "gecko", "local@example.test")))
    assert res.status_code == 200
    body = res.json()
    assert body["username"].startswith("gecko-") and body["email"] == "u-suite@users.invalid"


def test_notes_mode_creates_nobody(client, engine, monkeypatch):
    monkeypatch.setenv("IDENTITY_PROVIDER", "notes")
    res = client.get("/api/auth/me", headers=bearer(suite_token("ghost", "ghost", "g@example.test")))
    assert res.status_code == 404
    with Session(engine) as s:
        assert s.get(User, "ghost") is None


# ─── what moved to the suite ─────────────────────────────────────────────────

MOVED = [
    ("post", "/api/auth/register", {"username": "x", "email": "x@example.test", "password": "pw-123456789"}),
    ("post", "/api/auth/login", {"username": "x", "password": "y"}),
    ("post", "/api/auth/login/2fa", {"challenge_token": "x", "code": "1"}),
    ("post", "/api/auth/verify-email", {"token": "x"}),
    ("post", "/api/auth/resend-verification", {"email": "x@example.test"}),
    ("post", "/api/auth/forgot-password", {"email": "x@example.test"}),
    ("post", "/api/auth/reset-password", {"token": "x", "new_password": "pw-123456789"}),
    ("post", "/api/auth/me/change-password", {"current_password": "x", "new_password": "pw-123456789"}),
    ("post", "/api/auth/2fa/totp/setup", None),
    ("post", "/api/auth/2fa/totp/enable", {"secret": "x", "code": "1"}),
    ("post", "/api/auth/2fa/email/setup", None),
    ("post", "/api/auth/2fa/email/verify", {"code": "1"}),
    ("post", "/api/auth/2fa/disable", {"password": "x"}),
    ("patch", "/api/users/someone", {"is_admin": True}),
    ("post", "/api/users/someone/reset-password", {"new_password": "pw-123456789"}),
    ("delete", "/api/users/someone", None),
]


@pytest.mark.parametrize("method, path, body", MOVED, ids=[f"{m} {p}" for m, p, _ in MOVED])
def test_account_routes_point_at_the_suite(client, engine, method, path, body):
    add_local(engine, "admin", "admin", "admin@example.test", admin=True)
    kwargs = {"headers": bearer(suite_token("admin", "admin", "admin@example.test", True))}
    if body is not None:
        kwargs["json"] = body
    res = getattr(client, method)(path, **kwargs)
    assert res.status_code == 410, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "managed_by_suite" and SUITE in detail["message"]


def test_in_notes_mode_sign_in_works_as_before(client, engine, monkeypatch):
    monkeypatch.setenv("IDENTITY_PROVIDER", "notes")
    add_local(engine, "u1", "gecko", "gecko@example.test")
    res = client.post("/api/auth/login", json={"username": "gecko", "password": "pw-123456789"})
    assert res.status_code == 200 and res.json()["access_token"]


def test_the_avatar_stays_editable_but_name_and_email_do_not(client, engine):
    add_local(engine, "u1", "gecko", "gecko@example.test")
    headers = bearer(suite_token("u1", "gecko", "gecko@example.test"))
    assert client.patch("/api/auth/me", json={"avatar_url": "/media/me.png"}, headers=headers).status_code == 200
    assert client.patch("/api/auth/me", json={"username": "other"}, headers=headers).status_code == 410
    # Sending back the values it already has is not a change (the profile form does this).
    assert client.patch("/api/auth/me", json={"username": "gecko", "email": "gecko@example.test",
                                              "avatar_url": None}, headers=headers).status_code == 200


def test_reading_the_account_and_trading_the_cookie_still_work(client, engine):
    add_local(engine, "u1", "gecko", "gecko@example.test")
    token = suite_token("u1", "gecko", "gecko@example.test")
    client.cookies.set("gecko_session", token)
    res = client.get("/api/auth/session")
    assert res.status_code == 200 and res.json()["user"]["id"] == "u1"
    assert client.get("/api/auth/2fa/status", headers=bearer(token)).status_code == 200
    assert client.post("/api/auth/logout").status_code == 204


def test_admin_data_views_stay(client, engine):
    add_local(engine, "admin", "admin", "admin@example.test", admin=True)
    headers = bearer(suite_token("admin", "admin", "admin@example.test", True))
    assert client.get("/api/users", headers=headers).status_code == 200
    assert client.get("/api/users/admin/metrics", headers=headers).status_code == 200


def test_the_config_tells_the_login_screen_where_to_send_people(client, monkeypatch):
    body = client.get("/api/config").json()
    assert (body["identity_provider"], body["identity_url"]) == ("suite", SUITE)
    monkeypatch.setenv("IDENTITY_PROVIDER", "notes")
    body = client.get("/api/config").json()
    assert (body["identity_provider"], body["identity_url"]) == ("notes", None)


# ─── startup ─────────────────────────────────────────────────────────────────


def test_startup_refuses_suite_mode_with_nowhere_to_send_people(monkeypatch):
    monkeypatch.setenv("IDENTITY_PROVIDER", "suite")
    monkeypatch.delenv("SUITE_PUBLIC_URL", raising=False)
    monkeypatch.delenv("SUITE_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="SUITE_PUBLIC_URL"):
        identity.validate()
    monkeypatch.setenv("IDENTITY_PROVIDER", "suit")
    with pytest.raises(RuntimeError, match='"notes" or "suite"'):
        identity.validate()
