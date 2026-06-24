# Video Editor — Bug / Security / Performance Audit (2026-06-25)

**Scope:** The Video Editor subsystem of HERO AI Creator Studio (~21,000 LOC):
- **Editor frontend** — `src/app/(dashboard)/video-editor/page.tsx` (4,855 L) + `_components/*` + `_lib/*`
- **Render/Burn backend + worker** — `api/videos/render*`, `api/renders/*`, `src/lib/render/*`, `scripts/render-worker.ts`, `src/middleware.ts`
- **Content/asset backend** — `api/videos/{fetch-stock,tts,tts-gemini,transcribe,generate-config,extract-keywords,upload,thumbnail,create-avatar,webhook,…}`
- **Remotion compositions** — `src/remotion/*`, `src/components/remotion/*`

**Method:** 4 parallel read-only audit agents, one per slice, each covering Security + Bug + Performance. Static source analysis (no runtime exploitation). Every finding carries `file:line` evidence, a **Risk-to-working-flow** rating on the *fix*, and a **Confidence** rating.

**Branch:** `mew/pricing-rework-p1` · **HEAD:** `6dea68b` · **Prod render mode:** `RENDER_VIA_QUEUE=1` (queue path live; in-process render is dev/fallback).

**Privacy/safety boundary:** This is an authorized self-audit of our own system. Reproduction detail is included so fixes can be verified. No code was modified during the audit.

---

## TL;DR (ภาษาไทย)

ระบบ **โครงสร้างดีและสร้างมาอย่างระมัดระวัง** — ไม่มี XSS, ไม่มี SQL injection, ไม่มี command injection, path traversal กันแน่น, quota reservation atomic, การคิดเงิน/กันคิดซ้ำออกแบบดี, render-vs-burn invariant ถูกต้อง

แต่เจอ **ช่องโหว่ด้าน authorization (เช็ค auth แล้ว แต่ไม่เช็คว่า "ใครเป็นเจ้าของ")** ที่ต้องรีบแก้:

- 🔴 **CRITICAL ×2** — (1) ใครก็แก้/อ่าน thumbnail+script+วิดีโอของคนอื่นได้ด้วยการเดา `videoId` (2) ใครก็สั่งยกเลิก render ของคนอื่นได้
- 🟠 **HIGH ×5** — วิดีโอที่ลูกค้าจ่ายเงินโหลดได้ทั้งอินเทอร์เน็ต · SSRF 2 จุด (server ยิง fetch URL ที่ผู้ใช้ส่งมาดิบๆ) · webhook ปลอม state วิดีโอใครก็ได้ · scene 1 เฟรมทำ render crash

**ข่าวดีสำหรับเป้าหมาย "ห้ามกระทบของเดิม" ของวิว:** ของที่ร้ายแรงที่สุดเกือบทั้งหมด **แก้แบบ additive ได้** (เติมการ์ดเช็ค ownership / clamp ค่า) — **ความเสี่ยงกระทบ flow = None/Low** ส่วนที่เสี่ยงจริง (เปลี่ยน auth model ของ `/api/renders`, เข้ารหัส BYOK key, SSRF allowlist) ผมแยกไว้ใน **Tier 2 (ต้องวางแผนก่อน)** ด้านล่าง ไม่แตะจนกว่าวิวจะอนุมัติ

---

## Executive Summary

The Video Editor is a **mature, defensively-built subsystem**. The audit found **no XSS, no SQL injection, no command injection, no path-traversal holes in the serving routes**, and several genuinely well-engineered safety mechanisms (atomic quota reservation, anti-double-charge, the TOCTOU bundle-race fix, hardened polling, WYSIWYG shared-renderer invariant).

The real risk is concentrated in one pattern: **authentication is enforced everywhere, but resource-level authorization (ownership) is missing in several routes.** A logged-in user can act on *other users'* videos/jobs by supplying a guessable id. This produces the two CRITICAL and several HIGH findings. A secondary theme — **SSRF via routes that `fetch()` user-supplied URLs** — accounts for two more HIGH findings.

Crucially for the "don't break what works" constraint: **the highest-severity fixes are additive guards** (add an ownership predicate, clamp a value, delete dead code) with **None/Low** risk to working flows. The genuinely risky changes (re-architecting `/api/renders` access, encrypting keys at rest, SSRF allowlists on shared routes) are isolated into a separate "needs planning" tier.

