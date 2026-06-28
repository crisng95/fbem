"""MCP tool: crawler / snapshot status — what's captured and what needs a (re)snapshot."""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge
from ..bridge_api import BridgeError


@tool(
    name="capture_status",
    description=(
        "Crawler/snapshot status: which native templates are captured (reel / "
        "photo / profile-switch), whether you're ready to post, and exactly what to "
        "do if a (re)snapshot is needed. The crawler captures passively when you "
        "post by hand on facebook.com — re-snapshot only when Facebook rotates its "
        "payload and replay starts failing."
    ),
)
async def capture_status() -> dict:
    """Inspect captured templates and report readiness + capture guidance."""
    try:
        h = await bridge.health()
    except BridgeError as exc:
        return {
            "bridge_up": False,
            "error": str(exc),
            "hint": "Start the bridge first: `fbem-bridge`.",
        }

    try:
        tpl = await bridge.template()
    except BridgeError:
        tpl = {}
    ops = tpl.get("graphql_ops") or {} if isinstance(tpl, dict) else {}

    has_reel = bool(isinstance(tpl, dict) and tpl.get("graphql"))
    has_photo = bool(isinstance(tpl, dict) and tpl.get("graphql_photo"))
    has_switch = "CometProfileSwitchMutation" in ops

    needs = []
    if not has_reel:
        needs.append("reel: manually post ONE Reel on facebook.com to seed the template")
    if not has_photo:
        needs.append("photo: manually post ONE photo/album on facebook.com to seed the template")
    if not has_switch:
        needs.append("switch_profile: manually switch page once on facebook.com to seed the template")

    connected = bool(h.get("extension_connected"))
    return {
        "bridge_up": True,
        "extension_connected": connected,
        "tab_active": h.get("tab_active"),
        "ttl_remaining_s": h.get("ttl_remaining_s"),
        "stale": h.get("stale"),
        "templates": {"reel": has_reel, "photo": has_photo, "switch_profile": has_switch},
        "ready_to_post_reel": connected and has_reel,
        "ready_to_post_photos": connected and has_photo,
        "needs_capture": needs,
        "how_to_capture": (
            "With the extension loaded and the bridge running, perform the action "
            "ONCE by hand on facebook.com; the crawler snapshots it into the "
            "template automatically. No code change is ever needed — re-capture only "
            "when Facebook rotates its payload and replay starts failing."
        ),
    }
