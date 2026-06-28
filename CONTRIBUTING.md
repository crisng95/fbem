# Contributing to FBEM

The point of FBEM is that **adding a capability is one small file**. This guide is
the format to follow.

## The tool contract

A tool is one file in `fbem/mcp/tools/` that defines **one async function**
decorated with `@tool()`. It is auto-discovered and registered at startup — there
is no central file to edit.

```python
# fbem/mcp/tools/my_tool.py
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge


@tool()  # name → function name; description → docstring (override with @tool(name=, description=))
async def my_tool(thing: str, count: int = 1) -> dict:
    """One-line summary the agent reads. Say what it does and when to use it.

    Args:
        thing: What to act on.
        count: How many times.
    """
    return await bridge.health()  # talk to FB ONLY through `bridge`
```

Rules:

1. **One async function per file**, decorated with `@tool()`.
2. **Type-hint every argument.** The JSON schema agents see is derived from the
   hints. Untyped args break the schema.
3. **Docstring = description.** The docstring is what the agent reads to decide
   when to call your tool. Make the first line a crisp summary. (Or pass
   `description=` to `@tool()`.)
4. **Return a JSON-serializable `dict`.**
5. **Reach Facebook/the browser only through `bridge_api`.** Never hardcode tokens
   or call facebook.com directly from a tool. If you need a new capability the
   bridge doesn't expose, add a bridge endpoint first (see below).
6. **Fail loudly.** Raise `bridge_api.BridgeError` (or let it propagate) on error.
7. **Filenames starting with `_` are skipped** by discovery (that's why
   `_template.py` is never registered). Don't prefix a real tool with `_`.

### Quick start

```sh
cp fbem/mcp/tools/_template.py fbem/mcp/tools/my_tool.py
# rename the function, edit the body + docstring
```

Verify it registered:

```sh
.venv/bin/python -c "from fbem.mcp.server import _names; print(_names)"
# my_tool should appear in the list
```

## How registration works

`fbem/mcp/registry.py` provides the `@tool` decorator and a discovery loader.
At startup, `fbem/mcp/server.py` calls `register_all(mcp)`, which:

1. imports every non-`_` module in `fbem/mcp/tools/` (running their `@tool`
   decorators, which append to a registry), then
2. registers each with the FastMCP instance, deriving the input schema from the
   function's type hints.

So a contributor only needs to know **one decorated function**. No wiring.

## Adding a new bridge capability (advanced)

If a tool needs something the bridge can't do yet:

1. Add the WS method in `fbem/bridge/bridge_client.py` (and the matching handler in
   the extension's `background.js` / `injected.js`).
2. Expose it as an HTTP route in `fbem/bridge/server.py`.
3. Add a thin helper in `fbem/mcp/bridge_api.py`.
4. Then write the one-file tool that calls that helper.

Keep the extension's crawler **passive** — never block or mutate real user
requests; only snapshot them.

## Local development

```sh
python3.11 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/ruff check fbem        # lint
.venv/bin/python -c "import fbem.mcp.server"   # smoke: server imports + tools register
```

Run the two processes in separate terminals while developing:

```sh
.venv/bin/fbem-bridge            # terminal 1 (persistent)
.venv/bin/fbem-mcp               # terminal 2 (stdio; or let your agent spawn it)
```

## Style

- `ruff`, line length 100, target py311 (configured in `pyproject.toml`).
- Match the surrounding code: clear names, docstrings on public functions, no
  dead code.

## PR checklist

- [ ] One tool per file; function is async, typed, and has a descriptive docstring.
- [ ] Tool talks to FB only via `bridge_api`; no hardcoded tokens.
- [ ] `ruff check fbem` passes.
- [ ] `python -c "import fbem.mcp.server"` registers your tool (it prints in `_names`).
- [ ] No captures, tokens, `.env`, or personal data committed.
