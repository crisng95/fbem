"""FBEM bridge — local Facebook native-composer upload bridge to a Chrome extension.

It bridges a Chrome MV3 extension over WebSocket (:9224) + HTTP callback (:47102)
and drives **native Facebook Reel / Photo uploads** that fire the same internal
web API the logged-in user's browser uses (NOT the Graph API), plus a **crawler**
that records the genuine native upload requests when the user manually posts — so
the replay is template-driven and self-healing.

What it exposes (all on 127.0.0.1):
  GET  /api/health         — bridge status (extension connected? templates?)
  POST /post-reel          — { videoUrl, caption, pageId? } → { ok, videoId, permalinkUrl }
  POST /post-photos        — { imageUrls[], caption, pageId? } → { ok, postId, photoIds, permalinkUrl }
  POST /switch-profile     — { targetId } → switch the acting page/profile
  GET  /api/current-identity — page/profile the tab currently posts AS
  POST /api/ext/callback   — extension POSTs responses here (secret-gated)
  POST /api/ext/capture    — extension POSTs recorded native requests here (secret-gated)
  GET  /api/template       — current captured template.json (debug)

Run:
  fbem-bridge            # or: python -m fbem.bridge
Then load the Chrome extension (extension/) and open a logged-in facebook.com tab.

This is a LOCAL CONTENT TOOL — loopback-only, never network-reachable.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi import Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import capture_store
from .config import WS_HOST, media_dir
from .bridge_client import bridge_client
from .ws_server import run_ws_server

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("fbem.bridge")

if WS_HOST not in ("127.0.0.1", "localhost", "::1"):
    raise RuntimeError(
        f"FBEM_WS_HOST must be loopback (got {WS_HOST!r}); the extension WS is "
        "unauthenticated by design and must not be network-reachable."
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    ws_task = asyncio.create_task(run_ws_server(), name="ext-ws-server")
    logger.info("fb-bridge started (ws:9224 + http:47102). Waiting for the Chrome extension…")
    try:
        yield
    finally:
        ws_task.cancel()
        try:
            await ws_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        logger.info("fb-bridge stopped")


app = FastAPI(title="fbem-bridge", version="0.1.0", lifespan=lifespan)

# The crawler/replay run inside facebook.com page context, so their POSTs to the
# loopback sink are cross-origin and trigger a CORS preflight (OPTIONS). The
# server is loopback-only and every mutating route is secret-gated, so reflecting
# any origin is safe here and lets the preflight succeed.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_methods=["*"],
    allow_headers=["*"],
)


class PostReelBody(BaseModel):
    videoUrl: str
    caption: str
    pageId: Optional[str] = None
    scheduledPublishTime: int | None = None


class PostPhotosBody(BaseModel):
    imageUrls: list[str]
    caption: str
    pageId: Optional[str] = None
    scheduledPublishTime: int | None = None


class SwitchProfileBody(BaseModel):
    targetId: str


# How long a tab stays "fresh" before it should be reloaded. The extension
# auto-reloads within this window so a healthy tab never goes stale.
_TAB_TTL_S = int(os.getenv("FBEM_TAB_TTL_S", "7200"))  # 2h


def _ttl_block(last_active_at: Optional[float]) -> dict:
    """Per-service freshness/TTL: anchored to the last (re)load. ttl_remaining_s
    counts down to the next auto-reload; stale=True once it elapses."""
    now = time.time()
    remaining = (
        max(0, int(last_active_at + _TAB_TTL_S - now)) if last_active_at is not None else 0
    )
    return {
        "last_active_at": int(last_active_at) if last_active_at is not None else None,
        "ttl_s": _TAB_TTL_S,
        "ttl_remaining_s": remaining,
        "stale": last_active_at is None or (now - last_active_at) > _TAB_TTL_S,
    }


@app.get("/api/health")
def health() -> dict:
    tpl = capture_store.load_template()
    capture = capture_store.capture_stats()
    # Anchor freshness to the most recent of: explicit reload/connect, or a real
    # captured request (any tab activity keeps it fresh).
    actives = [t for t in (bridge_client.last_active_at, capture["last_capture_at"]) if t]
    ttl = _ttl_block(max(actives) if actives else None)
    return {
        "ok": True,
        "extension_connected": bridge_client.connected,
        "fb_user": bridge_client.fb_user,
        # Proof the extension is live on a logged-in FB tab: it streams captured
        # requests as soon as the tab (re)loads. tab_active flips true on reload.
        "tab_active": capture["tab_active"],
        "last_capture_at": capture["last_capture_at"],
        "captures": capture["captures"],
        # Tab TTL (auto-reload freshness window).
        "last_active_at": ttl["last_active_at"],
        "ttl_s": ttl["ttl_s"],
        "ttl_remaining_s": ttl["ttl_remaining_s"],
        "stale": ttl["stale"],
        "has_template": capture_store.template_complete(tpl),
        "has_photo_template": capture_store.photo_template_complete(tpl),
        "capture": capture,
        "ws_stats": bridge_client.ws_stats,
    }


@app.post("/post-reel")
async def post_reel(body: PostReelBody) -> dict:
    """Publish a native Facebook Reel via the extension. 503 if the extension
    isn't connected; 502 if no template has been captured yet (user must
    real-play one manual upload to seed it)."""
    if not bridge_client.connected:
        raise HTTPException(status_code=503, detail="extension_not_connected — load the Chrome extension")
    if not body.videoUrl.strip():
        raise HTTPException(status_code=400, detail="empty_videoUrl")

    template = capture_store.load_template()
    if not capture_store.template_complete(template):
        raise HTTPException(
            status_code=502,
            detail="no_template_captured — manually post one Reel on facebook.com to seed the "
            "crawler (need BOTH the rupload video-upload and the publish mutation)",
        )

    resp = await bridge_client.post_reel(
        video_url=body.videoUrl.strip(),
        caption=body.caption,
        page_id=body.pageId,
        template=template,
        scheduled_publish_time=body.scheduledPublishTime,
    )
    if resp.get("error"):
        raise HTTPException(status_code=502, detail=str(resp["error"])[:300])

    data = resp.get("data") or {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="invalid_response_data")
    return {
        "ok": True,
        "videoId": data.get("videoId"),
        "permalinkUrl": data.get("permalinkUrl"),
    }


@app.post("/post-photos")
async def post_photos(body: PostPhotosBody) -> dict:
    """Publish a native Facebook photo / album post via the extension. One image
    url = a single photo; many = a multi-photo album (e.g. a comic strip).
    503 if the extension isn't connected; 502 if no photo template captured yet."""
    if not bridge_client.connected:
        raise HTTPException(status_code=503, detail="extension_not_connected — load the Chrome extension")
    urls = [u.strip() for u in body.imageUrls if u and u.strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="empty_imageUrls")

    template = capture_store.load_template()
    if not capture_store.photo_template_complete(template):
        raise HTTPException(
            status_code=502,
            detail="no_photo_template_captured — manually post one photo (and one album) on "
            "facebook.com to seed the crawler (need the ComposerStoryCreateMutation with photo attachments)",
        )

    resp = await bridge_client.post_photos(
        image_urls=urls,
        caption=body.caption,
        page_id=body.pageId,
        template=template,
        scheduled_publish_time=body.scheduledPublishTime,
    )
    if resp.get("error"):
        raise HTTPException(status_code=502, detail=str(resp["error"])[:300])

    data = resp.get("data") or {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="invalid_response_data")
    return {
        "ok": True,
        "postId": data.get("postId"),
        "photoIds": data.get("photoIds"),
        "permalinkUrl": data.get("permalinkUrl"),
    }


