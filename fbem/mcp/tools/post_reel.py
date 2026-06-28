"""MCP tool: publish a native Facebook Reel."""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge


@tool(
    description=(
        "Publish a Facebook Reel from a local .mp4 via the browser extension "
        "(native web API, NOT the Graph API — avoids reach suppression). Requires "
        "the bridge running, a logged-in facebook.com tab, and a captured reel "
        "template (see capture_status)."
    )
)
async def post_reel(
    video_path: str,
    caption: str,
    page_id: str | None = None,
    scheduled_publish_time: int | None = None,
) -> dict:
    """Upload and publish a Reel.

    Args:
        video_path: Absolute path to a local .mp4 to post.
        caption: Full caption text (including hashtags).
        page_id: Optional Facebook page id to post as (bridge's current identity if omitted).
        scheduled_publish_time: Optional epoch SECONDS to schedule; omit to publish now.
    Returns: ``{ ok, videoId, permalinkUrl }``.
    """
    return await bridge.post_reel(video_path, caption, page_id, scheduled_publish_time)
