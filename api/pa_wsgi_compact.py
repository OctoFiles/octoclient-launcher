#!/usr/bin/env python3
"""WSGI entry point for the OctoClient cosmetics API.

Upload this file together with ``octoclient_app.py`` and point the PythonAnywhere
WSGI configuration at ``application``. The friends API has been removed.
"""

from octoclient_app import application  # noqa: F401
