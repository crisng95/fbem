# FBEM — Facebook Bridge (Chrome MV3 extension)

Browser-side of FBEM. It records and replays Facebook's *internal web API* — the
same requests a logged-in human makes on facebook.com — instead of the Graph API.

Two phases:

1. **Crawl** — passively snapshots the genuine native Reel / Photo upload requests
   when you post by hand, and ships them to the bridge as a replay *template*.
2. **Replay** — when the bridge asks (`post_reel` / `post_photos` / `switch_profile`
   / `get_identity`), reproduces that template with fresh media + fresh tokens.

## Files

- **background.js** — service worker: WebSocket to the bridge (`ws://127.0.0.1:9224`),
  HTTP callback for responses, keepalive via `chrome.alarms`, tab-TTL auto-reload,
  and routing of `post_reel` / `post_photos` / `switch_profile` / `get_identity`.
- **content.js** — injects `injected.js` into the page MAIN world and bridges
  messages both ways (envelope `{ source: "fbem-fb", … }` so we ignore FB's own
  `postMessage` traffic).
- **injected.js** — runs with page cookies + `fb_dtsg`/`lsd`: the crawler
  (passive `fetch`/`XHR` snapshot), the token scraper, and the replay.

## Install (Load unpacked)

1. Start the bridge first (`fbem-bridge`) — it listens on WS `9224` + HTTP `47102`.
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` directory.
4. The service worker connects to the bridge automatically.

## Keep a logged-in facebook.com tab open

Replay runs **inside a facebook.com page**, so a tab logged into the target
account/page must stay open, on the standard `www.facebook.com` site. With no
facebook.com tab open, the bridge returns `503 no_facebook_tab`.

## Capture-then-replay

Replay activates only after one real capture **per kind** (reel / photo / switch):

1. With the extension loaded and the bridge running, post one item by hand.
2. The crawler snapshots the native upload + the publish mutation and POSTs both
   to `/api/ext/capture`; the bridge folds them into `template.json`.
3. From then on the matching tool replays automatically.
4. If Facebook rotates its payload and replay breaks, re-capture (post one more by
   hand). No code change needed.

## Notes

- **No secrets hardcoded.** The callback secret is handed to the extension by the
  bridge on WS connect and kept in `chrome.storage.local`. Volatile FB tokens are
  scraped live from the page at replay time.
- Ships **no** `declarativeNetRequest` rules: requests already originate from
  facebook.com with the right cookies + origin, so no header/origin rewriting.
