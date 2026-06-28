"""TEMPLATE for a new FBEM MCP tool.

COPY this file to ``my_tool.py``, rename ``example_tool`` to your tool name, and
edit. Discovery skips modules whose names start with ``_``, so this template is
never registered.

Contract for a tool:
  • exactly one async function, decorated with ``@tool()``
  • type-hint EVERY argument — the JSON schema agents see is derived from them
  • the first docstring line is the agent-facing summary (or pass ``description=``)
  • return a JSON-serializable ``dict``
  • reach Facebook/the browser ONLY through ``bridge`` (never hardcode tokens)
  • raise ``BridgeError`` (or let it propagate) on failure
"""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge  # noqa: F401  (import here; use in your tool)


@tool()  # name defaults to the function name; description defaults to the docstring
async def example_tool(message: str, times: int = 1) -> dict:
    """One-line summary the agent reads. Describe what it does and when to use it.

    Args:
        message: What to echo.
        times: How many times to repeat it.
    """
    # Example only. Replace with a real bridge call, e.g.:
    #   return await bridge.health()
    return {"echo": message * times}
