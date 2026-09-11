/**
 * HERO-27: `HTMLMediaElement.play()` returns a promise that rejects when
 * anything pauses, reloads or replaces the element before playback has
 * actually started. In the editor that is an ordinary user action — pressing
 * play and then immediately opening a caption/logo/layers sheet, clicking a
 * timeline card, or pressing space twice — and `video.pause()` runs
 * synchronously while the play promise is still pending.
 *
 * `void el.play()` discards the promise's value but not its rejection, so the
 * interruption escapes as an unhandled rejection and is reported as an
 * unhandled production error (`AbortError: The play() request was interrupted
 * by a call to pause().`, DOMException code 20).
 *
 * Resolves `true` only when playback actually started, so a caller that tracks
 * its own playing state cannot claim playback that never began.
 */
export async function startPlayback(
  element: HTMLMediaElement | null | undefined,
): Promise<boolean> {
  if (!element) return false;

  try {
    // Older browsers return undefined here; awaiting that is harmless.
    await element.play();
    return true;
  } catch {
    return false;
  }
}
