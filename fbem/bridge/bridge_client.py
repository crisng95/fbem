"""Bridge to the Chrome MV3 extension over WebSocket — Facebook Reel upload.

Generic transport ported + trimmed from flowgen's flow_client.py. KEEPS ONLY the
proven mechanism (pending asyncio futures keyed by uuid, callback secret, HTTP
callback resolution, telemetry, fire-and-forget notify) and drops all
Google-Flow-specific code (paygate, flow_key/ya29 caching, userinfo fetch, trpc,
captcha).

Control flow:
1. Extension opens WS to :9224.
2. Server sends ``{type:"callback_secret", secret}`` immediately.
3. When the server wants the extension to perform an action in the
   facebook.com page context, it calls e.g. ``bridge_client.post_reel(...)``
   which sends ``{id, method, params}`` over WS and awaits a future.
4. The extension performs the work inside the user's browser session and POSTs
   the response to ``/api/ext/callback`` with ``X-Callback-Secret``.
5. That HTTP handler resolves the pending future by id.
6. WS-side inbound messages from the extension (``fb_ready``,
   ``token_captured``, ``ping``/``pong``, ``fb_user``) update our stats.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)


class BridgeClient:
    """Singleton bridge client."""

    DEFAULT_TIMEOUT = 180.0  # seconds

    def __init__(self) -> None:
        self._ws: Optional[Any] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._callback_secret: str = secrets.token_urlsafe(32)

        # Profile pushed by the extension (e.g. the logged-in FB user). Stays
        # in-memory only; the extension replays it on the next WS reconnect.
        self._fb_user: Optional[dict] = None
        # Freshness anchor for the tab TTL: set on (re)connect and whenever the
        # extension reports it just (re)loaded the tab (`last_active`). The
        # extension auto-reloads every TTL window so this never goes stale.
        self._last_active_at: Optional[float] = None
        self._request_count = 0
        self._success_count = 0
        self._failed_count = 0
        self._last_error: Optional[str] = None

    # ── connection ─────────────────────────────────────────────────────────
    @property
    def connected(self) -> bool:
        return self._ws is not None

    @property
    def callback_secret(self) -> str:
        return self._callback_secret

    @property
    def fb_user(self) -> Optional[dict]:
        return self._fb_user

    @property
    def last_active_at(self) -> Optional[float]:
        return self._last_active_at

    def set_extension(self, ws: Any) -> None:
        # If an extension is already connected, tear it down cleanly first so
        # any orphaned pending futures are rejected before the new ws is stored.
        if self._ws is not None:
            self.clear_extension()
        self._ws = ws
        self._last_active_at = time.time()  # fresh connect anchors the TTL

    def clear_extension(self, ws: Any = None) -> None:
        # Ignore a teardown from a STALE handler: if a newer connection already
        # replaced self._ws, the old handler's `finally` must not clobber it nor
        # reject the new session's in-flight futures.
        if ws is not None and ws is not self._ws:
            return
        self._ws = None
        # Drop the cached identity — next reconnect will replay.
        self._fb_user = None
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("extension_disconnected"))
        self._pending.clear()

    # ── inbound handling ───────────────────────────────────────────────────
    async def handle_message(self, data: dict) -> None:
        t = data.get("type")
        if t == "fb_ready":
            # WS hello from the extension on (re)connect. Readiness is proven by
            # live capture activity (see capture_store), not a token flag.
            self._last_active_at = time.time()
            logger.info("fb_ready (extension connected)")
            return
        if t == "last_active":
            # Extension just (re)loaded the FB tab (periodic TTL refresh) — anchor
            # freshness to receipt time (ignore client clock).
            self._last_active_at = time.time()
            return
        if t == "fb_user":
            info = data.get("fbUser")
            if isinstance(info, dict):
                self._fb_user = info
                logger.info(
                    "fb_user captured: %s",
                    info.get("name") or info.get("id") or "<unknown>",
                )
            return
        if t in ("ping", "pong"):
            return
        # Inbound response (legacy path; production flow uses HTTP callback)
        req_id = data.get("id")
        if req_id and req_id in self._pending:
            self._resolve(req_id, data)

    def resolve_callback(self, data: dict) -> bool:
        """Called by the HTTP callback endpoint after validating the secret.

        Returns True if a pending future matched.
        """
        req_id = data.get("id")
        if not req_id or req_id not in self._pending:
            return False
        self._resolve(req_id, data)
        return True

    def _resolve(self, req_id: str, data: dict) -> None:
        fut = self._pending.pop(req_id, None)
        if not fut or fut.done():
            return
        # Count as failure if (a) an explicit `error` field is set OR
        # (b) the HTTP status is a 4xx/5xx. Otherwise success.
        status = data.get("status")
        http_error = isinstance(status, int) and status >= 400
        explicit_error = bool(data.get("error"))
        if http_error or explicit_error:
            self._failed_count += 1
            msg = data.get("error") or f"API_{status}"
            self._last_error = str(msg)[:200]
            fut.set_result(data)
        else:
            self._success_count += 1
            fut.set_result(data)

    # ── outbound ──────────────────────────────────────────────────────────
    async def notify(self, message: dict) -> bool:
        """Fire-and-forget WS push to the extension. Returns False when the
        extension isn't connected so callers can surface a meaningful
        diagnostic instead of silently losing the message.
        """
        ws = self._ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps(message))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("notify failed: %s", exc)
            return False

    async def _send(self, method: str, params: dict, timeout: Optional[float] = None) -> dict:
        ws = self._ws
        if ws is None:
            return {"error": "extension_disconnected"}

        req_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        self._request_count += 1

        payload = {"id": req_id, "method": method, "params": params}
        try:
            await ws.send(json.dumps(payload))
            return await asyncio.wait_for(fut, timeout=timeout or self.DEFAULT_TIMEOUT)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = "timeout"
            return {"error": "timeout"}
        except ConnectionError as exc:
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = str(exc)
            return {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = str(exc)
            return {"error": str(exc)}

    async def post_reel(
        self,
        video_url: str,
        caption: str,
        page_id: Optional[str],
        template: dict,
        scheduled_publish_time: Optional[int] = None,
        switch_template: Optional[dict] = None,
        timeout: float = 300.0,
    ) -> dict:
        """Drive the extension to publish a native Facebook Reel.

        Sends ``method:"post_reel"`` over WS; the extension fetches the video,
        reads fresh volatile tokens from the live facebook.com page, performs
        the rupload + graphql publish using the captured ``template`` shape, and
        POSTs the result back via the HTTP callback.
        """
        return await self._send(
            "post_reel",
            {
                "videoUrl": video_url,
                "caption": caption,
                "pageId": page_id,
                "switchTemplate": switch_template,
                "template": template,
                "scheduledPublishTime": scheduled_publish_time,
            },
            timeout=timeout,
        )

    async def post_photos(
        self,
        image_urls: list[str],
        caption: str,
        page_id: Optional[str],
        template: dict,
        scheduled_publish_time: Optional[int] = None,
        switch_template: Optional[dict] = None,
        timeout: float = 300.0,
    ) -> dict:
        """Drive the extension to publish a native Facebook photo / album post.

        Sends ``method:"post_photos"`` over WS; the extension fetches each image,
        uploads the bytes to the native composer photo endpoint to mint photoIDs,
        then publishes them all in one ComposerStoryCreateMutation using the
        captured ``template`` shape. A single url = a photo post; many = an album.
        """
        return await self._send(
            "post_photos",
            {
                "imageUrls": image_urls,
                "caption": caption,
                "pageId": page_id,
                "switchTemplate": switch_template,
                "template": template,
                "scheduledPublishTime": scheduled_publish_time,
            },
            timeout=timeout,
        )

    async def switch_profile(self, target_id: str, switch_template: Optional[dict] = None, timeout: float = 60.0) -> dict:
        """Switch the logged-in browser session to a target profile/page id via
        CometProfileSwitchMutation, then reload the tab so the new identity loads.
        After this, subsequent post_reel/post_photos go out AS that page.

        switch_template is a captured CometProfileSwitchMutation (full body with the
        __dyn/__csr/__spin_* fingerprints) — a hand-built body is silently rejected."""
        return await self._send(
            "switch_profile",
            {"targetId": target_id, "template": switch_template},
            timeout=timeout,
        )

    async def get_identity(self, timeout: float = 15.0) -> dict:
        """Ask the extension which page/profile the FB tab currently posts AS —
        returns the callback envelope whose `data` holds {identityId, identityName}.
        Read-only (no switch); used to pre-fill the 'add page' form."""
        return await self._send("get_identity", {}, timeout=timeout)

    # ── observability ─────────────────────────────────────────────────────
    @property
    def ws_stats(self) -> dict:
        return {
            "connected": self.connected,
            "pending": len(self._pending),
            "request_count": self._request_count,
            "success_count": self._success_count,
            "failed_count": self._failed_count,
            "last_error": self._last_error,
        }


bridge_client = BridgeClient()


def get_bridge_client() -> BridgeClient:
    return bridge_client
