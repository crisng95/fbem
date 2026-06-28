"""MCP tool: publish a native Facebook photo or album."""
from __future__ import annotations

from ..registry import tool
from .. import bridge_api as bridge


@tool(
    description=(
        "Publish a Facebook photo (1 image) or album (N images) from local files "
        "via the browser extension (native web API, NOT the Graph API). Requires "
        "the bridge running, a logged-in facebook.com tab, and a captured photo "
        "template (see capture_status)."
    )
)
async def post_photos(
    image_paths: list[str],
    caption: str,
    page_id: str | None = None,
    scheduled_publish_time: int | None = None,
) -> dict:
    """Upload and publish a photo or album.

    Args:
        image_paths: Absolute paths to local .jpg/.png files. One = a single photo; many = an album.
        caption: Full caption text (including hashtags).
        page_id: Optional Facebook page id to post as.
        scheduled_publish_time: Optional epoch SECONDS to schedule; omit to publish now.
    Returns: ``{ ok, postId, photoIds, permalinkUrl }``.
    """
    return await bridge.post_photos(image_paths, caption, page_id, scheduled_publish_time)
