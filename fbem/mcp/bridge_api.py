"""Async HTTP client to the FBEM bridge (:47102).

The MCP tools call these helpers; the bridge then drives the Chrome extension to
perform the action inside the live facebook.com session and returns the result.
Base URL: ``$FBEM_BRIDGE_URL`` (default ``http://127.0.0.1:47102``).
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from urllib.parse import quote

import httpx

from ..bridge.config import media_dir

_VIDEO_EXTS = {".mp4"}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


class BridgeError(RuntimeError):
    """The bridge returned an error, or could not be reached."""


def base_url() -> str:
    return os.getenv("FBEM_BRIDGE_URL", "http://127.0.0.1:47102").rstrip("/")


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict) and body.get("detail"):
            return str(body["detail"])
    except Exception:  # noqa: BLE001
        pass
    return resp.text[:300]


async def _get(path: str, timeout: float = 5.0) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{base_url()}{path}")
    except httpx.HTTPError as exc:
        raise BridgeError(
            f"bridge unreachable at {base_url()} ({exc}); is `fbem-bridge` running?"
        ) from exc
    if resp.status_code >= 400:
        raise BridgeError(f"GET {path} -> {resp.status_code}: {_detail(resp)}")
    return resp.json()


async def _post(path: str, body: dict, timeout: float) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(f"{base_url()}{path}", json=body)
    except httpx.HTTPError as exc:
        raise BridgeError(
            f"bridge unreachable at {base_url()} ({exc}); is `fbem-bridge` running?"
        ) from exc
    if resp.status_code >= 400:
        raise BridgeError(f"POST {path} -> {resp.status_code}: {_detail(resp)}")
    return resp.json()


def _stage_media(local_path: str, *, kind: str) -> str:
    """Copy a local file into the bridge's served media dir (if not already
    there) and return the loopback URL the extension fetches. The bridge serves
    basename-only from FBEM_MEDIA_DIR (no traversal), so we stage by name."""
    src = Path(local_path).expanduser().resolve()
    if not src.is_file():
        raise BridgeError(f"file_not_found: {src}")
    exts = _VIDEO_EXTS if kind == "local-video" else _IMAGE_EXTS
    if src.suffix.lower() not in exts:
        raise BridgeError(
            f"unsupported_file_type {src.suffix!r} for {kind} (allowed: {sorted(exts)})"
        )
    mdir = media_dir()
    mdir.mkdir(parents=True, exist_ok=True)
    dest = mdir / src.name
    if src != dest:
        shutil.copy2(src, dest)
    return f"{base_url()}/{kind}?name={quote(src.name)}"


# ── high-level calls (mirror the bridge HTTP API) ────────────────────────────
async def health() -> dict:
    return await _get("/api/health")


async def template() -> dict:
    return await _get("/api/template")


async def post_reel(
    video_path: str,
    caption: str,
    page_id: str | None = None,
    scheduled_publish_time: int | None = None,
) -> dict:
    body: dict = {"videoUrl": _stage_media(video_path, kind="local-video"), "caption": caption}
    if page_id:
        body["pageId"] = page_id
    if scheduled_publish_time is not None:
        body["scheduledPublishTime"] = scheduled_publish_time
    return await _post("/post-reel", body, timeout=300.0)


async def post_photos(
    image_paths: list[str],
    caption: str,
    page_id: str | None = None,
    scheduled_publish_time: int | None = None,
) -> dict:
    urls = [_stage_media(p, kind="local-image") for p in image_paths]
    body: dict = {"imageUrls": urls, "caption": caption}
    if page_id:
        body["pageId"] = page_id
    if scheduled_publish_time is not None:
        body["scheduledPublishTime"] = scheduled_publish_time
    return await _post("/post-photos", body, timeout=310.0)


async def switch_profile(target_id: str) -> dict:
    return await _post("/switch-profile", {"targetId": target_id}, timeout=60.0)


async def current_identity() -> dict:
    return await _get("/api/current-identity", timeout=20.0)
