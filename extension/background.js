/**
 * FBEM Facebook Bridge — Chrome Extension Background Service Worker
 *
 * Browser-side of the fb-bridge service. Modeled on flowboard's WS-client
 * architecture:
 *   - WebSocket to the local Python agent (ws://127.0.0.1:9224).
 *   - HTTP callback for responses (immune to WS drops).
 *   - keepalive via chrome.alarms.
 *
 * Two data flows:
 *   1. CAPTURE: content script (page crawler) records genuine native Reel
 *      upload requests → POSTed to /api/ext/capture so the agent can build a
 *      replay template.
 *   2. REPLAY: agent sends {method:"post_reel"} → forwarded to a facebook.com
 *      tab → content/injected scripts reproduce the native upload → result
 *      relayed back to the agent.
 */

const AGENT_WS_URL = 'ws://127.0.0.1:9224';
const CALLBACK_URL = 'http://127.0.0.1:47102/api/ext/callback';
const CAPTURE_URL  = 'http://127.0.0.1:47102/api/ext/capture';

let ws               = null;
let callbackSecret   = null; // Auth secret received from agent on WS connect
let manualDisconnect = false;
let postInFlight     = 0;    // active post/switch count; pauses the periodic tab reload

// ─── Facebook tab matchers ──────────────────────────────────

const FB_TAB_URLS = ['https://*.facebook.com/*', 'https://web.facebook.com/*'];

// Find a logged-in facebook.com tab, retrying a few times. A tab that is
// mid-navigation (e.g. right after a profile-switch reload) transiently fails the
// url filter, returning empty — the retry rides that out instead of failing with
// no_facebook_tab. Prefers the FOCUSED window's active FB tab (so a switch_profile
// in one window isn't undone by posting via a different window's tab), then any
// active FB tab, then any FB tab.
async function findFbTab(attempts = 4, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const focused = await chrome.tabs.query({ url: FB_TAB_URLS, active: true, lastFocusedWindow: true });
      if (focused.length) return focused[0];
      const active = await chrome.tabs.query({ url: FB_TAB_URLS, active: true });
      if (active.length) return active[0];
      const any = await chrome.tabs.query({ url: FB_TAB_URLS });
      if (any.length) return any[0];
    } catch (e) {
      console.warn('[FBBridge] tab query failed:', e?.message || e);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Auto-reload the FB tab every TTL so its session/tokens + capture templates
// stay fresh (FB rotates volatile tokens; a long-idle tab goes stale). The bridge
// surfaces the resulting freshness as a per-service TTL countdown.
const RELOAD_TTL_MIN = 120; // 2h

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'reloadTab') reloadFbTab();
});

async function init() {
  const data = await chrome.storage.local.get(['callbackSecret']);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  chrome.alarms.create('reloadTab', { periodInMinutes: RELOAD_TTL_MIN });
}

// Reload the FB tab and tell the bridge we just refreshed (anchors the TTL).
async function reloadFbTab() {
  if (postInFlight > 0) return; // don't yank the tab out from under an active post/switch
  const tab = await findFbTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.reload(tab.id);
    sendLastActive();
  } catch (e) {
    console.warn('[FBBridge] tab reload failed:', e?.message || e);
  }
}

function sendLastActive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'last_active', at: Date.now() }));
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[FBBridge] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FBBridge] Connected to agent');
    chrome.alarms.clear('reconnect');
    ws.send(JSON.stringify({ type: 'fb_ready' }));
    sendLastActive(); // anchor the tab TTL on (re)connect
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FBBridge] Received callback secret');
        return;
      }
      if (msg.type === 'pong') {
        // keepalive response — no-op
        return;
      }

      if (msg.method === 'post_reel') {
        postInFlight++;
        try { await handlePostReel(msg); } finally { postInFlight--; }
        return;
      }
      if (msg.method === 'post_photos') {
        postInFlight++;
        try { await handlePostPhotos(msg); } finally { postInFlight--; }
        return;
      }
      if (msg.method === 'switch_profile') {
        postInFlight++;
        try { await handleSwitchProfile(msg); } finally { postInFlight--; }
        return;
      }
      if (msg.method === 'get_identity') {
        await handleGetIdentity(msg);
        return;
      }
    } catch (e) {
      console.error('[FBBridge] Message error:', e);
    }
  };

  ws.onclose = () => {
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FBBridge] WS error:', e);
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5 s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Send to Agent ──────────────────────────────────────────

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back to WS on HTTP failure. Non-response messages use WS directly.
 */
