"""MCP tool: bridge + extension health."""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge


@tool(
    name="health",
    description=(
        "Bridge + extension health: is the bridge up, is the Chrome extension "
        "connected, are the reel/photo templates captured, and tab freshness/TTL."
    ),
)
async def health() -> dict:
    """Return the bridge ``/api/health`` payload (connection, templates, capture
    activity, tab TTL)."""
    return await bridge.health()
