"""FBEM MCP server — exposes the Facebook native-composer bridge as MCP tools so
any MCP-capable agent (Claude Code/Desktop, Cursor, …) can crawl/snapshot and
publish Reels / Photos.

The bridge (`fbem-bridge`) must be running separately — it holds the persistent
WebSocket to the Chrome extension. This MCP server is a thin stdio layer the
agent host spawns; it calls the bridge over loopback HTTP.

Run:
    fbem-mcp                  # stdio (default)
    python -m fbem.mcp
"""
from __future__ import annotations

import logging

from mcp.server.fastmcp import FastMCP

from .registry import register_all

logger = logging.getLogger("fbem.mcp")

mcp = FastMCP("fbem")
_names = register_all(mcp)
logger.info("FBEM MCP: registered %d tools: %s", len(_names), ", ".join(_names))


def main() -> None:
    """Run the MCP server over stdio (the default transport for local agents)."""
    mcp.run()


if __name__ == "__main__":
    main()