function sendToAgent(msg) {
  if (msg.id) {
    fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Secret': callbackSecret || '',
      },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fall back to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, fb_ready, telemetry)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** POST a crawler-recorded native request to the capture sink. */
function postCapture(payload) {
  fetch(CAPTURE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Callback-Secret': callbackSecret || '',
    },
    body: JSON.stringify(payload),
  }).catch((e) => {
    console.warn('[FBBridge] capture POST failed:', e?.message || e);
  });
}

// ─── rupload capture via webRequest ─────────────────────────
// FB uploads the reel video in a Web Worker, whose fetch/XHR the page-world
// crawler can't see. webRequest observes ALL contexts (page, worker, iframe)
// and gives us the request headers — which is the whole template we need; the
// bytes are supplied by us at replay.
//
// NOTE: the 1500ms burst-throttle is REMOVED so we capture EVERY rupload request
// of a real manual upload — this reveals whether FB chunks the upload (multiple
// POSTs with incrementing offset/start_offset/end_offset) and the real
// X-Entity-Name, which is exactly what we need to diff against our replay.
const UPLOAD_URL_RE = /rupload|upload|video-upload|\/video\/|media.*upload|entity/i;
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const u = details.url || '';
      if (details.method === 'OPTIONS') return; // skip CORS preflight; we want the real upload
      if (/\/api\/graphql\//i.test(u)) return;
      // The native photo composer POSTs to .../react_composer/attachments/photo/upload,
      // whose URL contains "upload" and would otherwise be tagged `rupload` and
      // clobber the reel video-transfer slot. That request is captured separately
      // as `photo_upload` by the page-world crawler, so skip it here.
      if (/\/react_composer\/attachments\/photo\//i.test(u)) return;
      if (!UPLOAD_URL_RE.test(u)) return;
      const headers = {};
      for (const h of details.requestHeaders || []) headers[h.name] = h.value;
      postCapture({
        kind: 'rupload',
        url: u,
        method: details.method || 'POST',
        headers,
        body: null,
        via: 'webRequest',
      });
    } catch (e) {
      console.warn('[FBBridge] rupload capture error:', e?.message || e);
    }
  },
  { urls: ['https://*.facebook.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

// Base64-encode an ArrayBuffer in chunks (avoids call-stack overflow on big files).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Reload a tab and wait until it finishes loading + its scripts re-initialise.
// Done before every upload (by request) so each post starts from a guaranteed-
// fresh page: avoids "Extension context invalidated" on an orphaned content
// script and guarantees fresh fb_dtsg/lsd tokens. ~ a few seconds of latency.
async function reloadTabAndWait(tabId, settleMs = 3000, navigateUrl = null) {
  try {
    // navigateUrl set → go to that URL (changes the address bar, clean identity
    // context, e.g. facebook.com home after a profile switch). Else reload in place.
    if (navigateUrl) await chrome.tabs.update(tabId, { url: navigateUrl });
    else await chrome.tabs.reload(tabId);
  } catch (e) {
    console.warn('[FBBridge] tab reload/navigate failed:', e?.message || e);
    return;
  }
  // Wait for status === 'complete' (event + poll fallback, 30s cap).
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) { /* noop */ }
      clearInterval(poll);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const t0 = Date.now();
    const poll = setInterval(async () => {
      try {
        const tb = await chrome.tabs.get(tabId);
        if (tb.status === 'complete' || Date.now() - t0 > 30000) finish();
      } catch (_) { finish(); }
    }, 500);
  });
  // Let content.js inject injected.js and FB page JS boot (tokens, composer cfg).
  await new Promise((r) => setTimeout(r, settleMs));
  // The tab just (re)loaded — anchor the freshness TTL so /api/health doesn't drift
  // 'stale' even when a steadily-posting bridge keeps the tab fresh via this path.
  sendLastActive();
}

