/**
 * FBEM Facebook Bridge — Injected script (facebook.com MAIN world).
 *
 * Runs in the page's own JS context, so it sees page cookies, fb_dtsg, lsd,
 * and window globals (require(), __accessToken, etc.). Three jobs:
 *
 *   1. CRAWLER  — passively monkeypatch fetch + XHR to snapshot the genuine
 *      native Reel-upload requests the user makes by hand, so the agent can
 *      build a replay template. NEVER blocks or mutates the real request.
 *   2. TOKENS   — readTokens(): best-effort scrape of fresh volatile tokens.
 *   3. REPLAY   — on {type:"post_reel"}, reproduce the captured template with
 *      fresh tokens + a fetched video blob, then report the result.
 *
 * All cross-world messaging uses { source:"fbem-fb", ... } envelopes.
 */
(function () {
  'use strict';

  const TAG = '[FBBridge/inj]';

  // ── outbound helpers ──────────────────────────────────────
  function emit(type, payload) {
    window.postMessage({ source: 'fbem-fb', type, ...payload }, '*');
  }
  function emitCapture(payload) {
    emit('capture', { payload });
  }

  // ── safe body serialization ───────────────────────────────
  // Body may be FormData / URLSearchParams / string / Blob / ArrayBuffer.
  // Record what we can serialize as JSON; never the raw binary bytes.
  function serializeBody(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') {
        return { type: 'string', value: body.slice(0, 200000) };
      }
      if (body instanceof URLSearchParams) {
        return { type: 'urlencoded', entries: Object.fromEntries(body.entries()) };
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const out = {};
        for (const [k, v] of body.entries()) {
          if (typeof v === 'string') {
            out[k] = v.length > 100000 ? `<string:${v.length}>` : v;
          } else {
            // File / Blob — record metadata only, not the bytes.
            out[k] = { __binary: true, name: v?.name, size: v?.size, fileType: v?.type };
          }
        }
        return { type: 'formdata', entries: out };
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return { type: 'blob', size: body.size, mime: body.type };
      }
      if (body instanceof ArrayBuffer) {
        return { type: 'arraybuffer', byteLength: body.byteLength };
      }
      if (ArrayBuffer.isView?.(body)) {
        return { type: 'arraybufferview', byteLength: body.byteLength };
      }
    } catch (e) {
      return { type: 'unserializable', error: String(e?.message || e) };
    }
    return { type: 'unknown' };
  }

  function headersToObject(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        for (const [k, v] of headers.entries()) out[k] = v;
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) out[k] = v;
      } else if (typeof headers === 'object') {
        Object.assign(out, headers);
      }
    } catch (_) { /* best effort */ }
    return out;
  }

  // ── crawler matchers ──────────────────────────────────────
  const RUPLOAD_RE = /rupload\.facebook\.com/i;
  const GRAPHQL_RE = /\/api\/graphql\//i;
  const REEL_RE    = /reel/i;
  // Native composer photo upload — bytes go to upload.facebook.com and the
  // response mints the photoID the publish mutation references.
  const PHOTO_UPLOAD_RE = /\/ajax\/react_composer\/attachments\/photo\/upload/i;
  // The full native video-upload flow (start → byte transfer → cvc). We capture
  // these WITH their responses, because the `start` response mints the video id
  // + the regional rupload target that the publish mutation needs.
  const UPLOAD_FLOW_RE = /\/ajax\/video\/upload\/|\.up\.facebook\.com\/|\/video\/unified_cvc\/|rupload/i;

  function bodyMentionsReel(serialized, headersObj) {
    try {
      const hay = JSON.stringify(serialized || {}) + ' ' + JSON.stringify(headersObj || {});
      if (REEL_RE.test(hay)) return true;
      // fb_api_req_friendly_name often arrives in the urlencoded/string body.
      const m = /fb_api_req_friendly_name["=:\s]+([^"&\s]+)/i.exec(hay);
      if (m && REEL_RE.test(m[1])) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function extractFriendlyName(serialized) {
    try {
      const hay = JSON.stringify(serialized || {});
      const m = /fb_api_req_friendly_name["=:\s]+([^"&\s]+)/i.exec(hay);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  function maybeCapture(url, method, headersObj, body) {
    try {
      const u = String(url || '');
      if (RUPLOAD_RE.test(u)) {
        // For rupload: record headers + metadata only (bytes are huge/binary).
        emitCapture({
          kind: 'rupload',
          url: u,
          method: method || 'POST',
          headers: headersObj,
          body: serializeBody(body), // metadata-only summary
        });
        return;
      }
      if (PHOTO_UPLOAD_RE.test(u)) {
        // Template the photo-upload request shape (url + form fields). The bytes
        // (`farr`) are summarized to metadata; the replay supplies fresh bytes.
        emitCapture({
          kind: 'photo_upload',
          url: u,
          method: method || 'POST',
          headers: headersObj,
          body: serializeBody(body),
        });
        return;
      }
      if (GRAPHQL_RE.test(u)) {
        const serialized = serializeBody(body);
        // The friendly name is most reliable in the request header; fall back
        // to the body for XHR cases where headers weren't observed.
        const friendly =
          (headersObj && (headersObj['x-fb-friendly-name'] || headersObj['X-FB-Friendly-Name'])) ||
          extractFriendlyName(serialized);
        // Reel creation fires dozens of graphql ops (typeaheads, queries); only
        // mutations can publish, so skip everything else to keep the template clean.
        if (friendly && /mutation/i.test(friendly)) {
          emitCapture({
            kind: 'graphql',
            url: u,
            method: method || 'POST',
            headers: headersObj,
            body: serialized,
            friendlyName: friendly,
          });
        }
      }
    } catch (e) {
      // Crawler must never throw into the page.
      console.warn(TAG, 'capture error', e);
    }
  }

  // ── monkeypatch fetch (passive: always call through) ──────
  // ── COMPREHENSIVE TRACE ───────────────────────────────────
  // Record EVERY interesting request + response (incl. bodies) so the whole
  // native upload+publish flow can be analyzed OFFLINE from a single session —
  // no more piecemeal runtime captures. Skips static assets to stay manageable.
  const TRACE_GET_RE = /\/ajax\/|\/api\/|graphql|upload|rupload|cvc|composer|reel|\/video\//i;
  function shouldTrace(url, method) {
    const m = (method || 'GET').toUpperCase();
    if (m === 'OPTIONS') return false;
    const u = String(url || '');
    if (!u || /^data:|^blob:/.test(u)) return false;
    if (m === 'POST' || m === 'PUT') return true; // all mutating requests
    return TRACE_GET_RE.test(u); // GETs only if they look like API/ajax/upload
  }
  function recordTraceResponse(url, method, headers, body, respPromise) {
    try {
      if (!shouldTrace(url, method)) return;
      respPromise.then((resp) => {
        try {
          resp.clone().text().then((text) => {
            emitCapture({
              kind: 'trace',
              url: String(url),
              method: (method || 'GET').toUpperCase(),
              headers,
              reqBody: serializeBody(body),
              respStatus: resp.status,
              respBody: (text || '').slice(0, 60000),
            });
          }).catch(() => {});
        } catch (_) { /* ignore */ }
      }).catch(() => {});
    } catch (_) { /* never break the page */ }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url, method, headers, body;
      try {
        url = typeof input === 'string' ? input : input?.url;
        method = init?.method || (typeof input === 'object' ? input?.method : 'GET');
        headers = headersToObject(init?.headers || (typeof input === 'object' ? input?.headers : null));
        body = init?.body;
        maybeCapture(url, method, headers, body);
      } catch (_) { /* never break the real request */ }
      const p = origFetch.apply(this, arguments);
      recordTraceResponse(url, method, headers, body, p);
      return p;
    };
  }

  // ── monkeypatch XHR (passive) ─────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__sp_method = method;
      this.__sp_url = url;
      this.__sp_headers = {};
    } catch (_) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__sp_headers) this.__sp_headers[name] = value;
    } catch (_) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      maybeCapture(this.__sp_url, this.__sp_method, this.__sp_headers, body);
      const url = this.__sp_url;
      const m = (this.__sp_method || 'GET').toUpperCase();
      if (shouldTrace(url, m)) {
        const hdrs = this.__sp_headers;
        this.addEventListener('load', function () {
          try {
            let respBody = '';
            try { respBody = (this.responseText || '').slice(0, 60000); } catch (_) { respBody = '<non-text>'; }
            emitCapture({
              kind: 'trace',
              url: String(url),
              method: m,
              headers: hdrs,
              reqBody: serializeBody(body),
              respStatus: this.status,
              respBody,
            });
          } catch (_) { /* ignore */ }
        });
      }
    } catch (_) { /* never break the real request */ }
    return origSend.apply(this, arguments);
  };

  // ── TOKEN SCRAPER ─────────────────────────────────────────
  // Best-effort: read fresh volatile tokens from the live page. Returns
  // whatever is available; replay substitutes these into the template.
  function readTokens() {
    const tokens = {};
    const tryFns = [
      () => {
        const d = window.require?.('DTSGInitData');
        if (d?.token) tokens.fb_dtsg = d.token;
        if (d?.async_get_token) tokens.fb_dtsg_async = d.async_get_token;
      },
      () => {
        if (tokens.fb_dtsg) return;
        const el = document.querySelector('input[name="fb_dtsg"]');
        if (el?.value) tokens.fb_dtsg = el.value;
      },
      () => {
        const lsd = window.require?.('LSD');
        if (lsd?.token) tokens.lsd = lsd.token;
      },
      () => {
        if (tokens.lsd) return;
        const el = document.querySelector('input[name="lsd"]');
        if (el?.value) tokens.lsd = el.value;
      },
      () => {
        // __user / jazoest / spin params live in the bootloader env.
        const env = window.require?.('CurrentUserInitialData');
        if (env?.USER_ID) tokens.__user = env.USER_ID;
      },
      () => {
        if (tokens.__user) return;
        const el = document.querySelector('input[name="__user"]');
        if (el?.value) tokens.__user = el.value;
      },
      () => {
        const el = document.querySelector('input[name="jazoest"]');
        if (el?.value) tokens.jazoest = el.value;
      },
      () => {
        const sjs = window.require?.('SiteData');
        if (sjs) {
          if (sjs.spin_r != null) tokens.__spin_r = sjs.spin_r;
          if (sjs.spin_b != null) tokens.__spin_b = sjs.spin_b;
          if (sjs.spin_t != null) tokens.__spin_t = sjs.spin_t;
          if (sjs.__hsdp != null) tokens.__hsdp = sjs.__hsdp;
          if (sjs.haste_session != null) tokens.haste_session = sjs.haste_session;
        }
      },
      () => {
        if (window.__accessToken) tokens.access_token = window.__accessToken;
      },
    ];
    for (const fn of tryFns) {
      try { fn(); } catch (_) { /* per-source best effort */ }
    }
    return tokens;
  }

  // ── REPLAY helpers ────────────────────────────────────────
  // Implements the fully-decoded FB native Reel upload+publish protocol
  // (see PROTOCOL.md): start → transfer bytes → receive → graphql publish.

  // Fresh per-post UUID (used as composer_session_id + waterfall_id).
  function uuid() {
    return crypto.randomUUID();
  }

  // n hex chars from crypto randomness (client-generated upload id segment).
  function randomHex(n = 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)));
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s.slice(0, n);
  }

  // Derive jazoest from fb_dtsg ('2' + sum of charCodes) when tokens.jazoest absent.
  function jazoestFor(dtsg) {
    let sum = 0;
    const s = String(dtsg || '');
    for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
    return '2' + sum;
  }

  // Strip FB's anti-JSON-hijack prefix before JSON.parse.
  function stripPrefix(text) {
    return String(text || '').replace(/^for\s*\(;;\);/, '');
  }

  // Walk the GraphQL response for any url/permalink-like field.
  function findPermalink(obj, depth = 0) {
    if (!obj || depth > 8) return null;
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && /^https?:\/\//.test(v) &&
            (/permalink|\/reel\/|\/videos\/|\/posts\//i.test(v) || /url/i.test(k))) {
          if (/permalink|\/reel\/|\/videos\/|\/posts\//i.test(v)) return v;
        }
        if (typeof v === 'object') {
          const found = findPermalink(v, depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // ── Step 2 — START: mint video_id + upload_session_id ─────
  async function startUpload(size, tokens, sessionId, template) {
    const url = `https://vupload-edge.facebook.com/ajax/video/upload/requests/start/?av=${tokens.__user}&__a=1`;
    // Template the start body from the captured request (it carries required
    // fields like supports_chunking / partition offsets / creator_product that a
    // hand-built body lacks → FB returns error 1357005). Override only the
    // dynamic bits: size, partitions, fresh session/waterfall ids, auth tokens.
    let body;
    const capStart = template?.startReq?.body;
    if (capStart) {
      body = new URLSearchParams(capStart);
      body.set('file_size', String(size));
      if (body.has('partition_end_offset')) body.set('partition_end_offset', String(size));
      if (body.has('partition_start_offset')) body.set('partition_start_offset', '0');
      body.set('waterfall_id', sessionId);
      body.set('composer_session_id', sessionId);
      body.set('target_id', tokens.__user);
      body.set('av', tokens.__user);
      body.set('__user', tokens.__user);
      if (tokens.fb_dtsg) body.set('fb_dtsg', tokens.fb_dtsg);
      body.set('jazoest', tokens.jazoest || jazoestFor(tokens.fb_dtsg));
      if (tokens.lsd) body.set('lsd', tokens.lsd);
      if (tokens.__spin_r != null) body.set('__spin_r', String(tokens.__spin_r));
      if (tokens.__spin_t != null) body.set('__spin_t', String(tokens.__spin_t));
    } else {
      // Fallback: minimal hand-built body (may be rejected by FB).
      body = new URLSearchParams();
      body.set('file_size', String(size));
      body.set('file_extension', 'mp4');
      body.set('target_id', tokens.__user);
      body.set('source', 'reel_composer');
      body.set('supports_chunking', 'true');
      body.set('supports_file_api', 'true');
      body.set('partition_start_offset', '0');
      body.set('partition_end_offset', String(size));
      body.set('creator_product', '2');
      body.set('waterfall_id', sessionId);
      body.set('composer_session_id', sessionId);
      body.set('composer_entry_point_ref', 'profile_reels');
      body.set('fb_dtsg', tokens.fb_dtsg);
      body.set('jazoest', tokens.jazoest || jazoestFor(tokens.fb_dtsg));
      body.set('lsd', tokens.lsd);
      body.set('__user', tokens.__user);
      body.set('__a', '1');
      body.set('av', tokens.__user);
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`start_failed: ${resp.status} ${text.slice(0, 300)}`);

    let payload;
    try {
      payload = JSON.parse(stripPrefix(text));
    } catch (e) {
      throw new Error(`start_unparseable: ${text.slice(0, 300)}`);
    }
    // Some responses nest under .payload; tolerate both shapes.
    const p = payload.payload || payload;
    const videoId = p.video_id;
    const uploadSessionId = p.upload_session_id;
    if (!videoId || !uploadSessionId) {
      throw new Error(`start_missing_ids: ${text.slice(0, 300)}`);
    }
    return { videoId, uploadSessionId };
  }

  // ── Step 3 — TRANSFER: send the raw video bytes ───────────
  async function transferBytes(host, blob, videoId, uploadSessionId, sessionId, tokens) {
    // SAME upload-id for the probe GET and the byte POST — FB keys the resumable
    // session off this URL path, so they MUST match.
    const url = `${host}/fb_video/${randomHex(32)}-0-${blob.size}` +
      `?av=${tokens.__user}&__a=1` +
      `&fb_dtsg=${encodeURIComponent(tokens.fb_dtsg)}` +
      `&lsd=${encodeURIComponent(tokens.lsd)}` +
      `&__user=${tokens.__user}`;

    // RESUMABLE-UPLOAD PROBE (REQUIRED). FB's native composer GETs the rupload URL
    // FIRST — the response `{"dc":...,"offset":N}` claims the session on a data
    // center and reports how many bytes are already there. Skipping this leaves the
    // session uninitialised, so the byte POST produces handles the RECEIVE step
    // can't reconcile → receive fails with 1357005 (the exact bug we hit). With the
    // probe, receive returns {start_offset==end_offset==file_size} = success.
    let startOffset = 0;
    try {
      const probe = await fetch(url, { method: 'GET', credentials: 'include' });
      const ptext = await probe.text();
      try {
        const pj = JSON.parse(stripPrefix(ptext));
        if (typeof pj.offset === 'number' && pj.offset >= 0) startOffset = pj.offset;
      } catch (_) { /* non-JSON probe body — proceed from offset 0 */ }
    } catch (_) { /* probe best-effort; proceed from offset 0 */ }

    const headers = {
      id: uploadSessionId,
      product_media_id: videoId,
      offset: String(startOffset),
      start_offset: String(startOffset),
      end_offset: String(blob.size),
      'X-Entity-Length': String(blob.size),
      'X-Total-Asset-Size': String(blob.size),
      'X-Entity-Type': 'application/octet-stream',
      'X-Entity-Name': 'undefined',
      composer_session_id: sessionId,
      'Content-Type': 'application/octet-stream',
    };

    // Resume from the probe offset (normally 0 → send the whole file).
    const bodyBlob = startOffset > 0 ? blob.slice(startOffset) : blob;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyBlob,
      credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`transfer_failed: ${resp.status} ${text.slice(0, 300)}`);

    let json;
    try {
      json = JSON.parse(stripPrefix(text));
    } catch (e) {
      throw new Error(`transfer_unparseable: ${text.slice(0, 300)}`);
    }
    if (!json.h) throw new Error(`transfer_no_handles: ${text.slice(0, 300)}`);
    return json.h; // newline-joined chunk handles
  }

  // ── Step 4 — RECEIVE: finalize the upload ─────────────────
  // CRITICAL: the receive endpoint identifies the upload via URL QUERY params —
  // video_id + start_offset/end_offset + composer/session ids — NOT the body. The
  // body carries ONLY the chunk handles. Omitting these query params is exactly
  // why receive returned 1357005 ("couldn't be processed") and the video errored.
  // Matched 1:1 against a real native capture.
  async function receiveUpload(handles, videoId, size, sessionId, tokens) {
    const jazoest = tokens.jazoest || jazoestFor(tokens.fb_dtsg);
    const q = new URLSearchParams();
    q.set('av', tokens.__user);
    q.set('__user', tokens.__user);
    q.set('__a', '1');
    q.set('video_id', String(videoId));
    q.set('start_offset', '0');
    q.set('end_offset', String(size));
    q.set('partition_start_offset', '0');
    q.set('partition_end_offset', String(size));
    q.set('source', 'reel_composer');
    q.set('target_id', tokens.__user);
    q.set('composer_session_id', sessionId);
    q.set('waterfall_id', sessionId);
    q.set('supports_chunking', 'true');
    if (tokens.fb_dtsg) q.set('fb_dtsg', tokens.fb_dtsg);
    q.set('jazoest', jazoest);
    if (tokens.lsd) q.set('lsd', tokens.lsd);
    const url = `https://vupload-edge.facebook.com/ajax/video/upload/requests/receive/?${q.toString()}`;

    // Body: ONLY the chunk handles (the real native receive sends nothing else).
    const fd = new FormData();
    fd.append('fbuploader_video_file_chunk', handles);

    // Do NOT set content-type; the browser sets the multipart boundary.
    const resp = await fetch(url, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`receive_failed: ${resp.status} ${text.slice(0, 300)}`);

    let payload;
    try {
      payload = JSON.parse(stripPrefix(text));
    } catch (e) {
      throw new Error(`receive_unparseable: ${text.slice(0, 300)}`);
    }
    // FB signals failure with a top-level `error` + null payload (e.g. 1357005).
    if (payload && payload.error) {
      throw new Error(`receive_error ${payload.error}: ${payload.errorSummary || ''}`);
    }
    return payload; // { payload: { start_offset, end_offset } } = fully received
  }

  // Recursively delete every property named `key` anywhere inside `obj`.
  function deleteKeyDeep(obj, key) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) deleteKeyDeep(item, key);
      return;
    }
    if (key in obj) delete obj[key];
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') deleteKeyDeep(v, key);
    }
  }

  // ── Step 5 — PUBLISH: replay the captured graphql mutation ─
  // The template body is a urlencoded form string. We parse the `variables`
  // JSON and mutate `input` structurally (video id, caption, session id, fresh
  // idempotence tokens, scheduling, trim-artifact removal), then re-encode —
  // far more robust than fragile string replacement.
  //
  // scheduledPublishTime (epoch SECONDS, optional): when a positive number,
  // publish is SCHEDULED at that time; otherwise (default) publish IMMEDIATELY.
  async function graphqlPublish(template, videoId, caption, tokens, sessionId, scheduledPublishTime) {
    const cap = template.graphql;
    if (!cap || cap.body?.type !== 'string') {
      throw new Error('template_incomplete: graphql body is not a captured string');
    }

    const params = new URLSearchParams(cap.body.value || '');
    const v = JSON.parse(params.get('variables'));
    const input = v.input;

    // Point the publish at OUR freshly-uploaded video (id + edit source), and
    // drop the captured video's content-specific metadata (length/audio of the
    // OLD clip) — reusing it with a new upload causes story_create field_exception.
    if (input.attachments?.[0]?.video) {
      const vid = input.attachments[0].video;
      vid.id = String(videoId);
      // Stale content metadata of the captured clip — let FB derive from OUR upload.
      delete vid.video_media_metadata;
      delete vid.additional_video_metadata;
      delete vid.story_media_audio_data;
      delete vid.audio_descriptions;
      delete vid.transcriptions;
      const edits = vid.video_generation_params?.web_reels_composer_video_edits;
      if (edits) {
        edits.source_video_id = String(videoId);
        if (edits.client_info) edits.client_info.client_session_id = sessionId;
      }
    }

    // Caption.
    input.message = input.message || {};
    input.message.text = caption;

    // Fresh composer session.
    if ('composer_session_id' in input) input.composer_session_id = sessionId;

    // Regenerate per-post idempotence identifiers.
    input.idempotence_token = uuid();
    input.client_mutation_id = uuid();

    // Scheduling: PRESENT means scheduled; OMIT means publish immediately.
    if (typeof scheduledPublishTime === 'number' && scheduledPublishTime > 0) {
      input.unpublished_content_data = {
        scheduled_publish_time: scheduledPublishTime,
        unpublished_content_type: 'SCHEDULED',
      };
    } else {
      delete input.unpublished_content_data;
    }

    // Strip captured trim artifacts so OUR video isn't trimmed to the old
    // session's timestamps. (start_time_s is intentionally left untouched.)
    deleteKeyDeep(input, 'trim_timestamps');

    params.set('variables', JSON.stringify(v));

    // Refresh volatile tokens in the form (only when present).
    if (tokens.fb_dtsg) params.set('fb_dtsg', tokens.fb_dtsg);
    if (tokens.lsd) params.set('lsd', tokens.lsd);
    if (tokens.__user) params.set('__user', tokens.__user);
    const jazoest = tokens.jazoest || jazoestFor(tokens.fb_dtsg);
    if (jazoest) params.set('jazoest', jazoest);

    const body = params.toString();

    // Resolve the publish URL ('/api/graphql/' → absolute).
    const url = (cap.url && /^https?:\/\//.test(cap.url))
      ? cap.url
      : 'https://www.facebook.com/api/graphql/';

    // Refresh headers: x-fb-lsd + urlencoded content-type.
    const headers = { ...(cap.headers || {}) };
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;
    headers['content-type'] = 'application/x-www-form-urlencoded';

    const resp = await fetch(url, {
      method: cap.method || 'POST',
      headers,
      body,
      credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`graphql_failed: ${resp.status} ${text.slice(0, 300)}`);

    let permalinkUrl = null;
    let json;
    try {
      json = JSON.parse(stripPrefix(text));
    } catch (e) {
      // Non-JSON success body — accept publish, no permalink resolvable.
      return { videoId, permalinkUrl: null };
    }
    const errs = json.errors || (json.error ? [json.error] : []);
    if (errs.length) {
      // FB quirk: ComposerStoryCreateMutation can return field_exception (1357010)
      // from a SECONDARY resolver while the story IS created (data.story_create is
      // present). ONLY then is it a real success. If story_create is null the post
      // genuinely failed (e.g. the video wasn't ready) — surface the error so we
      // NEVER report a phantom reel. (Do NOT retry on success → would duplicate.)
      const codes = errs.map((e) => e && e.code);
      const storyCreated = !!(json.data && json.data.story_create);
      if (storyCreated && codes.every((c) => c === 1357010)) {
        return { videoId, permalinkUrl: findPermalink(json), warning: 'field_exception_1357010 (story created)' };
      }
      throw new Error('graphql_errors(story_create=' + (storyCreated ? 'ok' : 'null') + '): ' + JSON.stringify(errs).slice(0, 300));
    }
    permalinkUrl = findPermalink(json);
    return { videoId, permalinkUrl };
  }

  // ══════════════════════════════════════════════════════════
  //  PHOTO / ALBUM replay — native composer photo posts
  //  Flow (see capture analysis): for each image POST the bytes to
  //  upload.facebook.com/.../photo/upload → photoID, then publish ALL photoIDs
  //  in ONE ComposerStoryCreateMutation (attachments = [{photo:{id}}, …]).
  // ══════════════════════════════════════════════════════════

  // Refresh the volatile auth params in a captured upload URL, preserving the
  // environment fingerprints (__dyn/__hs/__rev/…) that FB ties to its JS bundle.
  function refreshUploadUrl(capturedUrl, tokens, uploadId) {
    let url;
    try {
      url = new URL(capturedUrl, 'https://upload.facebook.com');
    } catch (_) {
      url = new URL('https://upload.facebook.com/ajax/react_composer/attachments/photo/upload');
    }
    const q = url.searchParams;
    if (tokens.__user) { q.set('av', tokens.__user); q.set('__user', tokens.__user); }
    if (tokens.fb_dtsg) q.set('fb_dtsg', tokens.fb_dtsg);
    if (tokens.lsd) q.set('lsd', tokens.lsd);
    q.set('jazoest', tokens.jazoest || jazoestFor(tokens.fb_dtsg));
    q.set('__a', '1');
    if (uploadId) q.set('__req', uploadId);
    return url.toString();
  }

  // ── Upload ONE image → its photoID ────────────────────────
  async function uploadPhoto(template, blob, idx, tokens) {
    const tpl = template.photo_upload || {};
    // Client-generated upload id segment (captured ones were jsc_c_c/d/e/…).
    const uploadId = 'jsc_sp_' + idx + '_' + randomHex(6);
    const url = refreshUploadUrl(
      tpl.url || 'https://upload.facebook.com/ajax/react_composer/attachments/photo/upload',
      tokens,
      String(idx + 1),
    );

    const fd = new FormData();
    fd.append('source', '8');
    fd.append('profile_id', String(tokens.__user || ''));
    fd.append('waterfallxapp', 'comet');
    fd.append('upload_id', uploadId);
    // FB names the file part `farr`; a stable filename keeps parity with the capture.
    fd.append('farr', blob, `fbem_${idx + 1}.jpg`);

    const resp = await fetch(url, { method: 'POST', body: fd, credentials: 'include' });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`photo_upload_failed[${idx}]: ${resp.status} ${text.slice(0, 200)}`);
    let json;
    try {
      json = JSON.parse(stripPrefix(text));
    } catch (e) {
      throw new Error(`photo_upload_badjson[${idx}]: ${text.slice(0, 160)}`);
    }
    const pid = json?.payload?.photoID || json?.payload?.fbid || json?.payload?.id;
    if (!pid) throw new Error(`photo_upload_no_id[${idx}]: ${text.slice(0, 200)}`);
    return String(pid);
  }

  // ── Publish all photoIDs in one ComposerStoryCreateMutation ─
  async function publishPhotoStory(template, photoIds, caption, tokens, sessionId, scheduledPublishTime) {
    const cap = template.graphql_photo;
    if (!cap || cap.body?.type !== 'string') {
      throw new Error('template_incomplete: no photo publish mutation captured');
    }
    const params = new URLSearchParams(cap.body.value || '');
    const v = JSON.parse(params.get('variables'));
    const input = v.input;

    // Point the post at OUR freshly-uploaded photos (preserve album order).
    input.attachments = photoIds.map((id) => ({ photo: { id: String(id) } }));

    // Caption.
    input.message = input.message || {};
    input.message.text = caption;
    if (Array.isArray(input.message.ranges)) input.message.ranges = [];

    // Fresh composer session everywhere it appears.
    if ('composer_session_id' in input) input.composer_session_id = sessionId;
    if (input.logging && typeof input.logging === 'object') {
      input.logging.composer_session_id = sessionId;
    }

    // Regenerate per-post idempotence identifiers (mirror FB's `<uuid>_FEED`).
    input.idempotence_token = sessionId + '_FEED';
    input.client_mutation_id = uuid();

    // Scheduling: PRESENT = scheduled; OMIT = publish immediately.
    if (typeof scheduledPublishTime === 'number' && scheduledPublishTime > 0) {
      input.unpublished_content_data = {
        scheduled_publish_time: scheduledPublishTime,
        unpublished_content_type: 'SCHEDULED',
      };
    } else {
      delete input.unpublished_content_data;
    }

    params.set('variables', JSON.stringify(v));

    // Refresh volatile tokens.
    if (tokens.fb_dtsg) params.set('fb_dtsg', tokens.fb_dtsg);
    if (tokens.lsd) params.set('lsd', tokens.lsd);
    if (tokens.__user) params.set('__user', tokens.__user);
    const jazoest = tokens.jazoest || jazoestFor(tokens.fb_dtsg);
    if (jazoest) params.set('jazoest', jazoest);

    const url = (cap.url && /^https?:\/\//.test(cap.url))
      ? cap.url
      : 'https://www.facebook.com/api/graphql/';
    const headers = { ...(cap.headers || {}) };
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;
    headers['content-type'] = 'application/x-www-form-urlencoded';

    const resp = await fetch(url, {
      method: cap.method || 'POST',
      headers,
      body: params.toString(),
      credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`graphql_failed: ${resp.status} ${text.slice(0, 300)}`);

    let json;
    try {
      json = JSON.parse(stripPrefix(text));
    } catch (e) {
      return { postId: photoIds[0], permalinkUrl: null }; // non-JSON success
    }
    const errs = json.errors || (json.error ? [json.error] : []);
    if (errs.length) {
      // Same FB quirk as reels, with the SAME guard: 1357010 is success ONLY when
      // data.story_create is actually present; null means the post failed — throw
      // so we never report a phantom post. Never retry on success (would duplicate).
      const codes = errs.map((e) => e && e.code);
      const storyCreated = !!(json.data && json.data.story_create);
      if (storyCreated && codes.every((c) => c === 1357010)) {
        return { postId: photoIds[0], permalinkUrl: findPermalink(json), warning: 'field_exception_1357010 (story created)' };
      }
      throw new Error('graphql_errors(story_create=' + (storyCreated ? 'ok' : 'null') + '): ' + JSON.stringify(errs).slice(0, 300));
    }
    return { postId: photoIds[0], permalinkUrl: findPermalink(json) };
  }

  // ── PHOTO replay entrypoint ───────────────────────────────
  async function doPostPhotos(params) {
    const { imagesB64, caption, template, scheduledPublishTime } = params || {};
    if (!template?.graphql_photo) {
      return { ok: false, error: 'template_incomplete: no photo publish mutation' };
    }
    if (!Array.isArray(imagesB64) || imagesB64.length === 0) {
      return { ok: false, error: 'no_images' };
    }
    try {
      const tokens = readTokens();
      if (!tokens.fb_dtsg || !tokens.__user) return { ok: false, error: 'no_tokens' };

      const sessionId = uuid();

      // 1. Upload every image → photoID (sequential keeps album order + is gentle).
      const photoIds = [];
      for (let i = 0; i < imagesB64.length; i++) {
        const bin = atob(imagesB64[i]);
        const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        const blob = new Blob([arr], { type: 'image/jpeg' });
        photoIds.push(await uploadPhoto(template, blob, i, tokens));
      }

      // 2. Publish all of them as one story (single photo or album).
      const { postId, permalinkUrl } = await publishPhotoStory(
        template, photoIds, caption, tokens, sessionId, scheduledPublishTime,
      );
      return { ok: true, postId, photoIds, permalinkUrl: permalinkUrl ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // ── REPLAY entrypoint ─────────────────────────────────────
  // Step 1 (host discovery) is template-driven via template.ruploadHost.
  async function doPostReel(params) {
    const { videoUrl, videoB64, caption, template, scheduledPublishTime } = params || {};
    if (!template?.graphql) {
      return { ok: false, error: 'template_incomplete: no publish mutation' };
    }

    try {
      // Step 1 — rupload host (from config query / cached fallback).
      const ruploadHost = template.ruploadHost || 'https://rupload-sin2-1.up.facebook.com';

      // Get the source video → blob. The background SW fetches the bytes and
      // hands them over as base64 (page-context fetch of http://127.0.0.1 / R2 is
      // blocked by mixed-content + Private Network Access). Fall back to a direct
      // fetch only if no bytes were provided.
      let blob;
      if (videoB64) {
        const bin = atob(videoB64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: 'video/mp4' });
      } else {
        const vResp = await fetch(videoUrl, { credentials: 'omit' });
        if (!vResp.ok) return { ok: false, error: `video_fetch_failed: ${vResp.status}` };
        blob = await vResp.blob();
      }

      // Fresh volatile tokens.
      const tokens = readTokens();
      if (!tokens.fb_dtsg || !tokens.__user) return { ok: false, error: 'no_tokens' };

      const sessionId = uuid();

      // Step 2 — START.
      const { videoId, uploadSessionId } = await startUpload(blob.size, tokens, sessionId, template);

      // Step 3 — TRANSFER bytes.
      const handles = await transferBytes(ruploadHost, blob, videoId, uploadSessionId, sessionId, tokens);

      // Step 4 — RECEIVE (finalize). Needs videoId + size + sessionId for the
      // receive URL query (that's how FB identifies which upload to finalize).
      await receiveUpload(handles, videoId, blob.size, sessionId, tokens);

      // Step 5 — PUBLISH. NOTE: FB's ComposerStoryCreateMutation creates the reel
      // even when it returns a field_exception (1357010) — a secondary field
      // resolver throws while the story IS created. So we do NOT retry (that would
      // duplicate the post); graphqlPublish treats that error as success.
      const { permalinkUrl } = await graphqlPublish(
        template, videoId, caption, tokens, sessionId, scheduledPublishTime,
      );

      return { ok: true, videoId, permalinkUrl: permalinkUrl ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // ── PROFILE SWITCH — change the active identity (profile ⇄ page) ──
  // CometProfileSwitchMutation flips the logged-in session to `targetId` (cookie
  // i_user + __user). AFTER this the page must be reloaded so the new identity's
  // fb_dtsg/__user load; background.js does that reload. Captured doc_id below.
  async function switchProfile(targetId, tokens, template) {
    // Prefer templating from a captured CometProfileSwitchMutation: a hand-built
    // body (no __dyn/__csr/__hs/__spin_* fingerprints) gets silently rejected with
    // profile_switcher_comet_login=null. Reuse the captured body verbatim and
    // override only the target profile_id + fresh volatile tokens.
    const cap = template && template.body && template.body.type === 'string' ? template : null;
    let params;
    if (cap) {
      params = new URLSearchParams(cap.body.value || '');
      params.set('variables', JSON.stringify({ profile_id: String(targetId) }));
    } else {
      params = new URLSearchParams();
      params.set('fb_api_caller_class', 'RelayModern');
      params.set('fb_api_req_friendly_name', 'CometProfileSwitchMutation');
      params.set('variables', JSON.stringify({ profile_id: String(targetId) }));
      params.set('server_timestamps', 'true');
      params.set('doc_id', '29569331136046912');
    }
    // Fresh identity/tokens (override any stale templated values).
    params.set('av', tokens.__user);
    params.set('__user', tokens.__user);
    params.set('__a', '1');
    if (tokens.fb_dtsg) params.set('fb_dtsg', tokens.fb_dtsg);
    params.set('jazoest', tokens.jazoest || jazoestFor(tokens.fb_dtsg));
    if (tokens.lsd) params.set('lsd', tokens.lsd);

    const url = (cap && cap.url && /^https?:\/\//.test(cap.url)) ? cap.url : 'https://www.facebook.com/api/graphql/';
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;
    const resp = await fetch(url, {
      method: 'POST', headers, body: params.toString(), credentials: 'include',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`switch_failed: ${resp.status} ${text.slice(0, 200)}`);
    let json;
    try { json = JSON.parse(stripPrefix(text)); } catch (e) { throw new Error(`switch_unparseable: ${text.slice(0, 160)}`); }
    if (json.errors) throw new Error('switch_errors: ' + JSON.stringify(json.errors).slice(0, 200));
    const login = json.data && json.data.profile_switcher_comet_login;
    if (!login || !login.id) throw new Error(`switch_no_identity: ${text.slice(0, 160)}`);
    return { id: String(login.id), name: login.name || null };
  }

  // ── inbound bridge: post_reel from content script ─────────
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'fbem-fb') return;

    if (data.type === 'post_reel') {
      const id = data.id;
      const result = await doPostReel(data.params);
      emit('post_reel_result', {
        id,
        ok: result.ok,
        videoId: result.videoId,
        permalinkUrl: result.permalinkUrl ?? null,
        error: result.error,
      });
      return;
    }

    if (data.type === 'post_photos') {
      const id = data.id;
      const result = await doPostPhotos(data.params);
      emit('post_photos_result', {
        id,
        ok: result.ok,
        postId: result.postId,
        photoIds: result.photoIds ?? null,
        permalinkUrl: result.permalinkUrl ?? null,
        error: result.error,
      });
      return;
    }

    if (data.type === 'switch_profile') {
      const id = data.id;
      let result;
      try {
        const tokens = readTokens();
        if (!tokens.fb_dtsg || !tokens.__user) {
          result = { ok: false, error: 'no_tokens' };
        } else {
          const r = await switchProfile(data.params.targetId, tokens, data.params.template);
          result = { ok: true, identityId: r.id, identityName: r.name };
        }
      } catch (e) {
        result = { ok: false, error: String(e?.message || e) };
      }
      emit('switch_profile_result', { id, ...result });
      return;
    }

    if (data.type === 'get_identity') {
      // Read the CURRENT acting identity (the page/profile this tab posts AS).
      // When "using Facebook as a Page", the session cookie `i_user` holds the
      // PAGE id (the actor), while `c_user` stays the personal account and
      // CurrentUserInitialData.ACCOUNT_ID also stays personal. So the real per-page
      // id is `i_user` when present; otherwise we're acting as the personal account.
      // CurrentUserInitialData.NAME tracks the active identity's name either way.
      const id = data.id;
      const readCookie = (k) => {
        const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(document.cookie || '');
        return m ? decodeURIComponent(m[1]) : null;
      };
      let result;
      try {
        const iUser = readCookie('i_user'); // the Page id when acting as a Page
        const cUser = readCookie('c_user'); // the personal account id
        let identityId = iUser || null;
        let identityName = null;
        try {
          const cu = window.require?.('CurrentUserInitialData');
          if (cu) {
            if (!identityId) identityId = cu.ACCOUNT_ID || cu.USER_ID || null;
            identityName = cu.NAME || cu.SHORT_NAME || null;
          }
        } catch (_) {
          /* module not present on this surface — id-only is fine */
        }
        identityId = identityId || cUser || readTokens().__user || null;
        result = identityId
          ? { ok: true, identityId: String(identityId), identityName }
          : { ok: false, error: 'no_identity' };
      } catch (e) {
        result = { ok: false, error: String(e?.message || e) };
      }
      emit('get_identity_result', { id, ...result });
      return;
    }
  });

  console.log(TAG, 'crawler + replay armed');
})();