@app.post("/switch-profile")
async def switch_profile(body: SwitchProfileBody) -> dict:
    """Switch the browser session to a target profile/page id (then reload). After
    this, posts go out AS that page. 503 if the extension isn't connected."""
    if not bridge_client.connected:
        raise HTTPException(status_code=503, detail="extension_not_connected — load the Chrome extension")
    if not body.targetId.strip():
        raise HTTPException(status_code=400, detail="empty_targetId")
    # The switch needs a captured CometProfileSwitchMutation (full fingerprints);
    # a hand-built body is rejected (profile_switcher_comet_login=null).
    template = capture_store.load_template() or {}
    switch_tpl = (template.get("graphql_ops") or {}).get("CometProfileSwitchMutation")
    resp = await bridge_client.switch_profile(body.targetId.strip(), switch_tpl)
    if resp.get("error"):
        raise HTTPException(status_code=502, detail=str(resp["error"])[:300])
    data = resp.get("data") or {}
    return {
        "ok": True,
        "identityId": data.get("identityId"),
        "identityName": data.get("identityName"),
    }


@app.get("/api/current-identity")
async def current_identity() -> dict:
    """The page/profile the FB tab currently posts AS (read-only — no switch).
    Used to pre-fill the dashboard 'add page' form. 503 if the extension isn't
    connected; 502 if the page couldn't read its identity."""
    if not bridge_client.connected:
        raise HTTPException(status_code=503, detail="extension_not_connected — load the Chrome extension")
    resp = await bridge_client.get_identity()
    if resp.get("error"):
        raise HTTPException(status_code=502, detail=str(resp["error"])[:300])
    data = resp.get("data") or {}
    return {"id": data.get("identityId"), "name": data.get("identityName")}