### Severity summary

| Severity | Count | Live in current prod? |
|---|---:|---|
| 🔴 CRITICAL | 2 | Both **live-exploitable** by any authenticated user |
| 🟠 HIGH | 6 | 5 live · 1 latent (behind the render-queue flag) |
| 🟡 MEDIUM | 13 | mix of live + latent + policy |
| ⚪ LOW | 11 | hardening / hygiene |
| **Total** | **32** | |

### Cross-cutting themes (fix the pattern, not just the instance)

1. **Missing ownership checks (IDOR)** — the dominant security gap. `thumbnail`, `thumbnail/upload`, `render-cancel`, legacy `render-status`, `webhook` authenticate the caller but never verify the caller owns the target resource.
2. **SSRF — `fetch()` on raw user URLs** — `create-avatar`, `transcribe`, `cacheImageLocally`, and CSS `url()` in `customCaptionStyle` at render time. None validate host/IP. (Note: this is bare-metal Hostinger, so the cloud-metadata vector is N/A, but `localhost`/internal-service probing and response-exfiltration via HeyGen still apply.)
3. **No server-side input validation** — `subtitleColor` / `fontFamily` / `customCaptionStyle` / script length flow from `req.json()` straight into render inputs and LLM prompts. The UI constrains these, but the **API and the MCP client bypass the UI**.
4. **World-readable rendered outputs** — `/api/renders/*` is public + `CORS: *` + low-entropy filenames → paid users' private videos are public-by-obscurity.
5. **Secret handling** — BYOK keys are base64 (not encrypted) at rest, echoed in full to the client on Settings load, and sent in Gemini URL query strings.
6. **Revenue/quota edges** — unbounded free re-burns of a paid render, FREE-plan render gate enforced only client-side, and a worker sweep/heartbeat timing inversion that can double-render (and double-charge).

---

## CRITICAL findings

### C1 — `thumbnail` & `thumbnail/upload`: IDOR — read/overwrite ANY user's video by id
- **Dimension:** Security (Authorization) · **Confidence:** High · **Prod exposure:** ✅ Live
- **Location:** `api/videos/thumbnail/route.ts:191` (`SELECT … FROM Video WHERE id = ?`), `:313` (`UPDATE Video SET thumbnail=…, thumbnailConfig=… WHERE id = ?`); `api/videos/thumbnail/upload/route.ts:43` (same `UPDATE … WHERE id = ?`)
- **Impact:** Both routes call `getCurrentUser()` but never check `Video.userId === caller`. Any logged-in user can (a) **read** another creator's `script`, `videoUrl`, `avatarVideoUrl`, `renderConfig` by guessing/enumerating `videoId`, and (b) **overwrite** any victim's `thumbnail`/`thumbnailConfig` with an attacker-chosen URL. SQL is parameterized (`?`) so this is **not** SQLi — it is pure ownership/IDOR.
- **Fix (sketch):** Before any read/write: `prisma.video.findFirst({ where: { id: videoId, userId: authUser.id } })` → 404 if no match; scope every `UPDATE` with `AND userId = ?`.
- **Risk to working flow if fixed:** **Low** — adds a predicate the legitimate owner already satisfies. `/video-editor` is the caller (SHARED route) but only passes ids it owns.

### C2 — `render-cancel`: cross-user render cancellation — no auth, no ownership, guessable id
- **Dimension:** Security (Authorization/DoS) · **Confidence:** High · **Prod exposure:** ✅ Live (queue path)
- **Location:** `api/videos/render-cancel/route.ts:9-22` → `src/lib/render/job-store.ts:175` `requestCancel(id)` = `updateMany({ where: { id, status: {in:[QUEUED,RUNNING]} } })` with **no userId scope**. Job id format: `${userId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}` (`render/route.ts:308`) — known user prefix + timestamp + **only 6 base36 chars**.
- **Impact:** The route is intentionally unauthenticated (it serves `navigator.sendBeacon` on page unload, which sends no cookies). Combined with `requestCancel` matching by id alone and the low-entropy guessable id, an attacker can cancel a victim's in-flight render — griefing a **paid** feature.
- **Fix (sketch):** Add a per-render random `cancelToken` (≥128-bit) stored on the job; `render-cancel` must match `id + cancelToken`. Keep the no-cookie beacon path but make it require the token. Where cookies *are* available (the editor can also `fetch(..., {keepalive:true})`), additionally scope by authenticated `userId`.
- **Risk to working flow if fixed:** **Medium** — SHARED by `/video-editor` **and** `/video-creator` unload handlers (`video-editor/page.tsx:593,613`, `video-creator/page.tsx:532`). Additive `cancelToken` (without removing the existing path) keeps it low-risk; **build-verify both unload-cancel flows** before merge.