// ─── identity helpers (page_id auto-switch) ────────────────

// Ask the page which identity (page/profile id) the tab currently posts AS.
async function queryIdentity(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'get_identity', id: 'auto_' + Date.now() });
    return r && r.ok ? String(r.identityId) : null;
  } catch (_) {
    return null;
  }
}

// Honor a post's page_id: ensure the tab is acting AS that page, auto-switching if
// needed. Returns {ok:true} once acting as pageId, else {ok:false,error} — so we
// NEVER silently post to the wrong page. The switch needs a captured
// CometProfileSwitchMutation (switchTemplate), forwarded by the bridge.
async function ensureActingAs(tab, pageId, switchTemplate) {
  const current = await queryIdentity(tab.id);
  if (current && current === String(pageId)) return { ok: true };
  if (!switchTemplate) {
    return { ok: false, error: `page_switch_unavailable: tab acts as ${current || 'unknown'}, not ${pageId}; capture a CometProfileSwitchMutation or call switch_profile first` };
  }
  let sw;
  try {
    sw = await chrome.tabs.sendMessage(tab.id, {
      type: 'switch_profile',
      id: 'autosw_' + Date.now(),
      params: { targetId: String(pageId), template: switchTemplate },
    });
  } catch (e) {
    return { ok: false, error: `page_switch_failed: ${e?.message || e}` };
  }
  if (!sw || !sw.ok) return { ok: false, error: (sw && sw.error) || 'page_switch_failed' };
  // The new identity's tokens load only after a reload (navigate home for clean ctx).
  await reloadTabAndWait(tab.id, 3000, 'https://www.facebook.com/');
  const after = await queryIdentity(tab.id);
  if (!after || after !== String(pageId)) {
    return { ok: false, error: `page_switch_unverified: tab acts as ${after || 'unknown'} after switching to ${pageId}` };
  }
  return { ok: true };
}

// ─── post_reel: forward to a facebook.com tab ───────────────

/**
 * Find an active, logged-in facebook.com tab and forward the post_reel
 * request to its content script. The content script (and the main-world
 * injected script it bridges to) performs the actual native upload+publish.
 */
async function handlePostReel(msg) {
  const { id, params } = msg;

  const tab = await findFbTab();

  if (!tab) {
    sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    return;
  }

  // Honor page_id: make the tab act AS the requested page before posting (else we
  // would silently post as whatever identity the tab currently holds).
  if (params.pageId) {
    const acting = await ensureActingAs(tab, params.pageId, params.switchTemplate);
    if (!acting.ok) { sendToAgent({ id, status: 502, error: acting.error }); return; }
  }

  // Reload the FB tab first (by request) so every upload starts from a fresh page.
  await reloadTabAndWait(tab.id);

  // Fetch the video HERE in the service worker, not in the page. The page is
  // https://facebook.com; fetching the http://127.0.0.1 loopback URL from page
  // context is blocked/hung by mixed-content + Private Network Access.
  // The SW has host_permissions for that host and is exempt, so we fetch the
  // bytes and hand them to the injected replay as base64.
  let videoB64 = null;
  try {
    const r = await fetch(params.videoUrl);
    if (!r.ok) {
      sendToAgent({ id, status: 502, error: `video_fetch_failed: ${r.status}` });
      return;
    }
    videoB64 = arrayBufferToBase64(await r.arrayBuffer());
  } catch (e) {
    sendToAgent({ id, status: 502, error: `video_fetch_error: ${e?.message || e}` });
    return;
  }

  try {
    // The content script replies asynchronously with the upload result.
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'post_reel',
      id,
      params: { ...params, videoB64 },
    });

    if (result && result.ok) {
      sendToAgent({
        id,
        status: 200,
        data: {
          videoId: result.videoId,
          permalinkUrl: result.permalinkUrl ?? null,
        },
      });
    } else {
      sendToAgent({
        id,
        status: 500,
        error: (result && result.error) || 'post_reel_failed',
      });
    }
  } catch (e) {
    const m = e?.message || '';
    // Content script not reachable → treat as no usable FB tab.
    if (
      m.includes('Receiving end does not exist') ||
      m.includes('Could not establish connection') ||
      m.includes('No tab with id')
    ) {
      sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    } else {
      sendToAgent({ id, status: 500, error: m || 'post_reel_failed' });
    }
  }
}

