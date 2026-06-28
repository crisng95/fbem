"""Local config + paths for the FBEM Facebook bridge.

Ports MUST match what the Chrome extension hardcodes (extension/background.js):
  AGENT_WS_URL = ws://127.0.0.1:9224
  CALLBACK_URL = http://127.0.0.1:47102/api/ext/callback
Don't change these unless you also rebuild the extension.

The WS endpoint is unauthenticated by design (loopback-only); see the loopback
enforcement in server.py.

Env (all optional; sensible loopback defaults):
  FBEM_HTTP_PORT      HTTP API port              (default 47102)
  FBEM_WS_HOST        WS bind host (loopback)     (default 127.0.0.1)
  FBEM_WS_PORT        extension WS port           (default 9224)
  FBEM_HOME           base dir for state          (default ~/.fbem)
  FBEM_CAPTURES_DIR   captured templates dir      (default $FBEM_HOME/captures)
  FBEM_MEDIA_DIR      media served to the ext     (default $FBEM_HOME/media)
"""
from __future__ import annotations

import os
from pathlib import Path


def _env(name: str, default: str) -> str:
    """Value of env var `name` if set and non-empty, else `default`."""
    v = os.getenv(name)
    return v if v else default


HTTP_PORT = int(_env("FBEM_HTTP_PORT", default="47102"))
WS_HOST = _env("FBEM_WS_HOST", default="127.0.0.1")
EXTENSION_WS_PORT = int(_env("FBEM_WS_PORT", default="9224"))


def home_dir() -> Path:
    base = _env("FBEM_HOME", default="")
    return Path(base).expanduser().resolve() if base else (Path.home() / ".fbem")


def captures_dir() -> Path:
    """Where the bridge stores captured native templates. These contain live FB
    tokens — keep private. Point FBEM_CAPTURES_DIR at an existing captures dir to
    reuse a template without re-snapshotting."""
    d = _env("FBEM_CAPTURES_DIR", default="")
    return Path(d).expanduser().resolve() if d else (home_dir() / "captures")


def media_dir() -> Path:
    """Where the bridge serves media (mp4/jpg/png) to the extension over
    loopback. The MCP stages files here before posting."""
    d = _env("FBEM_MEDIA_DIR", default="")
    return Path(d).expanduser().resolve() if d else (home_dir() / "media")
