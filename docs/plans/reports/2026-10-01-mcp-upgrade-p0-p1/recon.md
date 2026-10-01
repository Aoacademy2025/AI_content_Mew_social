# Recon facts for MCP P0+P1 plan (2026-10-01, origin/main 8c6560d2 snapshot)

## A. Thai card length
- Root cause: sentence mode, text ≥120 chars → `/api/videos/split-script` (LLM) returns viralCards → `captionsFromTtsTiming(..., maxCardCharsFor(), viralCards)` (orchestrator.ts:2293-2315; tts-timing-captions.ts:57).
  - `validCards` (tts-timing-captions.ts:42-51) checks only ordering and bounds, never length. cardCap is a prompt instruction only (split-script/route.ts:~95).
  - `mapCardTextsToRangesTolerant` (tts-timing.ts:778-858) caps only gap-filled text. Accepted verbatim LLM pieces are pushed at full length (tts-timing.ts:816-828).
- Deterministic fallbacks do respect the cap: `splitSentenceCards` → `splitScriptForTts` / `findCut` (tts-timing.ts:170-212), and `captionsFromSpokenScript` (tts-timing-captions.ts:145-185).
- A server Thai segmenter exists: `thaiWordSegmenter` (tts-timing.ts:101-104), plus `wordBoundaries` and `findCut`. `snapCardsToWordBoundaries` (tts-timing.ts:860+) moves card edges but never adds new splits.
- Web v2 builds its initial cards on the same server pipeline. `regroupCaptions` (subtitle-style.ts:195-222) leaves "sentence" cards untouched, and "1"-"4" regroup by word count. Font size (30–160) is independent of card length.
- Canvas is 1080×1920; the subtitle box is 92% of the width (ShortVideoComposition.tsx:522). `maxCardCharsFor(80)` = 24, which is slightly conservative.
  - `SUBTITLE_FIT_V2_ENABLED` defaults on, so fonts are not auto-shrunk and long cards wrap instead (renderSubtitle.tsx:183-204, 358-362).
- subtitle-quality.ts has no line or overflow check. Blocking codes are only empty_script and empty_captions (line 1039, 1272-1275).

## B. Style
- `buildBurnConfig` (orchestrator-steps.ts:253) hard-codes DEFAULT_STYLE. It wraps the pure `buildHeroSubtitleOverlayConfig` (hero-editorial.ts:34-78), whose `HeroSubtitleDesign` covers font, position, size, weight, color, accent, preset, effect, shadow, outline and outlineSize.
- Presets: remotion/types.ts:63-86. Quick styles: subtitle-style.ts:33-38 (viral, shadow, outline, clean). Fonts: constants.ts:38-50 (12 fonts). Size slider range is 30–160.

## C. Project / preview / export
- Web create sets previewMode:true and a validated projectId (jobs/route.ts:1071, 493-498).
- `createEditorProject` needs only userId (editor-projects.ts:198-260). On finish, a preview job sets the project's activeJobId and status "post" (video-job.ts:332-353).
- Export (jobs/route.ts:362-491) needs sourceJobId, subtitleOverlayConfig and an optional editorSnapshot.
  - The source must be done, have a projectId and carry preview data, and must pass `assertCurrentEditorExportSource` (editor-projects.ts:422-457).
  - The overlay config can be built on the server with `buildHeroSubtitleOverlayConfig`.
- Billing: the burn is free via `isBurnAlreadyPaid` on the canonical render URL (clip-charge.ts:67-113). It works the same with or without an avatar; HeyGen bills separately.
- No existing path both persists preview data and burns. The preview branch returns early (orchestrator.ts:2888-2930).

## D. Errors / cancel / client
- `getVideoJobStatusTool` (tools.ts:114-139) returns only errorMessage, never errorCode or errorProvider. The web status route returns both.
- Orchestrator create-path failures now carry codes (`classifyUnknownStepFailure`, orchestrator.ts:508-566). This post-dates the NULL-code failures, which ended 08-30.
- Some guard `failJob(string)` calls still have no code. They are mostly in the rerender, export and upload paths.
- Web cancel `DELETE /api/videos/jobs/[id]` (route.ts:115-221) is reusable from MCP. It does cooperative cancel, sets reservationRefundPending, refunds funding, image batches and render reservations, and reverts the project status.
- `recordToolCall` (audit.ts:31-51) takes no userAgent or ip. route.ts never reads headers or clientInfo. Whether mcp-handler exposes them is unverified.

## E. geminiVoiceStyle
- Web gates it twice (jobs/route.ts:583-589, tts-gemini/route.ts:223-228). A non-beta request silently falls back to "neutral".
- MCP drops it unconditionally because of the missing forward at route.ts:277. The orchestrator reads it at orchestrator.ts:2226.