---

## HIGH findings

### H1 — `/api/renders/[filename]`: every rendered video is world-readable (public + `CORS: *` + low-entropy names)
- **Dimension:** Security · **Confidence:** High · **Prod exposure:** ✅ Live
- **Location:** `api/renders/[filename]/route.ts:99-137` (GET, no `getCurrentUser`), `:41` (`Access-Control-Allow-Origin: *`); `middleware.ts:25` whitelists `/api/renders(.*)` as public. Filenames `render-${Date.now()}-${6×base36}.mp4` (`run-render.ts:353`).
- **Impact:** All outputs sit in one flat `public/renders/` dir, served unauthenticated to anyone; `CORS: *` lets any site fetch them. Paid users' private videos are protected only by a low-entropy filename. `cacheImageLocally` (C-tier) also writes external images into the same shared, multi-tenant, public dir.
- **Why it's hard:** Remotion's headless Chromium fetches these URLs over HTTP **during render**, so the GET cannot simply require a session cookie without breaking rendering.
- **Fix (sketch, staged):** (1) **Now, Low-risk:** raise filename entropy to `crypto.randomUUID()` (≥128-bit) and drop `CORS: *` to the app origin for user downloads. (2) **Later, needs design:** signed expiring URLs, with the render pipeline passing the token to Chromium.
- **Risk to working flow if fixed:** entropy bump = **Low**; auth-model change = **High** (engine depends on unauthenticated GET). See Tier 2.

### H2 — `create-avatar`: SSRF — server fetches arbitrary user-supplied URLs
- **Dimension:** Security (SSRF) · **Confidence:** High · **Prod exposure:** ✅ Live
- **Location:** `api/videos/create-avatar/route.ts:34-43` (`readAsset` does `fetch(url)` with no host/IP/protocol check), invoked at `:211` (`s.audioUrl`), `:155` (`bgVideoUrl`); `s.imageUrl` forwarded to HeyGen as `background.url` at `:233`.
- **Impact:** Body fields `scenes[].audioUrl`, `bgVideoUrl`, `imageUrl` are attacker-controlled. The server (or HeyGen, for `imageUrl`) will fetch `http://127.0.0.1:<port>`, internal IPs, etc. Because fetched bytes are uploaded to HeyGen and readable back, this is a **readable** SSRF, not just blind.
- **Fix (sketch):** Restrict these fields to relative `/api/renders|/api/stocks` paths (the legitimate flow) or an allowlist of provider hosts; reject private/loopback/link-local ranges; re-validate after redirects.
- **Risk to working flow if fixed:** **Medium** — SHARED with `/video-creator`; some `imageUrl` paths are legitimately remote (Pexels/Pixabay/kie) → allowlist those hosts. Build-verify avatar render. See Tier 2.

### H3 — `transcribe`: SSRF — `fetch(audioUrl)` on a raw user URL
- **Dimension:** Security (SSRF) · **Confidence:** High · **Prod exposure:** ✅ Live (remote branch)
- **Location:** `api/videos/transcribe/route.ts:865` `await fetch(audioUrl)` in the non-local branch (`:858-871`). Local-path branches (`:851-857`) are correctly prefix-bounded to `/api/stocks|/renders`.
- **Impact:** Same SSRF class as H2; the fetched file is then written and ffmpeg-processed. Blind SSRF via timing/error differentiation.
- **Fix (sketch):** Gate the remote branch behind the same host-allowlist / private-IP rejection, or require local paths (the legitimate transcribe input is always a local render/stock URL).
- **Risk to working flow if fixed:** **Low–Medium** — transcribe is the fallback path; legit callers use local URLs (safe branch). SHARED. See Tier 2.

