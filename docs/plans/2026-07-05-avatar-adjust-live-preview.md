# Avatar Adjust — Live WYSIWYG Preview (Post phase)

**Problem:** In editor v2 Post phase, "ปรับตำแหน่งอวตาร" drags only a dashed box — the avatar itself doesn't move (it's baked into the preview video at the old position), and every attempt costs a 1-2 min re-composite. Blind positioning = unusable (Mew, 2026-07-05, screenshot).

**Approach (approved):** show the REAL avatar inside the drag box via a keyed transparent WebM, over the avatar-less base render. All pieces exist: `AvatarAdjustOverlay` already receives `avatarVideoUrl` (green clip) + `bgVideoUrl` (base render WITHOUT avatar); `/api/heygen/preview-bg` already produces a transparent-alpha VP9 WebM from a green clip and (post PR #170) uses the SAME shared chroma-key builder as the render — WYSIWYG by construction. The route currently has no callers.

## Task 1 — live avatar layer in AvatarAdjustOverlay (single task)

Files: `src/app/(dashboard)/video-editor/_v2/AvatarAdjustOverlay.tsx`, `src/app/api/heygen/preview-bg/route.ts`.

### 1a. preview-bg route: fast-preview params + reuse cache
- Accept optional `maxSec` (number, clamp 1–10, default: full clip as today) → ffmpeg `-t <maxSec>` on the keyed output; and `halfRes` (boolean) → scale the OUTPUT to 540:-2 (keying still runs through the shared `buildKeyChain`; only add a final scale — do NOT fork the key chain, parity must hold).
- Sanitize both (numeric clamp / boolean coerce) — they become ffmpeg args.
- Deterministic output name: hash of (avatarVideoUrl, maxSec, halfRes) instead of `Date.now()`; if the file already exists on disk, return it without re-keying (re-opening the adjust panel must not re-run ffmpeg).
- Keep existing auth + response shape `{ previewUrl }`.

### 1b. AvatarAdjustOverlay: three layers
1. **Backdrop**: `<video src={bgVideoUrl} muted playsInline preload="metadata">` absolute inset-0, object-cover, paused (~frame 0) — replaces the current translucent-scrim-over-old-composite so the OLD baked avatar is not visible while adjusting. Keep a light scrim above it for control contrast.
2. **Avatar layer**: on mount, POST `/api/heygen/preview-bg { avatarVideoUrl, maxSec: 4, halfRes: true }`. While pending: today's dashed box + a small chip "กำลังเตรียมตัวอย่างอวตาร…" (box stays draggable — current behavior is the fallback, never block). On success: render `<video src={previewUrl} autoPlay muted loop playsInline>` absolutely filling the drag box (width/height 100%, pointer-events: none) beneath the pill label; keep the dashed border. Because the keyed WebM is the full avatar frame and the box geometry comes from `normalizedBox(layout)` (same math as ffmpeg `layoutGeometry`), stretching the video to the box IS the render placement — no new math.
3. On fetch/keying failure or **no VP9-alpha support** (Safari: `video.canPlayType('video/webm; codecs="vp9"')` falsy) → silently keep today's dashed-box behavior + one info toast. Never break the existing save flow.

### Out of scope / notes
- Save flow unchanged (preset PUT → re-composite → PATCH job). The win is one-shot correct placement.
- bookend-both: preview shows the intro avatar only; layout applies to both (same as render today) — fine.
- If `PostPhaseMobile` renders the same overlay component, the fix carries over automatically; verify it compiles/lays out, do not build a separate mobile variant.
- Pre-existing preview-bg SSRF surface (downloadFile) is known + out of scope (2026-06-25 audit).

### Verify
- `npx tsc --noEmit` + `BUILD_NO_LINT=1 npm run build`.
- Param sanitization: small assertions runnable via `npx tsx` (clamp maxSec 0→1, 99→10, `"evil"`→default; halfRes truthy coercion) — export the param-resolver from the route's lib or colocate a pure helper so it's testable without HTTP.
- ffmpeg behavior: synthesize a 6s green clip (reuse the pattern from `scripts/verify-composite-quality.ts`), run the route's core keying path with maxSec=4/halfRes → assert output webm duration ≤ ~4.2s, width 540, has alpha (`ffprobe` pix_fmt yuva420p), and deterministic-name reuse (2nd call returns cached file, no re-encode).
- Live drag UX on prod = Mew QA.

## Execution Directive
| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 1 | live avatar layer + preview-bg params | mew-worker | subagent | build+tsc, verify script, code review |

Branch: `mew/avatar-adjust-live-preview` off latest main (63e8047), reuse worktree AI_content_avatar_quality_0705.

## Acceptance Criteria
- [ ] Opening ปรับตำแหน่งอวตาร shows the real keyed avatar inside the box within a few seconds; dragging/scaling moves it at 60fps entirely client-side.
- [ ] Backdrop while adjusting = base render without the old baked avatar.
- [ ] Keying uses the shared chroma-key builder (parity with render); box math unchanged (`normalizedBox`).
- [ ] Re-opening the panel does not re-run ffmpeg (cache hit).
- [ ] Unsupported browser / keying failure degrades to today's dashed box, save flow intact.
- [ ] maxSec/halfRes sanitized; verify script passes; build + tsc clean.
- [ ] Prod (Mew): adjust once, save once, rendered result matches what was previewed.

## Status
interviewed 2026-07-05 (short — design agreed in chat) | approved: 2026-07-05 | executed: 2026-07-05 (d2e390b + 832f09f, review Approved, verify 45/45) | delivered: PR #172 deployed df35ebe, QA passed; follow-up occlusion fix PR #173 deployed 921b508 (2026-07-06) — pending bottom-edge re-QA