@app.post("/api/ext/callback")
async def ext_callback(
    body: FastAPIRequest,
    x_callback_secret: str | None = Header(default=None, alias="X-Callback-Secret"),
) -> dict:
    """The extension POSTs its responses here, secret-gated."""
    if not x_callback_secret or not hmac.compare_digest(
        x_callback_secret, bridge_client.callback_secret
    ):
        raise HTTPException(status_code=401, detail="invalid callback secret")
    try:
        payload = await body.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")
    if not isinstance(payload, dict) or "id" not in payload:
        raise HTTPException(status_code=400, detail="missing id")
    return {"ok": bridge_client.resolve_callback(payload)}


@app.post("/api/ext/capture")
async def ext_capture(
    body: FastAPIRequest,
    x_callback_secret: str | None = Header(default=None, alias="X-Callback-Secret"),
) -> dict:
    """The crawler POSTs recorded native upload requests here, secret-gated."""
    if not x_callback_secret or not hmac.compare_digest(
        x_callback_secret, bridge_client.callback_secret
    ):
        raise HTTPException(status_code=401, detail="invalid callback secret")
    try:
        payload = await body.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="capture body must be an object")
    capture_store.save_capture(payload)
    return {"ok": True}


# Reels and images both live in the one FBEM media dir (FBEM_MEDIA_DIR, else
# ~/.fbem/media). The MCP stages files here before posting; the extension fetches
# them over loopback. See fbem/bridge/config.py.
_VIDEO_DIR = media_dir()
_IMAGE_DIR = media_dir()


@app.get("/local-video")
def local_video(name: str) -> FileResponse:
    """Serve a locally-rendered mp4 to the extension over loopback, so the
    page-context fetch avoids cross-origin CORS. Basename-only (no traversal);
    .mp4 only; restricted to the FBEM media dir."""
    p = _VIDEO_DIR / Path(name).name
    if p.suffix != ".mp4" or not p.is_file():
        raise HTTPException(status_code=404, detail="not_found")
    return FileResponse(str(p), media_type="video/mp4")


_IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


@app.get("/local-image")
def local_image(name: str) -> FileResponse:
    """Serve a locally-rendered image to the extension over loopback, so the
    page-context fetch avoids cross-origin CORS. Basename-only (no traversal);
    jpg/png only; restricted to the FBEM media dir."""
    p = _IMAGE_DIR / Path(name).name
    media = _IMAGE_TYPES.get(p.suffix.lower())
    if not media or not p.is_file():
        raise HTTPException(status_code=404, detail="not_found")
    return FileResponse(str(p), media_type=media)


@app.get("/api/template")
def get_template() -> dict:
    """Return the current captured template (debug). Empty object if none yet."""
    return capture_store.load_template() or {}