### H4 — `videos/webhook`: no signature, no ownership — spoof any video's completion
- **Dimension:** Security (Auth) · **Confidence:** High · **Prod exposure:** ⚠️ Reachable by any authenticated user (not external)
- **Location:** `api/videos/webhook/route.ts:6-79` — accepts `{ videoId, status, video_url, thumbnail }`, `findUnique({ where: { id: videoId } })`, updates state with **no HMAC/secret and no caller-ownership check**. Contrast `payments/webhook` (`stripe.webhooks.constructEvent`) and `clerk-webhook` (svix).
- **Impact:** The route is **not** in `isPublicRoute`, so Clerk 401s unauthenticated callers — meaning a real external HeyGen/n8n callback could never reach it (it appears to have **no in-repo caller** — effectively dead). But any *logged-in* user passes Clerk and can mark **any** `videoId` `COMPLETED` and inject an arbitrary `video_url`/`thumbnail` into another user's record (stored content injection).
- **Fix (sketch):** Decide intent. If unused → **delete it**. If needed → add to the public matcher **and** verify a shared-secret HMAC (`timingSafeEqual`) + resolve the owner from the stored job, not the body.
- **Risk to working flow if fixed:** **None** — no in-repo caller; deleting or locking it down changes nothing live. (Top Tier-1 candidate.)

### H5 — Render crash on a 1-frame scene (`fade-in` interpolate equal-endpoint throw)
- **Dimension:** Bug · **Confidence:** High · **Prod exposure:** ✅ Live (input-dependent)
- **Location:** `src/remotion/VideoComposition.tsx:85` — `interpolate(frame, [0, Math.round(d*0.4)], [0,1], …)` with `d = Math.max(durationFrames,1)`. At `d===1`, range is `[0,0]` → Remotion throws *"inputRange must be strictly monotonically non-decreasing"* → the **whole render aborts**.
- **Impact:** A degenerate 1-frame image scene (rounding collision / very short segment) crashes the render for that job. Only `fade-in` is affected (the `pulse` 3-point range stays monotonic).
- **Fix (sketch):** `Math.max(1, Math.round(d*0.4))`.
- **Risk to working flow if fixed:** **None** — only changes behavior for `d≤2` where it currently crashes; identical output otherwise. (Top Tier-1 candidate.)

### H6 (latent) — Legacy `render-status` IDOR — returns any user's job result by id
- **Dimension:** Security · **Confidence:** Medium · **Prod exposure:** 🟡 Latent (prod queue branch is safe)
- **Location:** `api/videos/render-status/route.ts:40-55` — legacy branch returns `{status, videoUrl, error}` with no `userId` check (the file-based job has no `userId` field). The **queue branch (`:23`) DOES check ownership** — so the active prod path is safe; the gap is the fallback/dev branch.
- **Impact:** If the queue flag is ever toggled off, any authed user could read another user's `videoUrl` (→ world-readable via H1) and error text.
- **Fix (sketch):** Persist `userId` in the `.tmp/render-jobs/*.json` payload and compare in the legacy branch, mirroring the queue branch.
- **Risk to working flow if fixed:** **Low** — additive field + guard. SHARED.

---

## MEDIUM findings

