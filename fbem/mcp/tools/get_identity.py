"""MCP tool: read the current acting Facebook page/profile (read-only)."""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge


@tool(
    name="get_identity",
    description=(
        "Read which Facebook page/profile the browser tab currently posts AS "
        "(read-only, no switch). Useful to confirm identity before posting."
    ),
)
async def get_identity() -> dict:
    """Return ``{ id, name }`` of the current acting identity."""
    return await bridge.current_identity()
