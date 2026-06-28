# FB native web Reel upload+publish — fully decoded protocol

Reverse-engineered from `captures/trace.jsonl` (a full scheduled-reel post on facebook.com Comet web).
All hosts/ids are per-session/dynamic. Replay runs in the page main world (injected.js) so it
carries the real cookies + origin; tokens are read fresh from the page each run.

## Shared dynamic values (read fresh from page via readTokens())
fb_dtsg, lsd, jazoest, __user (=av/target_id/actor_id), plus the spin/dyn params live in the page.
A per-post `composer_session_id` = a fresh UUID (also reused as waterfall_id).

## Step 1 — upload config (host discovery)
graphql `useComposerVideoUploaderConfigQuery` response contains:
  `resumable_service_name` = "rupload-sin2-1.up"   `resumable_service_domain` = "facebook.com"
  → rupload host = `https://rupload-sin2-1.up.facebook.com`
(Region varies. Query it, OR cache last-known from the trace as a fallback.)

## Step 2 — START
`POST https://vupload-edge.facebook.com/ajax/video/upload/requests/start/?av=<uid>&__a=1`
body (urlencoded): file_size=<bytes>&file_extension=mp4&target_id=<uid>&source=reel_composer
  &waterfall_id=<uuid>&composer_session_id=<uuid>&composer_entry_point_ref=profile_reels
  + fresh tokens (fb_dtsg, jazoest, lsd, __user, av, __a=1 …)
RESPONSE (strip `for (;;);`): payload = {
  video_id,            ← used everywhere below
  upload_session_id,   ← becomes the transfer `id` header
  start_offset:0, end_offset:1048576, skip_upload:false }

## Step 3 — TRANSFER bytes
`POST https://<rupload_host>/fb_video/<randomhex32>-0-<size>?<same tokens as start url>`
  headers:
    id = <upload_session_id>            product_media_id = <video_id>
    offset = 0   start_offset = 0   end_offset = <size>
    X-Entity-Length = <size>   X-Total-Asset-Size = <size>
    X-Entity-Type = application/octet-stream   X-Entity-Name = undefined
    composer_session_id = <uuid>
  body = raw video bytes (Blob). (FB chunks big files by start/end_offset; for our short
  reels a single shot with offset 0..size works — server returned full handle.)
RESPONSE: { "h": "1:....\n1:....\n..." }   ← newline-joined chunk handles
  <randomhex32> = client-generated 32-hex upload id (x-entity-name is "undefined", so arbitrary).

## Step 4 — RECEIVE (finalize)
`POST https://vupload-edge.facebook.com/ajax/video/upload/requests/receive/?av=<uid>&__a=1`
body (multipart/form-data): field `fbuploader_video_file_chunk` = the `h` string from step 3
  (+ tokens). RESPONSE payload {start_offset:<size>, end_offset:<size>} = fully received.

## Step 5 — PUBLISH
`POST https://www.facebook.com/api/graphql/`
  fb_api_req_friendly_name=ComposerStoryCreateMutation   doc_id=27638478529090712
  variables.input.message.text = caption
  variables.input.attachments[0].video.id = <video_id>
  variables.input.attachments[0].video.video_generation_params.web_reels_composer_video_edits.source_video_id = <video_id>
  variables.input.composer_session_id = <uuid>
  (+ fresh fb_dtsg/lsd/jazoest/__user/spin tokens)
  For SCHEDULED: add scheduled_publish_time (epoch s) to input (field name TBD; immediate works without it).

## Confirmed linkage (this session)
video_id=998962089507663 = start.payload.video_id = transfer.product_media_id =
  publish video.id = publish source_video_id.
upload_session_id=998962096174329 = start.payload.upload_session_id = transfer header `id`.

## Replay = template-driven
The publish mutation template (`template.graphql`, captured) is replayed with substitutions:
{video_id, caption, fresh tokens, composer_session_id}. Steps 1-4 are reproduced programmatically
from this doc. Re-capture (one trace) if FB rotates doc_id / config shape.