| ID | Title | Dim | Location | Fix-risk | Prod |
|---|---|---|---|---|---|
| M1 | **Free re-burn is unbounded** — `ChargedClip` has no uniqueness; a paid render can be re-burned (a full render each time) unlimited times for free | Sec (revenue) | `schema.prisma:446-453`, `clip-charge.ts:79-94`, `render/route.ts:361` | Medium (policy) | Live |
| M2 | **FREE plan can render despite `allowVideoEditor:false`** — gate is client-side only; no server check | Sec/Bug | `plan-limits.ts:14`; render route has no `allowVideoEditor` check | Medium (product) | Live |
| M3 | **Worker sweep/heartbeat timing inversion** — sweep `staleMs=90s` < watchdog `STALL_MS=120s` → a slow-but-healthy render can be reclaimed → duplicate render + duplicate `ChargedClip` | Bug/Reliability | `render-worker.ts:78-99,153`, `job-store.ts:264` | Low | Live (gated by single-worker serialization) |
| M4 | **BYOK keys are base64, not encrypted, + full keys echoed to client** on Settings GET | Sec (secrets) | `user/api-keys/route.ts:8-9,22-31` (+ ~12 routes inline-decode) | Medium (mask-only = Low) | Live |
| M5 | **Gemini key in URL `?key=…`** — log/proxy leakage (Nginx access logs); the `x-goog-api-key` header is already sent alongside (redundant) | Sec (secrets) | `tts-gemini:84`, `transcribe:536,663,700` | Low–Med | Live |
| M6 | **`customCaptionStyle`/color/font unvalidated** → CSS-injection surface; `url()` in a custom style triggers an outbound fetch from the render Chromium (SSRF-lite). Bounded by React inline-style escaping (no markup/script exec) | Sec | `renderSubtitle.tsx:317,343,402`, `CaptionOverlay.tsx:46-114`; unvalidated at `generate-config/route.ts:163-213` | Medium | Live (via API/MCP, not UI) |
| M7 | **`glow`/`glow-pulse` → `NaN` textShadow** for non-`#rrggbb` colors (`#fff`, `red`, `rgb()`) → glow silently drops | Bug | `renderSubtitle.tsx:173-176,302-304` | Low | Live |
| M8 | **`extract-keywords` has no input length cap** (full script into LLM prompts) — DoS/cost; sibling `split-script` caps at 12k | Bug/DoS | `extract-keywords/route.ts:248,582,652,678` | None | Live |
| M9 | **Per-frame token re-segmentation** — `tokenLines()`+`activeTokenIndex()` run every frame for karaoke/highlight (Segmenter is cached, the tokenization isn't) → wasted CPU on the no-GPU VPS | Perf | `renderSubtitle.tsx:186-188,227-228` | Medium (timing path) | Live |
| M10 | **Legacy in-process render has no job-concurrency cap** → OOM if `RENDER_VIA_QUEUE` toggled off (queue worker is 5G-capped & serial; web process is not) | Perf/Reliability | `render/route.ts:787`, `run-render.ts:129-134` | Low (cleanup) | Latent |
| M11 | **Unbounded audio-peak cache** — module-level `Map` keyed by `voiceUrl`, never evicted; grows for the SPA session | Perf (mem) | `_components/useAudioPeaks.ts:5` | Low | Live |
| M12 | **Avatar-poll `visibilitychange` listener can linger** if the tab unmounts while hidden (resolves only on a future visibility/abort event) | Bug | `page.tsx:2267` | Low | Live |
| M13 | **`EFFECT_KEYFRAMES` injected as duplicate `<style>` tags** via `dangerouslySetInnerHTML` — **NOT XSS** (static constant / parsed-int RGB only), just redundant DOM | Perf/hygiene | `RightSettingsPanel.tsx:187,218`, `EffectPreviewCard.tsx:46` | Low–Med | Live |

---

## LOW findings (hardening / hygiene)

| ID | Title | Dim | Location | Fix-risk |
|---|---|---|---|---|
| L1 | `trim-audio` / `audio-duration` join user `audioUrl` into `public/` without explicit `..` rejection (limited to existence-oracle + ffmpeg-over-arbitrary-file; no content exfil) | Sec | `trim-audio:64-66`, `audio-duration:61` | None |
| L2 | `upload` (green-screen) accepts any extension/MIME, weaker than `upload-avatar` (octet-stream serving neutralizes inline-XSS, so hardening only) | Sec | `upload/route.ts:32-37` | Low |
| L3 | `cacheImageLocally` downloads external images with no size cap into the public dir (memory spike + SSRF-to-public-mirror + disk growth) | Perf/Sec | `render/route.ts:68-88` | Low |
| L4 | `generate-voice` uses bare `fetch` (no timeout/budget), serial per-scene — bypasses the `fetchWithBudget` storm fix (likely legacy/dead) | Perf/Bug | `generate-voice/route.ts:85-116` | Low |
| L5 | `fetch-stock` Auto-Mix/photo/kie searches bypass `fetchWithBudget` (no per-attempt timeout) — **admin-only** paths; no over-fetch regression | Perf | `fetch-stock/route.ts:435–655,713,728` | Low |
| L6 | `ffmpeg-path.ts` uses `execSync("which ffmpeg")` (blocks event loop; static string, no injection) — memoize the resolved path (called per-bgVideo in a loop) | Perf | `ffmpeg-path.ts:17`, `render/route.ts:635` | Low |
| L7 | Vestigial `<audio ref={audioRef}>` — unmuted but never played; future `.play()` would double audio | Bug (dead code) | `page.tsx:4852` | Low |
| L8 | Clip-resize pointer-up pushes the render-closure `captions` to undo history instead of the live `captionsRef.current` → possible 1-step-stale undo | Bug | `page.tsx:4565,4532` | Low |
| L9 | `previewScale` differs between the live overlay (260/1080) and the settings preview strip (220/1080) — preview-vs-preview cosmetic mismatch (burn path is correct) | Bug (cosmetic) | `page.tsx:3318` vs `RightSettingsPanel.tsx:123` | Low |
| L10 | `VideoClip` `endAt` can drop ≤ `safeStart` for ultra-short stock clips → potential `OffthreadVideo` range error (rare; upstream 0.5s clamp mitigates) | Bug | `ShortVideoComposition.tsx:66-70` | None |
| L11 | `news`/`box-*` presets re-add a text shadow when the global `shadow` decoration is on (handled by `mergeTextShadow`; confirm-only, not a bug) | Bug | `renderSubtitle.tsx:379,387,410` | Low |

---

## Remediation plan — grouped by Risk-to-working-flow

> Ordering principle (per Mew's constraint): **ship the additive, zero/low-risk fixes first; gate anything that touches a shared contract, the timing minefield, or a product policy behind a planning step.**

### 🟢 Tier 1 — Safe to fix now (Risk: None/Low · additive guards, no behavior change for legit flows)
Highest value-to-risk. Can be one PR (or two: security + bugs).

1. **C1** thumbnail IDOR → add `userId` ownership predicate to read + both writes. *(Low)*
2. **H4** `videos/webhook` → delete (no caller) or lock behind HMAC. *(None)*
3. **H5** 1-frame render crash → `Math.max(1, Math.round(d*0.4))`. *(None)*
4. **C2** render-cancel → add `cancelToken` (additive; keep the beacon path). *(Low–Med — build-verify both unload flows)*
5. **H6** legacy render-status → persist+check `userId`. *(Low)*
6. **H1 (part 1)** `/api/renders` → `crypto.randomUUID()` filenames + tighten `CORS` to app origin. *(Low — defer the auth-model redesign to Tier 2)*
7. **M7** glow `NaN` → hex-normalizer before `parseInt`. *(Low)*
8. **M8** extract-keywords → add the 12k length cap (match split-script). *(None)*
9. **L1** trim-audio/audio-duration → `path.resolve().startsWith(baseDir)` assertion. *(None)*
10. **M11** audio-peak cache → LRU cap (~20). *(Low)* · **M12** avatar listener → subscribe to abort signal. *(Low)*
11. **M4 (part 1)** Settings GET → return masked keys (last-4) instead of plaintext. *(Low — independent of the at-rest encryption change)*

### 🟡 Tier 2 — Needs planning (Risk: Medium/High · shared contracts, timing minefield, or design work)
Report + decide before touching. Each needs a short design note + build-verify.

- **H2/H3** SSRF allowlist on `create-avatar` + `transcribe` (+ **L3** cacheImageLocally, **M6** `url()` in custom style). Needs the **allowlist of legitimate provider hosts** (Pexels/Pixabay/kie/HeyGen) so we don't break remote `imageUrl`. Single shared `assertSafeFetchUrl()` helper applied across all four. *(Medium — SHARED avatar/transcribe flows; build-verify avatar + uploaded-media transcribe.)*
- **H1 (part 2)** `/api/renders` access model — signed/expiring URLs with token passed to Chromium. *(High — render engine depends on unauthenticated GET; design + staged rollout.)*
- **M4 (part 2)** Encrypt BYOK keys at rest (AES-GCM, server secret) — touches the shared base64 decode helper used by ~12 routes; **codebase-wide**, not editor-only. *(Medium.)*
- **M5** Drop Gemini `?key=` query param — must first verify header-only auth works for both `AIza*` and newer `AQ.*` key formats. *(Medium.)*
- **M6** Validate `subtitleColor`/`fontFamily`/`customCaptionStyle` at the `generate-config`/`render` API boundary — must allowlist exactly what the presets (`captionStyles.ts`/`styleGenerator.ts`) emit, or legit styles get rejected. *(Medium.)*
- **M9** Memoize per-frame token segmentation in `AnimatedSubtitle` — **touches the karaoke/highlight timing path (the minefield)**; output must stay byte-identical; requires render QA on a karaoke clip. *(Medium.)*
- **M3** Tune worker sweep/heartbeat constants (`staleMs > STALL_MS + watchdog + margin`). *(Low — worker-only, but verify under load.)*

### 🔵 Tier 3 — Policy / product decisions (not pure code)
- **M1** Cap free re-burns per `ChargedClip` (e.g. 1–2) **vs** keep the current "always-exportable" design. *Revenue/abuse trade-off — Mew's call.*
- **M2** Decide whether FREE may render the editor/subtitle-overlay path at all; if not, add a server-side `allowVideoEditor` gate. *Product decision.*

### ⚪ Tier 4 — Hygiene (batch when convenient)
**M10, M13, L2, L4, L5, L6, L7, L8, L9, L10, L11** — dead code, duplicate `<style>`, memoizations, legacy-route cleanup, cosmetic preview mismatch. Low urgency; safe; do opportunistically.

---

## What's solid (verified, keep it)

- **No XSS surface.** All user script/subtitle text renders via React JSX (auto-escaped); **no `dangerouslySetInnerHTML`/`eval`/`innerHTML`/`new Function`** over user data anywhere in the frontend or Remotion slices (grep-confirmed). The one `dangerouslySetInnerHTML` use injects a static keyframe constant.
- **No SQL injection.** Every `$queryRawUnsafe`/`$executeRawUnsafe` uses `?` placeholders. (The thumbnail issue is missing ownership, not injection.)
- **No command/arg injection.** ffmpeg/Remotion invoked via `spawn(bin, [args])` (no shell); tmp-cleanup `find` uses `execFile` with array args.
- **Path traversal is well-defended** at the serving boundary: `renders/[filename]` & `stocks/[filename]` reject `/`,`\` before `path.join`; the render route's `withinDir` decodes + asserts containment.
- **Quota reservation is atomic & anti-bypass.** `reserveClipUsage` uses a guarded `updateMany({ where: { usageCount: { lt: limit } } })`; the free-burn skip is gated server-side by `burnAlreadyPaid`, not the client flag.
- **The TOCTOU bundle race (the prior ~88%-burn-failure incident) is closed** — post-`ensureBundle` re-check + `retainRemotionBundle` ref-counting + cleanup excludes active bundles + one-shot rebuild retry.
- **Render-vs-Burn invariant holds.** `runRender` always sends `keywordPopups: []` and produces a no-sub preview; burning lives only in `burnSubtitlesCore`.
- **WYSIWYG renderer invariant.** `renderSubtitle` is the single source of truth shared by preview + all three burn compositions.
- **Hardened polling & worker lifecycle.** Sequential polls with capped backoff, stale-timeout, AbortController chaining, supersede guards; progress-derived heartbeat, graceful drain that doesn't burn retries, idempotent terminal transitions.
- **Auth is consistently enforced** (`getCurrentUser()` → 401) and the Clerk middleware returns clean 401 JSON for unauthenticated `/api/*`. The gap is **ownership**, not authentication.

---

## Coverage & caveats

- **Method:** static source analysis by 4 parallel read-only agents. Findings are code-derived; **not all were runtime-exploited**. CRITICAL/HIGH items have High confidence and concrete `file:line` evidence; some MEDIUM/LOW carry the noted confidence caveats (e.g. exact log exposure for M5 depends on Nginx config, not in scope).
- **Fully read:** the entire frontend slice, the render/burn backend + worker + serving routes + middleware + relevant schema, the full content/asset route set, and all Remotion compositions. (Per-slice coverage notes are in each agent's run.)
- **Out of scope / lightly covered:** the `cleanup-videos` cron (GC for the public renders dir), MCP orchestrator internals, payments/admin routes (except where the base64-key/`?key=` pattern recurs — those fixes are codebase-wide), and `src/lib/tts-timing.ts` arithmetic (deliberately not re-derived — subtitle-timing minefield).
- **No code was changed.** This document is the deliverable; all fixes await Mew's go-ahead per the "report-before-touching" rule.
