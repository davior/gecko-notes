"""Shared test setup.

`app.auth` refuses to import without a strong JWT_SECRET_KEY, and `app.schemas` imports
it, so almost anything under `app.` is unimportable until this is set. conftest is loaded
before test modules are collected, which is early enough. Only fills in a value when the
environment doesn't already provide one.
"""

import os

os.environ.setdefault("JWT_SECRET_KEY", "test-only-secret-not-used-outside-the-test-suite")
