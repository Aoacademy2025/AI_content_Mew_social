// Client-safe constants shared between /api/heygen/preview-bg and the browser code that calls it.
//
// This file must stay dependency-free. Its sibling `preview-bg-params.ts` imports `fs`/`path`
// (atomic cache write + in-process encode lock), so a Client Component importing the constant
// from THERE drags Node built-ins into the browser bundle and the production build fails with
// "Module not found: Can't resolve 'fs'" (AvatarAdjustOverlay → PostPhaseMobile → page.tsx).
// Keeping the constant here lets both sides share one definition without that coupling;
// `preview-bg-params.ts` re-exports it so server callers are unaffected.

/**
 * The `maxSec` AvatarAdjustOverlay's live drag-preview requests from /api/heygen/preview-bg —
 * exported (not hardcoded at the call site) so the client-side fade-window clamp
 * (avatarOpacityAtTime's caller, AvatarAdjustOverlay.tsx) can never drift from the actual
 * excerpt length ffmpeg produces. Review fix (fade loop-snap): the preview clip is looped, so
 * its fade windows must be computed against the EXCERPT length actually played
 * (min(real duration, this constant)), not the full render duration — otherwise the loop's hard
 * restart lands mid-opacity=1 and looks like a snap instead of a fade.
 */
export const LIVE_PREVIEW_MAX_SEC = 4;
