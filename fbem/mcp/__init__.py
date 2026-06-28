"""FBEM MCP server — exposes the Facebook native-composer bridge as MCP tools.

Thin stdio layer that any MCP-capable agent spawns; it calls the persistent
`fbem-bridge` over loopback HTTP. See fbem/mcp/server.py and CONTRIBUTING.md.
"""