// ─── post_photos: forward to a facebook.com tab ─────────────

/**
 * Native photo / album post. Like handlePostReel, but fetches N images in the
 * service worker (loopback / R2 fetches are blocked from page context) and hands
 * them to the injected replay as a base64 array. One ComposerStoryCreateMutation
 * publishes a single photo or a multi-photo album.
 */
async function handlePostPhotos(msg) {
  const { id, params } = msg;

  const tab = await findFbTab();
  if (!tab) {
    sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    return;
  }

  // Honor page_id: make the tab act AS the requested page before posting.
  if (params.pageId) {
    const acting = await ensureActingAs(tab, params.pageId, params.switchTemplate);
    if (!acting.ok) { sendToAgent({ id, status: 502, error: acting.error }); return; }
  }

  // Reload the FB tab first (by request) so every upload starts from a fresh page.
  await reloadTabAndWait(tab.id);

  const urls = Array.isArray(params.imageUrls) ? params.imageUrls : [];
  if (!urls.length) {
    sendToAgent({ id, status: 400, error: 'no_image_urls' });
    return;
  }

  // Fetch every image HERE (SW is exempt from mixed-content / PNA) → base64.
  let imagesB64 = [];
  try {
    for (const u of urls) {
      const r = await fetch(u);
      if (!r.ok) {
        sendToAgent({ id, status: 502, error: `image_fetch_failed: ${r.status} ${u.slice(0, 80)}` });
        return;
      }
      imagesB64.push(arrayBufferToBase64(await r.arrayBuffer()));
    }
  } catch (e) {
    sendToAgent({ id, status: 502, error: `image_fetch_error: ${e?.message || e}` });
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'post_photos',
      id,
      params: {
        caption: params.caption,
        template: params.template,
        scheduledPublishTime: params.scheduledPublishTime,
        imagesB64,
      },
    });

    if (result && result.ok) {
      sendToAgent({
        id,
        status: 200,
        data: {
          postId: result.postId,
          photoIds: result.photoIds ?? null,
          permalinkUrl: result.permalinkUrl ?? null,
        },
      });
    } else {
      sendToAgent({ id, status: 500, error: (result && result.error) || 'post_photos_failed' });
    }
  } catch (e) {
    const m = e?.message || '';
    if (
      m.includes('Receiving end does not exist') ||
      m.includes('Could not establish connection') ||
      m.includes('No tab with id')
    ) {
      sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    } else {
      sendToAgent({ id, status: 500, error: m || 'post_photos_failed' });
    }
  }
}

// ─── switch_profile: change active identity, then reload ────

/**
 * Switch the logged-in session to a target profile/page (CometProfileSwitchMutation
 * runs in the page with the CURRENT identity's tokens), then reload the tab so the
 * NEW identity's fb_dtsg/__user load. After this, posts go out as the target page.
 */
