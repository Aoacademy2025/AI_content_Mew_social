export const AVATAR_FADE_DURATION_SEC = 0.35;

export type AvatarFadeWindow = {
  startSec: number;
  endSec: number;
};

type AvatarTiming = "full" | "bookend" | "bookend-both";

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeWindow(value: AvatarFadeWindow): AvatarFadeWindow | null {
  const startSec = rounded(finiteNonNegative(value.startSec));
  const endSec = rounded(finiteNonNegative(value.endSec));
  if (endSec <= startSec) return null;
  return { startSec, endSec };
}

export function normalizeAvatarFadeWindows(
  windows: readonly AvatarFadeWindow[],
): AvatarFadeWindow[] {
  return windows
    .map(normalizeWindow)
    .filter((window): window is AvatarFadeWindow => window !== null);
}

export function avatarFadeEdgeDurationSec(
  window: AvatarFadeWindow,
  preferredDurationSec = AVATAR_FADE_DURATION_SEC,
): number {
  const normalized = normalizeWindow(window);
  if (!normalized) return 0;
  const requested = finiteNonNegative(
    preferredDurationSec,
    AVATAR_FADE_DURATION_SEC,
  );
  const preferred = requested > 0 ? requested : AVATAR_FADE_DURATION_SEC;
  return rounded(Math.min(preferred, (normalized.endSec - normalized.startSec) / 2));
}

export function singleAvatarFadeWindow(durationSec: unknown): AvatarFadeWindow[] {
  const duration = finiteNonNegative(durationSec);
  return normalizeAvatarFadeWindows([{ startSec: 0, endSec: duration }]);
}

/**
 * Windows are expressed on the avatar source timeline. The legacy combined
 * bookend-both source stores intro then outro contiguously; its final placement
 * is handled later by the existing bookend splice.
 */
export function avatarSourceFadeWindows(input: {
  timing: AvatarTiming | string;
  totalDurationSec: unknown;
  introSecs: unknown;
  tailSecs: unknown;
}): AvatarFadeWindow[] {
  const total = finiteNonNegative(input.totalDurationSec);
  if (total <= 0) return [];
  if (input.timing === "bookend") {
    return singleAvatarFadeWindow(Math.min(finiteNonNegative(input.introSecs), total));
  }
  if (input.timing === "bookend-both") {
    const intro = Math.min(finiteNonNegative(input.introSecs), total);
    const tail = Math.min(
      finiteNonNegative(input.tailSecs),
      Math.max(0, total - intro),
    );
    return normalizeAvatarFadeWindows([
      { startSec: 0, endSec: intro },
      { startSec: intro, endSec: intro + tail },
    ]);
  }
  return singleAvatarFadeWindow(total);
}

function clip01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Numeric mirror of `avatarOpacityExpression`'s ffmpeg blend formula — same
 * `max` over per-window `clip((T-start)/edge,0,1) * clip((end-T)/edge,0,1)`
 * envelopes, evaluated in plain JS instead of an ffmpeg filter string. Used by
 * the live avatar-adjust preview (client-side, no ffmpeg available) to keep
 * the moving overlay's opacity in lockstep with what export will bake in —
 * same windows in, same opacity out, no drift between the two call sites.
 */
export function avatarOpacityAtTime(
  windows: readonly AvatarFadeWindow[],
  atSec: number,
): number {
  const normalized = normalizeAvatarFadeWindows(windows);
  return normalized.reduce((max, window) => {
    const edge = avatarFadeEdgeDurationSec(window);
    // `edge === 0` guard (review finding #3): NOT provably unreachable — verified numerically.
    // avatarFadeEdgeDurationSec rounds (endSec-startSec)/2 to 3 decimals, and for a
    // near-degenerate window (duration ~0.001-0.002s after rounding) IEEE754 subtraction error
    // in that division can land just under the .5 boundary and round DOWN to exactly 0 (about
    // half of all possible 1ms-wide windows do this — confirmed by brute-force scan, not just
    // symbolic reasoning about the 3-decimal grid, which wrongly suggested it couldn't happen).
    // avatarOpacityExpression (the ffmpeg blend string this mirrors, export path, out of scope
    // here) has NO equivalent guard — the same input would divide by zero there (NaN/Inf in the
    // filter graph). This is pre-existing and unrelated to this diff; not fixed here. In THIS
    // (client) function it's collapsed to an instant on/off step instead — no crash, no NaN.
    // In practice it never fires: every window this codebase actually constructs comes from
    // avatarSourceFadeWindows/singleAvatarFadeWindow fed real avatar/bg durations (HeyGen
    // renders, TTS-driven bg clips), which are always multiple seconds — never sub-2ms.
    const envelope = edge > 0
      ? clip01((atSec - window.startSec) / edge) * clip01((window.endSec - atSec) / edge)
      : (atSec >= window.startSec && atSec <= window.endSec ? 1 : 0);
    return Math.max(max, envelope);
  }, 0);
}

/**
 * Whether avatar fade applies at all for a given `avatarModel` value — mirrors
 * which composite modes actually run the fade blend server-side. Every HeyGen
 * chroma/direct/rembg avatar (any non-empty id, timing full/bookend/bookend-both)
 * goes through `avatarSourceFadeWindows` in the composite route → fades.
 * `upload-cutaway` goes through `cutawayComposite`, which never receives fade
 * windows (H7/M10 audit) — so no indicator/hint should claim it does.
 */
export function avatarFadeApplies(avatarModel: string | null | undefined): boolean {
  return !!avatarModel && avatarModel !== "none" && avatarModel !== "upload-cutaway";
}

function ffmpegNumber(value: number): string {
  return rounded(value).toFixed(3).replace(/\.?0+$/, "");
}

/**
 * FFmpeg blend expression: 0 outside all avatar windows, 1 in the steady
 * section, and a bounded linear ramp on each edge. Commas are escaped because
 * the expression is embedded in a filter graph.
 */
export function avatarOpacityExpression(
  windows: readonly AvatarFadeWindow[],
): string {
  const envelopes = normalizeAvatarFadeWindows(windows).map((window) => {
    const start = ffmpegNumber(window.startSec);
    const end = ffmpegNumber(window.endSec);
    const edge = ffmpegNumber(avatarFadeEdgeDurationSec(window));
    return [
      `clip((T-${start})/${edge}\\,0\\,1)`,
      `clip((${end}-T)/${edge}\\,0\\,1)`,
    ].join("*");
  });
  if (envelopes.length === 0) return "0";
  return envelopes.reduce(
    (combined, envelope) => `max(${combined}\\,${envelope})`,
  );
}

function safeLabel(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error("invalid FFmpeg filter label");
  }
  return value;
}

export function avatarFadeBlendFilter(input: {
  compositeLabel: string;
  backgroundLabel: string;
  outputLabel: string;
  windows: readonly AvatarFadeWindow[];
}): string {
  const composite = safeLabel(input.compositeLabel);
  const background = safeLabel(input.backgroundLabel);
  const output = safeLabel(input.outputLabel);
  const opacity = avatarOpacityExpression(input.windows);
  return `[${composite}][${background}]blend=all_expr='A*(${opacity})+B*(1-(${opacity}))'[${output}]`;
}
