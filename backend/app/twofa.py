"""Authenticator-app (TOTP) helpers.

Wraps pyotp for secret generation / verification and renders the enrollment QR
code as a PNG data URI so the frontend needs no QR library. Secrets are handled
in plaintext here; callers are responsible for encrypting them at rest via
app.auth.encrypt_api_key before storing on the User row.
"""
import base64
import io

import pyotp
import qrcode

APP_NAME = "Gecko Notes"

# Accept codes from the adjacent time window (±30s) to tolerate clock skew.
_VALID_WINDOW = 1


def generate_secret() -> str:
    """A fresh base32 TOTP secret."""
    return pyotp.random_base32()


def provisioning_uri(secret: str, account_name: str) -> str:
    """otpauth:// URI encoding the secret + issuer, for QR / manual entry."""
    return pyotp.TOTP(secret).provisioning_uri(name=account_name, issuer_name=APP_NAME)


def verify_code(secret: str, code: str) -> bool:
    """True if `code` is currently valid for `secret`."""
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=_VALID_WINDOW)
    except Exception:
        return False


def qr_data_uri(uri: str) -> str:
    """Render an otpauth URI as a `data:image/png;base64,...` string."""
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{encoded}"
