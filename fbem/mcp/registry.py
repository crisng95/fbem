"""Tool registry for the FBEM MCP server.

Contributors add a tool by dropping ONE file in ``fbem/mcp/tools/`` that defines
a typed async function decorated with ``@tool()``. It is auto-discovered and
registered — no central file to edit. The JSON input schema agents see is derived
from the function's type hints; the description defaults to its docstring.

See ``fbem/mcp/tools/_template.py`` and CONTRIBUTING.md.
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class ToolSpec:
    fn: Callable[..., Any]
    name: str
    description: str


_REGISTRY: list[ToolSpec] = []


def tool(name: str | None = None, description: str | None = None) -> Callable[[Callable], Callable]:
    """Decorator: register an async function as an MCP tool.

    Args:
        name: Tool name agents call (defaults to the function name).
        description: Human/agent-facing description (defaults to the docstring).
    """
    def decorator(fn: Callable) -> Callable:
        _REGISTRY.append(
            ToolSpec(
                fn=fn,
                name=name or fn.__name__,
                description=(description or fn.__doc__ or "").strip(),
            )
        )
        return fn

    return decorator


def discover() -> None:
    """Import every non-underscore module under ``fbem.mcp.tools`` so their
    ``@tool`` decorators run and populate the registry."""
    from . import tools as tools_pkg

    for mod in pkgutil.iter_modules(tools_pkg.__path__):
        if not mod.name.startswith("_"):
            importlib.import_module(f"{tools_pkg.__name__}.{mod.name}")


def register_all(mcp: Any) -> list[str]:
    """Discover tools and register each with the FastMCP instance.

    Returns the list of registered tool names (in discovery order).
    """
    _REGISTRY.clear()
    discover()
    for spec in _REGISTRY:
        # The FastMCP decorator derives the input schema from `fn`'s type hints.
        mcp.tool(name=spec.name, description=spec.description)(spec.fn)
    return [spec.name for spec in _REGISTRY]
