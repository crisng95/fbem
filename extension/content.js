/**
 * FBEM Facebook Bridge — Content script (facebook.com isolated world).
 *
 * Runs at document_start. Two jobs:
 *   1. Inject injected.js into the page MAIN world (where page cookies,
 *      fb_dtsg, and window globals live — the isolated world cannot see them).
 *   2. Bridge messages both directions:
 *        page (window.postMessage) ⇄ background (chrome.runtime).
 *
 * Message envelope from the page uses { source:"fbem-fb", type, ... } so we
 * don't react to Facebook's own postMessage traffic.
 */
(function () {
  // ── Inject the MAIN-world script ──
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// Pending replay replies keyed by request id → sendResponse callbacks.
// Shared by both post_reel and post_photos (ids are unique uuids).
const pendingReel = new Map();

// ── Page → background ──
window.addEventListener('message', (event) => {
  // Only accept messages from this window and from our injected script.
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'fbem-fb') return;

  if (data.type === 'capture') {
    // Crawler snapshot of a native request → background → /api/ext/capture.
    chrome.runtime.sendMessage({ type: 'capture', payload: data.payload });
    return;
  }

  if (
    data.type === 'post_reel_result' ||
    data.type === 'post_photos_result' ||
    data.type === 'switch_profile_result' ||
    data.type === 'get_identity_result'
  ) {
    // Replay/switch finished in the page. Reply to the pending background request
    // if we own it; otherwise relay up as a fire-and-forget result.
    const payload = {
      type: data.type,
      id: data.id,
      ok: !!data.ok,
      error: data.error,
      // reel fields
      videoId: data.videoId,
      // photo fields
      postId: data.postId,
      photoIds: data.photoIds ?? null,
      permalinkUrl: data.permalinkUrl ?? null,
      // switch fields
      identityId: data.identityId,
      identityName: data.identityName,
    };
    const cb = data.id != null ? pendingReel.get(data.id) : undefined;
    if (cb) {
      pendingReel.delete(data.id);
      cb(payload);
    } else {
      chrome.runtime.sendMessage(payload);
    }
    return;
  }
});

// ── Background → page ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (
    !msg ||
    (msg.type !== 'post_reel' &&
      msg.type !== 'post_photos' &&
      msg.type !== 'switch_profile' &&
      msg.type !== 'get_identity')
  )
    return;
  // Stash the async reply callback; the page answers via <type>_result.
  pendingReel.set(msg.id, sendResponse);

  // Last-resort timeout so the message channel never hangs forever. Set ABOVE the
  // bridge (~300s) and client (~320s) timeouts — which own the real deadline — so
  // this never PRE-EMPTS a slow-but-successful upload with a false 'content_timeout'.
  // Single resolution: ONLY sendResponse (which resolves background's await); the
  // old extra fire-and-forget message double-reported the same id.
  setTimeout(() => {
    if (pendingReel.has(msg.id)) {
      pendingReel.delete(msg.id);
      // sendResponse may throw if the Chrome message port disconnected while
      // the upload was in flight — swallow any such error.
      try { sendResponse({ ok: false, error: 'content_timeout' }); } catch (_) { /* port gone */ }
    }
  }, 600000); // 10 min safety net only

  window.postMessage(
    { source: 'fbem-fb', type: msg.type, id: msg.id, params: msg.params },
    '*',
  );

  return true; // keep the message channel open for the async reply
});
