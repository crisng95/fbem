"""Entry point: run the FBEM bridge (FastAPI HTTP API + extension WebSocket).

    python -m fbem.bridge
    fbem-bridge            # console-script entry point

Host is fixed to loopback (127.0.0.1) — this tool must never be network-reachable.
"""
from __future__ import annotations

import uvicorn

from .config import HTTP_PORT


def main() -> None:
    uvicorn.run("fbem.bridge.server:app", host="127.0.0.1", port=HTTP_PORT, log_level="info")


if __name__ == "__main__":
    main()
