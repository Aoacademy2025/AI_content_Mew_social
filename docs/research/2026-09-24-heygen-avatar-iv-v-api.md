# HeyGen Avatar IV/V API: migration evidence

**Research date:** 2026-09-24 (Asia/Bangkok)
**Method:** current official HeyGen developer documentation and HeyGen Help Center only. This is a source review, not an API call, render, billing check, or integration audit.

## Confirmed v3 request path

HERO's pre-recorded narration maps to **`POST https://api.heygen.com/v3/videos`**. For an avatar render, use `type: "avatar"`, an avatar **look** ID in `avatar_id`, and exactly one of `audio_url` (public HTTPS) or `audio_asset_id`; both audio fields are mutually exclusive with `script`. The response starts an asynchronous job and includes `data.video_id`, initial status, and resolved `output_format`. [Audio to Video](https://developers.heygen.com/audio-to-video) · [Create Video schema](https://developers.heygen.com/reference/create-video) (accessed 2026-09-24)

For HERO-held audio, upload MP3/WAV through multipart `POST /v3/assets` (32 MB cap), retain the returned asset ID, then send it as `audio_asset_id`. Larger files use the documented direct-upload initialize/PUT/complete flow; completion is idempotent and is required before the asset can be used. The create-video limits also permit public WAV/MP3 resources up to 50 MB. [Upload Assets](https://developers.heygen.com/docs/upload-assets) · [Usage Limits](https://developers.heygen.com/docs/usage-limits) (accessed 2026-09-24)

**Duration gate:** HeyGen's Audio to Video guide says one request can follow audio up to 30 minutes, while the same publisher's Usage Limits says avatar audio input is limited to 10 minutes (and output scenes to 30 minutes). These conflict. Until HeyGen resolves it for the account, enforce **10 minutes or less per direct avatar request** and segment longer audio; do not assume 30-minute audio is accepted. [Audio to Video](https://developers.heygen.com/audio-to-video) · [Usage Limits](https://developers.heygen.com/docs/usage-limits) (accessed 2026-09-24)

## Avatar IV/V selection and metadata

`GET /v3/avatars/looks` lists the renderable looks; its `id` is the value for `avatar_id`. The response exposes `avatar_type`, `group_id`, `status`, default voice, previews, and `supported_api_engines`. `GET /v3/avatars/looks/{look_id}` returns one look. A request for an engine absent from `supported_api_engines` returns `invalid_parameter`. [Avatar Looks](https://developers.heygen.com/docs/avatar-looks) (accessed 2026-09-24)

* **Avatar IV:** default when `engine` is omitted; it can be explicit as `{"type":"avatar_iv"}`. HeyGen documents it for studio avatars, digital twins, photo avatars, arbitrary images, and prompt avatars. [Avatar IV](https://developers.heygen.com/avatar-iv) (accessed 2026-09-24)
* **Avatar V:** explicit `engine: {"type":"avatar_v"}`; HeyGen documents it as opt-in only for eligible **digital-twin** looks. Select it only if the selected look's `supported_api_engines` contains `"avatar_v"`. A V `reference_look_id`, if used, must be a digital-twin look in the same group. [Avatar V](https://developers.heygen.com/avatar-v) (accessed 2026-09-24)

There is no documented universal IV/V compatibility flag at avatar-group level. Eligibility is per **look**, and neither `avatar_id` presence nor a name/model label proves V eligibility. Fetch/cache the selected look metadata before enabling a model choice; preserve the requested engine in HERO's job record.

## Compositor and output limits

For alpha compositing, request top-level `output_format: "webm"`. It returns an alpha-capable WebM, removes the background automatically, requires a matting-trained avatar, and rejects a simultaneous `background` value. Default MP4 is opaque. The published look schema does not expose a matting capability field, so a successful IV/V eligibility check does **not** prove transparent-output eligibility. Do not retry a rejected WebM request as opaque MP4 automatically; make it an explicit user/workflow choice. [Transparent Background Videos](https://developers.heygen.com/transparent-background-videos) · [Create Video schema](https://developers.heygen.com/reference/create-video) (accessed 2026-09-24)

Supported `resolution` values are `720p`, `1080p`, and `4k`; supported aspect ratios are `16:9`, `9:16`, `4:5`, `5:4`, `1:1`, and `auto` (default `16:9`). IV and V render the avatar at up to 1080p; a 4K request composites that avatar onto a 4K canvas rather than making it native 4K. Treat output format, aspect ratio, resolution, and requested transparent output as explicit compositor inputs, never inferred defaults. [Create Video schema](https://developers.heygen.com/reference/create-video) (accessed 2026-09-24)

## Async lifecycle, errors, and replay safety

Poll `GET /v3/videos/{video_id}` until terminal `completed` or `failed`, or supply `callback_url` plus a caller-controlled `callback_id`. Status details include `video_url` when ready and `failure_code`/`failure_message` on failure. Persistent webhook deliveries must verify their HMAC signature and de-duplicate by `event_type` plus `event_data.video_id`, or by `callback_id`; HeyGen may retry deliveries for up to 24 hours. [Get Video](https://developers.heygen.com/reference/get-video) · [Webhooks](https://developers.heygen.com/docs/webhooks) (accessed 2026-09-24)

Send a stable `Idempotency-Key` header for each logical create request. Retries with the same key within 24 hours replay the original response; a concurrent duplicate reports `409 request_in_progress`. Do not change the body while reusing the key. Expected handling: respect `Retry-After` and back off on `429`; surface `400 invalid_parameter`, `402` credit/plan failures, and terminal `failed` jobs without substituting another avatar, engine, output format, or paid route. [Create Video schema](https://developers.heygen.com/reference/create-video) · [Error Codes](https://developers.heygen.com/docs/error-codes) (accessed 2026-09-24)

## Billing and no-surprise-charge constraints

API-key production use is documented as API billing; OAuth/MCP is documented as drawing from the user's web subscription credits. The Help Center describes API pay-as-you-go credits as standalone from Creator/Pro/Business web subscriptions, while `GET /v3/users/me` identifies the authenticated account's actual billing type (`wallet`, `subscription`, or `usage_based`) and remaining balance/spending cap. Thus, do not turn a published web-plan credit rate into an API-key customer quote. [Developer documentation index](https://developers.heygen.com/llms.txt) · [API Pricing Explained](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) · [Get Current User](https://developers.heygen.com/user-profile) (accessed 2026-09-24)

The Help Center gives a general API rule of $1 per generated 720p/1080p avatar-video minute and says Avatar IV is $4 per 1080p minute, charged by actual generated seconds, but its detailed table is incomplete and does not publish a V rate. The developer docs point self-serve users to the account-specific API-pricing dashboard and say enterprise pricing is contract-specific. No official pre-render price-quote/estimation endpoint was found in the reviewed v3 reference. Therefore an exact HERO customer charge is **not confirmed**. [API Pricing Explained](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) · [Developer documentation index](https://developers.heygen.com/llms.txt) (accessed 2026-09-24)

`GET /v3/users/me` can report the authenticated account's actual billing type, balance, or spending-cap fields. That is account state rather than a quote, and it cannot establish the price of a future render. `402 insufficient_credit`, `subscription_required`, and `plan_upgrade_required` are the documented relevant error classes. [Get Current User](https://developers.heygen.com/user-profile) · [Error Codes](https://developers.heygen.com/docs/error-codes) (accessed 2026-09-24)

## Legacy migration date

HeyGen's current endpoint comparison marks v1/v2 operational through **2026-10-31**, with retirement/end of support on **2026-11-01**. Legacy responses advertise `Deprecation: true`, a `Sunset: Sat, 31 Oct 2026 00:00:00 GMT` header, and migration guidance to `POST /v3/videos`; v2's `POST /v2/video/generate` maps to that v3 endpoint. Migrate and stage-test before the published sunset. [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison) (accessed 2026-09-24)

## Implementation decision record

1. Preserve HERO's supplied audio by creating a v3 asset and using its `audio_asset_id`; never replace it with HeyGen TTS as recovery.
2. Resolve the selected look first and accept a requested engine only when it is in `supported_api_engines`; default explicitly to IV only when that is an approved product choice.
3. Keep the compositor contract explicit: `webm` only when transparency is requested and the configured look is already known to work with matting. Store output format and dimensions with the job.
4. Create once with an idempotency key, then poll or consume verified/deduplicated webhooks. Persist provider job ID, status, failures, and callback correlation.
5. Block automated paid fallbacks. Missing credit, blocked plan, unsupported V/matting, invalid audio, or a failed render must enter an actionable failed state for the originating workflow.

### Open gaps requiring account-level confirmation

* The exact API charge for the actual look, V versus IV, output resolution, and account contract; no reviewed public endpoint returns a quote.
* Whether the intended avatar look is V-eligible and matting-enabled; `supported_api_engines` covers the former, while published look metadata does not document the latter.
* The effective maximum accepted audio duration (official pages conflict: 10 vs 30 minutes).
* The account's API billing type, available balance/cap, and whether a key has the required asset/video read/write scopes.

## Appendix: opaque 1080×1920 green-screen preservation

### Confirmed standalone v3 shape

The current opaque green-screen path can remain opaque MP4; it does **not** require alpha WebM or background removal. The documented `type: "avatar"` v3 schema accepts `audio_asset_id`, `engine`, `aspect_ratio`, `resolution`, `background`, `fit`, `remove_background`, and `output_format`. The following is the closest documented request contract for the stated output (identifiers are placeholders):

```json
{
  "type": "avatar",
  "avatar_id": "LOOK_ID",
  "audio_asset_id": "ASSET_ID",
  "engine": { "type": "avatar_iv" },
  "aspect_ratio": "9:16",
  "resolution": "1080p",
  "output_format": "mp4",
  "background": { "type": "color", "value": "#00FF00" }
}
```

Replace the engine object with `{"type":"avatar_v"}` only when that look advertises `"avatar_v"` in `supported_api_engines`. `audio_asset_id` remains mutually exclusive with `script`, so this preserves the supplied audio instead of invoking TTS. The documented `9:16` and `1080p` settings represent a vertical 1080p canvas; the schema describes non-`16:9` ratios as short-edge anchored to the requested resolution, which yields 1080×1920 for `9:16`. [Create Video schema](https://developers.heygen.com/reference/create-video) · [Audio to Video](https://developers.heygen.com/audio-to-video) (accessed 2026-09-24)

`background` for standalone avatar video is `{ "type": "color", "value": "#RRGGBB" }`; the schema describes `value` as the required hex color for type `color`. Thus `#00FF00` is the documented green background value. Explicit `output_format: "mp4"` preserves the current opaque container; it is also the documented default. [Create Video schema](https://developers.heygen.com/reference/create-video) (accessed 2026-09-24)

### Matting and alpha are separate from green screen

The v3 request has `remove_background` (boolean). It removes the avatar background only for video avatars trained with matting enabled. `output_format: "webm"` is the alpha path: it applies removal automatically and rejects a `background` object. Therefore the opaque green request should omit `remove_background` (or leave it null/false), set `output_format: "mp4"`, and retain the color background. There is no published `matting` property in the closed standalone v3 create-video request schema; `v2 character.matting=true` has no documented one-to-one v3 request-field equivalent. Published v3 material treats matting as a prerequisite of removal/WebM, not as an enablement flag for an opaque color-background render. [Create Video schema](https://developers.heygen.com/reference/create-video) · [Transparent Background Videos](https://developers.heygen.com/transparent-background-videos) (accessed 2026-09-24)

### Canvas, scale, and position

For standalone `type: "avatar"`, HeyGen documents only `fit` for subject scaling: `cover` fills the canvas and may crop; `contain` keeps the full subject and may show the background. With `fit` omitted, the server chooses based on source and canvas orientation. No standalone-avatar `position`, `x`, `y`, percentage scale, or character-layout field appears in the published v3 request schema; that schema has `additionalProperties: false`, so such fields are not part of this request contract. `position` and `scale` found elsewhere in the same reference apply to **watermarks**, not the avatar.

Consequently, `aspect_ratio`/`resolution` map to the provider canvas and `fit` is the only published avatar sizing control for this request. Exact provider avatar placement or a numerical scale mapping from the existing v2 compositor is **not documented** here; this evidence cannot label it globally unsupported in every HeyGen product/mode, only absent from and outside the closed standalone v3 avatar schema. [Create Video schema](https://developers.heygen.com/reference/create-video) (accessed 2026-09-24)

### Look discovery: own looks and engines

Use `GET /v3/avatars/looks?ownership=private` to list the account's own looks only. It supports `group_id`, `avatar_type`, `ownership`, and `limit` (1–50, default 20). Results are cursor-paginated: when `has_more` is true, pass `next_token` as `token` on the next request. [Avatar Looks](https://developers.heygen.com/docs/avatar-looks) (accessed 2026-09-24)

The documented `supported_api_engines` values are `avatar_iii`, `avatar_iv`, and `avatar_v`; use the values returned for the selected **look** rather than treating any as universal. `avatar_iii` is a current v3 engine choice, not merely a legacy v1/v2 route: the v3 schema defines `engine: {"type":"avatar_iii"}` for eligible looks, while the endpoint comparison separately states v1/v2 routes retire after 2026-10-31. Availability of III on a particular look is still determined by `supported_api_engines`. [Avatar Looks](https://developers.heygen.com/docs/avatar-looks) · [Create Video schema](https://developers.heygen.com/reference/create-video) · [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison) (accessed 2026-09-24)