async function handleSwitchProfile(msg) {
  const { id, params } = msg;

  const tab = await findFbTab();
  if (!tab) {
    sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    return;
  }

  try {
    // Switch must run with the CURRENT identity → do NOT reload before it.
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'switch_profile', id, params });
    if (result && result.ok) {
      // After switch: navigate to facebook.com home so the URL reflects the new
      // identity and the page loads cleanly with the new identity's tokens.
      await reloadTabAndWait(tab.id, 3000, 'https://www.facebook.com/');
      // Confirm the new identity actually took effect post-reload before reporting
      // success — the mutation can succeed while the cookie flip races the reload.
      const after = await queryIdentity(tab.id);
      if (after && String(after) === String(params.targetId)) {
        sendToAgent({ id, status: 200, data: { identityId: result.identityId, identityName: result.identityName } });
      } else {
        sendToAgent({ id, status: 502, error: `switch_unverified: tab acts as ${after || 'unknown'} after switching to ${params.targetId}` });
      }
    } else {
      sendToAgent({ id, status: 500, error: (result && result.error) || 'switch_failed' });
    }
  } catch (e) {
    const m = e?.message || '';
    if (
      m.includes('Receiving end does not exist') ||
      m.includes('Could not establish connection') ||
      m.includes('No tab with id')
    ) {
      sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    } else {
      sendToAgent({ id, status: 500, error: m || 'switch_failed' });
    }
  }
}

// ─── get_identity: read the current acting page/profile (no switch) ──

/** Ask the FB tab for the identity it currently posts AS (id + best-effort name). */
async function handleGetIdentity(msg) {
  const { id } = msg;
  const tab = await findFbTab();
  if (!tab) {
    sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'get_identity', id });
    if (result && result.ok) {
      sendToAgent({
        id,
        status: 200,
        data: { identityId: result.identityId, identityName: result.identityName },
      });
    } else {
      sendToAgent({ id, status: 500, error: (result && result.error) || 'identity_failed' });
    }
  } catch (e) {
    const m = e?.message || '';
    if (
      m.includes('Receiving end does not exist') ||
      m.includes('Could not establish connection') ||
      m.includes('No tab with id')
    ) {
      sendToAgent({ id, status: 503, error: 'no_facebook_tab' });
    } else {
      sendToAgent({ id, status: 500, error: m || 'identity_failed' });
    }
  }
}

// ─── Runtime messages from content scripts ──────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || !msg.type) return;

  // Crawler snapshot of a genuine native request → push to capture sink.
  if (msg.type === 'capture') {
    postCapture(msg.payload);
    reply?.({ ok: true });
    return; // sync reply; no async channel needed
  }

  // Replay result relayed up from the page (in addition to the direct
  // sendMessage reply path in handlePostReel — belt and suspenders if the
  // page chooses to emit it as a fire-and-forget event).
  if (msg.type === 'post_reel_result') {
    if (msg.id) {
      if (msg.ok) {
        sendToAgent({
          id: msg.id,
          status: 200,
          data: { videoId: msg.videoId, permalinkUrl: msg.permalinkUrl ?? null },
        });
      } else {
        sendToAgent({ id: msg.id, status: 500, error: msg.error || 'post_reel_failed' });
      }
    }
    reply?.({ ok: true });
    return;
  }

  if (msg.type === 'post_photos_result') {
    if (msg.id) {
      if (msg.ok) {
        sendToAgent({
          id: msg.id,
          status: 200,
          data: { postId: msg.postId, photoIds: msg.photoIds ?? null, permalinkUrl: msg.permalinkUrl ?? null },
        });
      } else {
        sendToAgent({ id: msg.id, status: 500, error: msg.error || 'post_photos_failed' });
      }
    }
    reply?.({ ok: true });
    return;
  }

  if (msg.type === 'switch_profile_result') {
    if (msg.id) {
      if (msg.ok) {
        sendToAgent({ id: msg.id, status: 200, data: { identityId: msg.identityId, identityName: msg.identityName } });
      } else {
        sendToAgent({ id: msg.id, status: 500, error: msg.error || 'switch_failed' });
      }
    }
    reply?.({ ok: true });
    return;
  }
});

console.log('[FBBridge] Extension loaded');
