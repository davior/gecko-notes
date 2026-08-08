"""Transactional email sending.

Provider-agnostic SMTP over the stdlib `smtplib`, configured entirely from
environment variables (see .env.example). Bodies are authored as Markdown +
Jinja2 templates under ./templates and sent as multipart/alternative
(plaintext = the rendered Markdown source, HTML = Markdown converted and wrapped
in a small responsive layout).

Sending is best-effort: failures are logged, never raised, so a flaky mail
server can't 500 a registration. When SMTP is not configured, `send_template`
logs the actionable link/code instead — so verification, password reset and
email-2FA remain exercisable in local development without a mail server.
"""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, Optional

import markdown as _markdown
from fastapi import BackgroundTasks
from jinja2 import Environment, FileSystemLoader, select_autoescape

logger = logging.getLogger(__name__)

APP_NAME = "Gecko Notes"
_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)


def _getenv(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def email_enabled() -> bool:
    """Email features are active only when a host and from-address are configured."""
    return bool(_getenv("SMTP_HOST") and _getenv("SMTP_FROM"))


def app_base_url() -> str:
    """Public origin used to build links in emails (no trailing slash)."""
    return _getenv("APP_BASE_URL", "http://localhost:5173").rstrip("/")


def _smtp_settings() -> Dict[str, Any]:
    try:
        port = int(_getenv("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    return {
        "host": _getenv("SMTP_HOST"),
        "port": port,
        "username": _getenv("SMTP_USERNAME"),
        "password": _getenv("SMTP_PASSWORD"),
        "sender": _getenv("SMTP_FROM"),
        "use_ssl": _getenv("SMTP_SSL", "false").lower() in ("1", "true", "yes"),
        "use_starttls": _getenv("SMTP_STARTTLS", "true").lower() in ("1", "true", "yes"),
        "timeout": int(_getenv("SMTP_TIMEOUT", "20") or "20"),
    }


def _render(template_name: str, context: Dict[str, Any]) -> tuple[str, str]:
    """Return (plaintext, html) for a Markdown+Jinja2 template."""
    ctx = {"app_name": APP_NAME, "base_url": app_base_url(), **context}
    md_text = _env.get_template(template_name).render(**ctx)
    body_html = _markdown.markdown(md_text, extensions=["extra"])
    html = _env.get_template("layout.html").render(content=body_html, **ctx)
    return md_text, html


def _send_now(to: str, subject: str, text_body: str, html_body: str) -> None:
    cfg = _smtp_settings()
    if not (cfg["host"] and cfg["sender"]):
        logger.warning("Email not sent to %s (SMTP not configured): %s", to, subject)
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = cfg["sender"]
    msg["To"] = to
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        if cfg["use_ssl"]:
            server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=cfg["timeout"])
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=cfg["timeout"])
        with server:
            server.ehlo()
            if cfg["use_starttls"] and not cfg["use_ssl"]:
                server.starttls()
                server.ehlo()
            if cfg["username"]:
                server.login(cfg["username"], cfg["password"])
            server.sendmail(cfg["sender"], [to], msg.as_string())
        logger.info("Sent email to %s: %s", to, subject)
    except Exception:
        logger.exception("Failed to send email to %s: %s", to, subject)


def send_template(
    to: str,
    template_name: str,
    subject: str,
    context: Dict[str, Any],
    background_tasks: Optional[BackgroundTasks] = None,
) -> None:
    """Render and dispatch a templated email.

    When email is disabled, logs the actionable link/code (dev affordance) and
    returns. When enabled, sends in the background if a BackgroundTasks is given,
    else synchronously (still best-effort)."""
    if not email_enabled():
        hint = (
            context.get("verify_url")
            or context.get("reset_url")
            or context.get("code")
        )
        logger.warning(
            "Email disabled — would send '%s' to %s. Actionable value: %s",
            subject, to, hint,
        )
        return

    text_body, html_body = _render(template_name, context)
    if background_tasks is not None:
        background_tasks.add_task(_send_now, to, subject, text_body, html_body)
    else:
        _send_now(to, subject, text_body, html_body)
