"""Persist crawler captures of genuine native Facebook upload requests.

The crawler (injected main-world script on facebook.com) snapshots real upload
requests when the user manually posts a Reel, and relays each through the
extension to ``POST /api/ext/capture``. Each capture is a dict shaped like:

    { kind: "rupload" | "graphql", url, method, headers, body, friendlyName? }

We append every capture to ``captures/<unix-ts>-<kind>.json`` (full audit trail)
and fold the latest of each kind into ``captures/template.json``:

    { "rupload": {...}, "graphql": {...}, "updatedAt": <unix-ts> }

The replay (``/post-reel``) loads ``template.json`` and substitutes fresh
volatile tokens. When FB rotates its payload shape, the user re-captures; no
code change needed (self-healing by design).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Optional
from urllib.parse import parse_qs

from .config import captures_dir

logger = logging.getLogger(__name__)

_CAPTURES_DIR = captures_dir()
_TEMPLATE_PATH = _CAPTURES_DIR / "template.json"

# Live capture activity — proof the extension is attached to a logged-in
# facebook.com tab and actively observing it (updates on every captured request,
# including the trace stream that flows as soon as the FB tab (re)loads). This is
# the honest "extension is ready" signal; there is no separate token flag.
_last_capture_at: Optional[float] = None
_capture_count: int = 0
_last_capture_url: Optional[str] = None

# Which graphql op is the actual Reel publish. During reel creation FB fires
# dozens of graphql ops (typeaheads, queries); only ONE publishes the post, so
# "latest wins" would store the wrong one. Match the publish mutation by its
# friendly name. Override via FB_PUBLISH_OP_RE if FB renames it.
_PUBLISH_OP_RE = re.compile(
    os.getenv(
        "FB_PUBLISH_OP_RE",
        r"(Composer.*Create.*Mutation|Story.*Create.*Mutation|Reels?.*(Create|Publish).*Mutation)",
    ),
    re.IGNORECASE,
)


def _ensure_dir() -> None:
    _CAPTURES_DIR.mkdir(parents=True, exist_ok=True)


def _publish_attachment_kind(payload: dict) -> Optional[str]:
    """Inspect a captured ComposerStoryCreateMutation and classify its first
    attachment, so reel / photo / link publishes — which share the SAME friendly
    name — land in the right template slot instead of clobbering each other.

    Returns one of:
      ``"video"``  — a reel (video attachment)
      ``"photo"``  — a single photo / album
      ``"other"``  — parsed fine, but not media we template (link share, empty,
                     text-only). The caller must NOT write the reel/photo slots.
      ``None``     — the body couldn't be parsed (e.g. FB rotated the shape). The
                     caller falls back to the reel slot so re-capture still heals.
    """
    try:
        body = payload.get("body") or {}
        raw = body.get("value") if isinstance(body, dict) else None
        if not raw:
            return None
        qs = parse_qs(raw)
        variables = qs.get("variables", [None])[0]
        if not variables:
            return None
        atts = (json.loads(variables).get("input") or {}).get("attachments") or []
        if not atts:
            return "other"
        first = atts[0]
        if "video" in first:
            return "video"
        if "photo" in first:
            return "photo"
        return "other"
    except (json.JSONDecodeError, ValueError, TypeError, KeyError):
        return None


def save_capture(payload: dict) -> None:
    """Append a recorded native request to the captures dir and fold its kind
    into template.json. ``payload['kind']`` selects the template slot
    (defaults to "unknown" so nothing is silently dropped)."""
    _ensure_dir()
    kind = payload.get("kind") or "unknown"
    ts = int(time.time())

    # Record live activity for the readiness signal (every capture counts).
    global _last_capture_at, _capture_count, _last_capture_url
    _last_capture_at = time.time()
    _capture_count += 1
    if payload.get("url"):
        _last_capture_url = str(payload["url"])[:200]

    # Comprehensive trace: one request+response per line, for OFFLINE analysis.
    # Kept out of the per-file/template machinery so a full session is one stream.
    if kind == "trace":
        rec = dict(payload)
        rec["ts"] = ts
        with (_CAPTURES_DIR / "trace.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        logger.info("trace %s %s -> %s", payload.get("method"), payload.get("respStatus"), (payload.get("url") or "")[:70])
        return

    capture_path = _CAPTURES_DIR / f"{ts}-{kind}.json"
    # Guard against collisions when two captures of the same kind land in the
    # same second.
    suffix = 0
    while capture_path.exists():
        suffix += 1
        capture_path = _CAPTURES_DIR / f"{ts}-{kind}-{suffix}.json"
    capture_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info("saved capture %s", capture_path.name)

    template = load_template() or {}
    template["updatedAt"] = ts

    if kind == "graphql":
        # Keep one capture per friendly name for inspection, and only promote the
        # real publish mutation into the slot the replay uses.
        friendly = payload.get("friendlyName") or "(unknown)"
        ops = template.setdefault("graphql_ops", {})
        ops[friendly] = payload
        if _PUBLISH_OP_RE.search(friendly):
            # Reel (video), photo/album, AND link shares ALL fire
            # ComposerStoryCreateMutation. Route by attachment type into separate
            # slots, and — critically — only let a real `video` attachment write
            # the reel slot. A stray link share / empty CSCM must NOT clobber it
            # (that produced replay error story_create=null [1373034]).
            att_kind = _publish_attachment_kind(payload)
            if att_kind == "photo":
                template["graphql_photo"] = payload
                logger.info("folded PHOTO publish op=%s into graphql_photo", friendly)
            elif att_kind == "other":
                # Link share / empty / text-only CSCM — recognized as NOT a reel.
                # Must not clobber the reel or photo slot (this exact case wrote a
                # link share into the reel slot and broke replay: [1373034]).
                logger.info(
                    "ignored non-media CSCM publish op=%s — leaving reel/photo slots intact",
                    friendly,
                )
            else:
                # "video", or None (body unparseable → FB may have rotated the
                # shape). Fall back to the reel slot so a manual re-capture still
                # self-heals reel replay, as it always did.
                template["graphql"] = payload
                logger.info("folded REEL publish op=%s into graphql (att=%s)", friendly, att_kind)
        else:
            logger.info("recorded graphql op=%s (not the publish mutation)", friendly)
    elif kind == "photo_upload":
        # The native composer photo-upload request (upload.facebook.com/...). We
        # template its url + form fields; the replay swaps the image bytes + fresh
        # volatile tokens. Strip the binary `farr` payload — bytes come from us.
        rb = payload.get("reqBody") or payload.get("body") or {}
        fields = {}
        if isinstance(rb, dict) and rb.get("type") == "formdata":
            for k, v in (rb.get("entries") or {}).items():
                fields[k] = {"__binary": True} if isinstance(v, dict) and v.get("__binary") else v
        template["photo_upload"] = {
            "url": payload.get("url"),
            "method": payload.get("method") or "POST",
            "formFields": fields,
        }
        logger.info("folded photo_upload template into template.json")
    elif kind == "upload_flow":
        # The full vupload request+response trace (start/transfer/cvc). Keep a
        # rolling window for analysis; the replay is derived from these.
        flows = template.setdefault("upload_flow", [])
        flows.append(payload)
        del flows[:-12]  # keep the last 12
        logger.info("recorded upload_flow %s -> %s", payload.get("method"), (payload.get("url") or "")[:60])
    elif kind == "rupload":
        # The reel rupload slot must hold the VIDEO byte-transfer only. The native
        # photo composer POSTs to upload.facebook.com/.../react_composer/attachments/
        # photo/upload — which the background webRequest listener also tags as
        # `rupload` (its URL contains "upload"). That photo transfer has its own
        # `photo_upload` slot, so it must NOT clobber the reel slot here (same class
        # of bug as the non-video CSCM clobber, [a5a5c83]).
        url = payload.get("url") or ""
        if re.search(r"/react_composer/attachments/photo/", url, re.IGNORECASE):
            logger.info("ignored photo-composer rupload — leaving reel rupload slot intact")
        # Only a real byte-transfer POST/PUT (has the id/offset/entity headers) is
        # a usable template — never the OPTIONS preflight.
        elif (payload.get("method") or "").upper() in ("POST", "PUT"):
            template["rupload"] = payload
            logger.info("folded real rupload POST into template.json")
        else:
            logger.info("ignored non-POST rupload (%s)", payload.get("method"))
    else:
        template[kind] = payload
        logger.info("folded kind=%s into template.json", kind)

    _TEMPLATE_PATH.write_text(json.dumps(template, indent=2), encoding="utf-8")


def template_complete(t: Optional[dict]) -> bool:
    """Usable for REEL replay once we have the (video) publish mutation. The
    video upload steps (vupload start/transfer/receive) are reproduced
    programmatically from the decoded protocol (see PROTOCOL.md); only the publish
    mutation is templated. A regional rupload host helps but has a fallback."""
    return bool(t) and bool(t.get("graphql"))


def photo_template_complete(t: Optional[dict]) -> bool:
    """Usable for PHOTO/ALBUM replay once we have both the photo-upload request
    template and the photo publish mutation. The upload request can fall back to a
    constructed default, so the publish mutation is the hard requirement."""
    return bool(t) and bool(t.get("graphql_photo"))


def capture_stats() -> dict:
    """Live capture activity — proof the extension is on a logged-in FB tab and
    actively observing it. ``tab_active`` is True when a capture arrived recently
    (default 90s window, FB_TAB_ACTIVE_WINDOW_S to tune)."""
    window = float(os.getenv("FB_TAB_ACTIVE_WINDOW_S", "90"))
    seconds_since = (
        int(time.time() - _last_capture_at) if _last_capture_at is not None else None
    )
    return {
        "captures": _capture_count,
        "last_capture_at": int(_last_capture_at) if _last_capture_at is not None else None,
        "seconds_since_capture": seconds_since,
        "last_capture_url": _last_capture_url,
        "tab_active": seconds_since is not None and seconds_since <= window,
    }


def load_template() -> Optional[dict]:
    """Return the current template.json contents, or None if not captured yet."""
    if not _TEMPLATE_PATH.exists():
        return None
    try:
        data: Any = json.loads(_TEMPLATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("failed to read template.json: %s", exc)
        return None
    return data if isinstance(data, dict) else None
