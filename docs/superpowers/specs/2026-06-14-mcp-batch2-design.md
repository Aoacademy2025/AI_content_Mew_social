# MCP batch 2 — design spec (2026-06-14)

Five improvements to the MCP "Creator Studio" tools, from duckyhero's first real avatar e2e via cowork. All in the MCP vertical (`src/lib/mcp/*`, `src/app/api/[transport]/route.ts`) — reuse existing web endpoints via the service-auth seam, no fork. No Prisma schema change.

## Scope (5 items)

1. **Avatar layout params** — avatar renders ~2× zoomed (huge face).
2. **Orchestrator step retry** — a transient "fetch failed" killed an 8-min job; no retry today.
3. **Music param** — `create_video_job` can't add bgm; the web can.
4. **Helper tool `get_video_options`** — so the wizard presents REAL choices (music/avatars/voices).
5. **Guided wizard + ETA honesty** — `SERVER_INSTRUCTIONS` flow + accurate progress expectations.

**Out of scope:** real push-on-done notifications (would need email/LINE/webhook — separate phase); the web avatar preview-vs-render scale mismatch (web-side / wao's vertical); `direct`/upload avatar; parallel generation.

---

## Item 1 — Avatar layout params (zoom fix)

**Root cause (verified — two SEPARATE scales, we conflated them):** the web editor uses TWO different scales (`video-editor/page.tsx`):
- **HeyGen framing** (how HeyGen frames the avatar within its own render) = constant `HEYGEN_FRAMING = {scale:2.02, offsetX:0, offsetY:0.13}` (`:1866`), sent to `generate-with-bg` (`:1917,2029`).
- **Composite layer** (how the generated avatar is scaled/placed on the bg frame) = `{scale: avatarScale, offsetX: avatarOffsetX, offsetY: avatarOffsetY}` (`:1993`) where the working default is **scale 1 / 0 / 0** (`scale 1 = เต็มเฟรม`, types.ts:139; confirmed by the user's preview screenshot: SCALE 1, OFFSET 0/0 → correct head-and-shoulders).

Our `avatar-steps.ts` used `AVATAR_LAYOUT = {scale:2.02,...}` for **both** generate AND composite. The composite then did `layoutGeometry` `w = 1080 * 2.02 ≈ 2182px` → avatar at ~202% frame → **huge zoomed face**. The composite layer should be **scale 1 / 0 / 0**, not 2.02.

**Fix:** split the two in `avatar-steps.ts`:
- `HEYGEN_FRAMING = {scale:2.02, offsetX:0, offsetY:0.13}` (constant) → `generate-with-bg` only. NOT exposed.
- composite `avatarLayout` defaults to `{scale:1, offsetX:0, offsetY:0}` and is **tunable** via optional `create_video_job` params:
```ts
avatarScale?:   z.number().min(0.1).max(2.5).optional()  // default 1 (composite layer; 1 = fill frame)
avatarOffsetX?: z.number().min(-2).max(2).optional()     // default 0
avatarOffsetY?: z.number().min(-2).max(2).optional()     // default 0
```
- `resolveAvatarRequest` returns these (clamped, defaulted to 1/0/0); orchestrator threads them into `runAvatarComposite`, which uses `HEYGEN_FRAMING` for generate and the tuned layer values for composite.

## Item 2 — Orchestrator step retry (no more silent death on a blip)

**Root cause (verified):** job `cmqdplo5h004` failed at step `stock` with `errorMessage = "fetch failed"` — a raw `fetch()` transport error (not an HTTP error response) on the internal call to `/api/videos/fetch-stock`. `pipeline-client`'s `req()` (`pipeline-client.ts:18-23`) has **no retry**; only `pollRender` tolerates blips. One transient failure kills the whole job.

**Fix:** add a small retry wrapper in `pipeline-client.ts` for `post`/`get` — retry on **transport errors and 5xx only** (NOT on 4xx in-band errors like missing_key/quota), 2 retries, exponential backoff (e.g. 1s/3s), injectable sleep for tests. Apply to the orchestrator's step calls (tts/keywords/stock/config). Idempotency: these steps are safe to retry (they don't reserve clips; render reservation is separate and already refund-balanced).

## Item 3 — Music (`bgmFile`) param

**Ground truth:** `GET /api/music` → `{ tracks: [{ id, title, filename, duration }] }` (`api/music/route.ts`, `getCurrentUser` → seam-compatible). The web sets `config.bgmFile = "/music/{filename}"` and `config.bgmVolume` (default `0.28`, `video-creator:399,1001-1003`). `ShortVideoConfig` has `bgmFile?`/`bgmVolume?` (`remotion/types.ts`). The MCP `buildConfigPayload` does **not** set bgm today.

**Fix:** add to `create_video_job`:
```ts
bgmFile?:   z.string().optional()                       // a "/music/{filename}" path (from get_video_options)
bgmVolume?: z.number().min(0).max(1).optional()         // default 0.28
```
Persist into the job input; in the orchestrator, after `buildConfigPayload(...)` returns `cfgRes.config`, inject `{ ...config, bgmFile, bgmVolume }` when `bgmFile` is set (mirror the web's post-build injection). No change to `buildConfigPayload` itself.

## Item 4 — Helper tool `get_video_options`

New read-only MCP tool (PRO/BUSINESS, same gate) so the assistant can present real choices in the wizard. Aggregates (all seam-compatible, called via `pipelineCaller(userId)`):
- **music:** `GET /api/music` → `[{ id, title, filename, bgmFile: "/music/"+filename }]`.
- **avatars:** if `heygenKey` set → `GET /api/heygen/avatars` → `[{ avatarId, name, previewImageUrl }]`; include the user's saved `heygenAvatarId`. If no key → `{ needsKey: true }`.
- **voices:** gemini = the static list from `src/lib/gemini-voices.ts`; elevenlabs = if `elevenlabsKey` set → `GET /api/elevenlabs/voices` → `[{ voiceId, name }]` else `{ needsKey: true }`; include saved `geminiVoiceName`/`elevenlabsVoiceId`.
- **avatarModes:** static `["none","full","bookend","bookend-both"]`.

Each sub-fetch is wrapped so one failure (e.g. HeyGen down) degrades to `{ error }` for that section, not the whole tool. Registered in `[transport]/route.ts` via `runTool` like the other read tools.

## Item 5 — Guided wizard + ETA honesty (`SERVER_INSTRUCTIONS`)

**ETA:** `create_video_job` success response gains a human note, e.g. `nextStep: "งานเข้าคิวแล้ว — base ~2 นาที, avatar ~10–20 นาที. เช็คด้วย get_video_status เป็นระยะ (อย่าถี่เกินทุก ~1–2 นาที)"`.

**Wizard flow** — add a section to `SERVER_INSTRUCTIONS` (in `onboarding.ts`):
> เมื่อผู้ใช้สื่อว่าจะทำวิดีโอ (เช่น "วิดีโอ HERO AI") ให้เข้าโหมดไกด์ ถาม **ทีละข้อ** (ไม่ถามรวด): (1) สคริปต์ → (2) เสียง gemini/elevenlabs [ใช้ get_video_options เสนอเสียงจริง] → (3) เพลง bgm เอา/ไม่เอา [เสนอ track จาก get_video_options] → (4) b-roll: auto (ไม่ต้องถามมาก) → (5) avatar none/full/bookend/bookend-both [ถ้าเอา เสนอ avatar จาก get_video_options + ถามขนาด avatarScale ถ้าผู้ใช้อยากปรับ]. สรุปยืนยัน → create_video_job. แล้ว poll get_video_status เป็นจังหวะ (ไม่รัว) รายงานความคืบหน้า; ถ้า status=failed อธิบาย errorMessage + เสนอสร้างใหม่ (retry); เสร็จ report ลิงก์ download. **ห้ามสัญญาว่าจะแจ้งเตือนเอง** — MCP ส่ง push ไม่ได้; ให้บอกผู้ใช้พิมพ์ "เช็ควิดีโอ" เมื่อผ่านไปตาม ETA.

This is instruction copy only — no enforcement; relies on the helper tool (item 4) for accurate options.

## Item 6 — Subtitle position + words-per-card

**Ground truth:** each subtitle card is a `KeywordPopupItem` with `topPercent?` (vertical position, `% from top`, default 38 — `remotion/types.ts:96`). The system already has a fixed set of **split modes** (`video-editor/page.tsx:274`): `"sentence" | "1" | "2" | "3" | "4" | "custom"`, labelled **ประโยค / 1·2·3·4 คำ** (`:3223-3227`, applied by `splitCaptionsByMode` `:2764` over the TTS-timing captions). The MCP orchestrator currently builds sentence-level cards via `captionsFromTtsTiming(..., maxCardChars)`.

**Fix — expose two optional params on `create_video_job`, using the SYSTEM's exact option set (not arbitrary numbers):**
```ts
subtitleMode?: z.enum(["sentence","1","2","3","4"]).optional()  // = the editor's split modes; default "sentence"
subtitlePosition?: z.enum(["top","middle","bottom"]).optional() // → topPercent; default "bottom"
```
- `subtitleMode` maps 1:1 to the editor modes (ประโยค / N คำ per card). The orchestrator applies the chosen mode by **reusing the same split logic the editor uses** (`splitCaptionsByMode` — extract its pure word-splitting into a shared helper, or call it equivalently after `captionsFromTtsTiming`). NO new chunking algorithm. (`"custom"` is out of scope for v1 — the 5 presets cover it.)
- `subtitlePosition` → set `topPercent` on every emitted card (and in `buildBurnConfig`): top→~12, middle→~45, bottom→~78 (exact values dialed in during e2e against the renderer).
- Wizard (item 5) offers EXACTLY these 5 modes with the editor's hints (1="แรงมาก", 2="TikTok", 3="แนะนำ อ่านง่าย", 4="ประโยคสั้น", sentence="ตามประโยค") + position top/middle/bottom.
- **Note:** "N คำ/การ์ด" is fully supported (it IS a system mode). The only thing NOT forceable is a fixed TOTAL sentence count for the whole clip (e.g. "ทั้งคลิป 3 ประโยคพอดี") — that follows the script/timing; the wizard says so.

---

## Testing

- `verify-avatar-steps.ts` — extend: layout params flow through generate + composite per mode; defaults 2.02/0/0.13.
- `verify-mcp-avatar-input.ts` — extend `resolveAvatarRequest`: avatarScale/offset clamp + defaults.
- `verify-pipeline-retry.ts` (new) — retry wrapper: retries transport error + 5xx (mock), gives up after N, does NOT retry 4xx; injectable sleep.
- `verify-get-video-options.ts` (new) — mock pipeline-client: aggregates music/avatars/voices; one section failing degrades gracefully.
- `verify-mcp-orchestrator.ts` — extend: bgmFile injected into config; avatar layout passed.
- `verify-mcp-onboarding.ts` — extend: SERVER_INSTRUCTIONS has the wizard flow + "ห้ามสัญญาว่าจะแจ้งเตือน".
- Manual e2e via cowork: wizard run → music + avatar (tuned scale) → progress → final report.

## Files touched

- `src/app/api/[transport]/route.ts` — schema (avatarScale/offset, bgmFile/bgmVolume) + gating + `get_video_options` tool + ETA in create response.
- `src/lib/mcp/avatar-steps.ts` — layout params in `resolveAvatarRequest` + `runAvatarComposite`.
- `src/lib/mcp/pipeline-client.ts` — retry wrapper.
- `src/lib/mcp/orchestrator.ts` — pass layout, inject bgmFile, use retry.
- `src/lib/mcp/onboarding.ts` — wizard flow in SERVER_INSTRUCTIONS.
- `src/lib/mcp/video-options.ts` (new) — `get_video_options` aggregator.
- `scripts/verify-*.ts` — as above.

No schema change; no `buildConfigPayload`/composite/endpoint change (reuse only).
