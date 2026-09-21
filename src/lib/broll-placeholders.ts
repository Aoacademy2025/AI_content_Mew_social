/**
 * HERO-44 "ใส่ B-roll เอง": B-roll windows that are planned but left empty for the
 * customer to fill one at a time.
 *
 * An empty window is a hidden segment (`brollEnabled: false`) with no `src` — the same
 * "nothing plays here" state the per-window on/off toggle already produces, so the
 * composition paints the brand background without knowing about this feature. Its own
 * `sourceIndex` keeps neighbouring empty windows from ever being merged into one.
 */
import type { BrollVideo } from "@/remotion/types";
import { prepareBrollRenderAssets, type BrollCoverageAsset } from "./broll-coverage";

export function buildPlaceholderBgVideos(
  windows: { startMs: number; endMs: number }[] | undefined,
  durationSec: number,
): BrollVideo[] {
  if (!Array.isArray(windows) || !Number.isFinite(durationSec) || durationSec <= 0) return [];
  const placeholders: BrollVideo[] = [];
  for (const window of windows) {
    const start = Math.max(0, Number(window?.startMs) / 1_000);
    const end = Math.min(durationSec, Number(window?.endMs) / 1_000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    placeholders.push({ src: "", start, end, brollEnabled: false, sourceIndex: placeholders.length });
  }
  return placeholders;
}

/**
 * Render-time assets for a config whose unfilled windows show the brand background.
 *
 * The shared coverage pass exists to leave no gap: it repairs a hole by stretching the
 * neighbouring clip across it, which here would push the customer's one clip into every
 * window they left empty. So each filled window is covered on its own, as a clip of the
 * window's length, and shifted back into place. Empty and hidden windows contribute
 * nothing — the composition mounts no video for them either way. A filled window whose
 * file is missing or unplayable still throws `BrollCoverageError`, as any render does.
 */
export async function prepareFilledWindowRenderAssets(
  bgVideos: BrollCoverageAsset[] | undefined,
  fps: number,
  options: Pick<
    Parameters<typeof prepareBrollRenderAssets>[3],
    "resolveAsset" | "isUsableLocalFile" | "probeDurationSec" | "onResolutionError"
  >,
): Promise<BrollCoverageAsset[]> {
  const segments: BrollCoverageAsset[] = [];
  for (const window of Array.isArray(bgVideos) ? bgVideos : []) {
    if (!window?.src || window.brollEnabled === false) continue;
    const lengthSec = window.end - window.start;
    if (!Number.isFinite(lengthSec) || lengthSec <= 0) continue;
    const { coverage } = await prepareBrollRenderAssets(
      [{ ...window, start: 0, end: lengthSec }],
      lengthSec,
      fps,
      { ...options, requestedWindowCount: 1 },
    );
    for (const segment of coverage.segments) {
      segments.push({ ...segment, start: segment.start + window.start, end: segment.end + window.start });
    }
  }
  return segments;
}
