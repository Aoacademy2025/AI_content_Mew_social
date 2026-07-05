# Avatar & Video Quality Rework (Level 1 — no pipeline restructure)

**Problem (user-visible):** avatar green-screen edges are jagged/pixelated, avatar is blurry, final video shows compression artifacts (see Mew's screenshot 2026-07-05).

**Root causes found in code:**
1. HeyGen avatars requested at **720×1280** then upscaled to 1080×1920 → blur. (`src/app/api/heygen/generate-with-bg/route.ts:232`, `heygen-direct/route.ts:86`, `test-avatar/route.ts:63`)
2. Chroma key runs at source res on 4:2:0 (chroma plane = half res), `blend=0.04` hard edge, **no alpha feathering** (comment at `composite/route.ts:119` claims erosion→gblur but the chain has none), and the keyed result is upscaled afterwards → jaggies scale up.
3. Composite intermediate encode at **CRF 28 + ultrafast** (`composite/route.ts:192`).
4. Prod render-worker runs **RENDER_JPEG_QUALITY=60** (`ecosystem.config.js` render-worker block) — every Remotion frame JPEG'd at q60 before x264, twice (base render + subtitle burn). Values date from the 15GB box; prod is now KVM8 8c/31Gi.
5. Editor preview uses a **different key filter** than the render (`preview-frame/route.ts:70` `colorkey=0x00FF00:similarity=0.05:blend=0.0`) → preview ≠ output (violates the WYSIWYG rule from the 2026-06-30 avatar framing fix).
6. Mixed chroma colors already in the wild: HeyGen gen requests bg `0x12FF05`, v1 client always POSTs `0x00FF00`, uploaded HeyGen-web clips can be any green → per-clip auto-detection is the fix, not more sliders.

**Decisions (interviewed + approved by Mew 2026-07-05):**
- 100% automatic — **no new user-facing UI**. v1 Advanced sliders remain as-is (legacy escape hatch, per CONTEXT.md "Advanced Settings" policy).
- HeyGen **1080×1920 default** (users on HeyGen API are paid). Silent one-shot fallback to 720×1280 only on a resolution/plan error.
- Quality knobs raised to max sensible: JPEG 90, composite CRF 18. All via env, rollback without deploy.
- Old 720p green videos: leave as-is; they still benefit from new keying + encode. New gens = new quality version.
- Level 2 (reduce 4 re-encodes → 2, ffmpeg subtitle burn) = **backlog**, trigger: Mew still unhappy after eyeball, or burn speed complaints.

## Tasks

### Task 1 — HeyGen 1080p default + fallback
Files: `src/app/api/heygen/generate-with-bg/route.ts`, `src/app/api/videos/heygen-direct/route.ts`, `src/app/api/heygen/test-avatar/route.ts`.
- Introduce one shared constant (suggest `src/lib/avatar-gen-framing.ts`, it already owns GEN-layer concerns): `AVATAR_GEN_DIMENSION = { width: 1080, height: 1280→1920 }` with a `AVATAR_GEN_FALLBACK_DIMENSION = { width: 720, height: 1280 }`. Replace the three hardcoded literals.
- Fallback: when HeyGen's generate call fails and the error body/message mentions resolution/dimension/plan not supporting 1080 (match case-insensitively on `resolution|dimension|1080|plan`), retry ONCE with the fallback dimension and `console.warn` (include userId-free context). Any other error: unchanged behavior.
- Do NOT touch avatar-gen-framing scale/offset values (the 2026-07-01 head-cut fix) — framing is relative, resolution-independent.
- Verify: `npm run build`; grep confirms no remaining `width: 720` dimension literals in API routes; unit-style check optional.

### Task 2 — Chroma keying rework (auto-detect + high-res key + feathered alpha) ⚠️ heavy
Files: `src/app/api/heygen/composite/route.ts` (BOTH filter sites: `chromakeyComposite` ~L135 and the bookend/tail site ~L389), `src/app/api/heygen/preview-frame/route.ts`, `src/app/api/heygen/preview-bg/route.ts` (if it keys too — check).

2a. **Auto-detect chroma color** (new helper in `composite/route.ts` or `src/lib/chroma-detect.ts`):
- Extract 1 frame at t≈0.5s (ffmpeg `-ss 0.5 -frames:v 1`, scaled to ~160px wide PNG in tmp), read pixels in Node (no new heavy deps — decode via ffmpeg to raw `rgb24` and read the Buffer directly, avoid adding an image lib).
- Sample border pixels (top-left/top-right corner blocks + top edge strip — regions the avatar body never covers), take the median color; accept only if clearly green (g > r+40 && g > b+40), else fallback `0x12FF05`.
- **Sanitize before ffmpeg**: detected/user color MUST match `/^0x[0-9A-F]{6}$/i`; similarity/blend clamped to [0.01, 0.6] / [0, 0.3] numeric. Reject otherwise (fallback defaults). This is an injection surface (values become ffmpeg args).
- Applicability rule: if the request passes the known legacy default triples (`0x00FF00|0x12FF05` + 0.28 + 0.04) or omits params → auto-detect. Any OTHER explicit value = deliberate v1 slider tuning → honor it verbatim.
- Cache the detection per avatar video file (in-memory Map keyed by path+mtime is enough; composite may run multiple times per video for re-layout).

2b. **Filter chain rework** (same chain at both composite sites):
- Key AFTER upscaling and on full chroma resolution: `scale=<finalW>:<finalH>:flags=lanczos,format=gbrp` (or `yuv444p`) → `chromakey=color=<c>:similarity=<s>:blend=<b>` → `despill=type=green` → alpha feather: erosion on alpha then blur on alpha (e.g. `erosion=... (alpha plane)` + `gblur=sigma=1.0` limited to the alpha plane — worker MUST empirically verify the exact planes syntax against the prod ffmpeg build and eyeball the PNG dumps; ffmpeg planes bitmasks are easy to get wrong silently).
- Default blend raised 0.04 → ~0.10 (tune during verification against the synthetic clip AND a real HeyGen 720p clip — the fix must visibly help OLD avatars too, per decision above).
- Full-cover (no layout) path: scale fg to bg size FIRST, then key, then overlay — same key-at-display-resolution principle.

2c. **Encode**: `-crf` from env `COMPOSITE_CRF` (default **18**), `-preset` from env `COMPOSITE_PRESET` (default **veryfast**). Keep `-threads 0`, `yuv420p`, `+faststart`. Fix the stale comments (L119, L182-183).

2d. **Preview parity**: `preview-frame` (and `preview-bg` if applicable) must use the SAME detection + same chromakey params/chain (single-frame variant) so editor preview == render output. Extract shared filter-builder so the two can't drift.

- Verify: new `scripts/verify-composite-quality.ts` (team verify-* pattern, temp dirs): (1) synthesize a green-screen clip with ffmpeg (moving colored shape + skin-tone block on green `0x12FF05` AND a second clip on `0x00FF00`), (2) run the composite path, (3) assert output is 1080×1920, CRF/preset applied (parse ffmpeg args or probe bitrate sanity), (4) sample edge pixels of a dumped frame: no residual green (g − max(r,b) < threshold) along the shape boundary, (5) dump before/after PNGs to tmp for human eyeball. Plus `npm run build`.

### Task 3 — Render encode quality (config)
File: `ecosystem.config.js`.
- render-worker block: `RENDER_JPEG_QUALITY: "60"` → `"90"`. ai-content block: `"70"` → `"90"`. Update the adjacent comments (values were for the 15GB box; KVM8 = 31Gi).
- No code change: `run-render.ts` already prefers env; prod `isLowResourceHost=false` → x264 preset `medium` already; Remotion default CRF 18 already. Cutaway composite already CRF 18.
- Deploy note (for Mew, post-merge): ecosystem env SHADOWS .env and is only re-read by `pm2 restart ecosystem.config.js --only render-worker` then `--only ai-content` (NOT `--update-env`) + `pm2 save`.
- Verify: `node -e "require('./ecosystem.config.js')"` parses; grep the two values.

## Execution Directive
| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 1 | HeyGen 1080p + fallback | mew-worker | subagent | build+test, code review |
| 2 | Chroma keying rework | mew-worker-heavy | subagent | build+test, code review, security-review (ffmpeg arg injection) |
| 3 | ecosystem JPEG quality | mew-worker | subagent (with T1) | build parses, code review |

Branch: `mew/avatar-video-quality` (one PR; tasks are one coherent quality story). Tasks 1+3 can go to one worker; Task 2 separate (heavy).

## Acceptance Criteria
- [ ] New HeyGen gens request 1080×1920@30 (log line proves it); resolution-error fallback path exists and retries at 720×1280 exactly once.
- [ ] Composite encodes at CRF 18 / veryfast by default; overridable via `COMPOSITE_CRF` / `COMPOSITE_PRESET`.
- [ ] Render worker JPEG quality 90 in ecosystem.config.js (both apps).
- [ ] Keying: auto-detected color per clip; key runs at display resolution on full-chroma format; alpha edge feathered. verify-composite-quality.ts passes on BOTH green shades; visibly smoother edge on a real old 720p HeyGen clip (PNG dump eyeball).
- [ ] Preview (editor) and render use the same key params — no drift possible (shared builder).
- [ ] All chroma values sanitized before reaching ffmpeg args.
- [ ] `npm run build` passes; existing verify scripts unaffected.
- [ ] Prod (Mew, post-deploy): gen 1 new-avatar clip → at 100% zoom: edge not jagged, face sharp, no blocking vs the 2026-07-05 screenshot. Render time increase ≤ ~50% (else drop one preset step and re-measure).

## Status
interviewed 2026-07-05 | approved: 2026-07-05 | executed: in-progress 2026-07-05 | delivered: -
