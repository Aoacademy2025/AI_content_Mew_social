// Pure decisions for the Video Editor avatar flow. Kept out of the 4,700-line page
// component so they're unit-testable (scripts/verify-avatar-flow.ts).

/** Apply a freshly-fetched preset into the editor only when it won't clobber a live edit.
 *  - skip if no avatar id
 *  - skip if we've already loaded this avatarId once (true one-shot per id)
 *  - skip if the user has already touched the position controls for this avatar */
export function shouldApplyLoadedPreset(input: { loadedFor: string | null; avatarId: string; userTouched: boolean }): boolean {
  if (!input.avatarId) return false;
  if (input.loadedFor === input.avatarId) return false;
  if (input.userTouched) return false;
  return true;
}

/** Pause the web render before composite the FIRST time an avatar is used, so the user can
 *  position against the real green video. Skip when no avatar, a direct-URL avatar (no gen
 *  framing to fix), or a saved preset already exists (run straight through = automation). */
export function shouldPauseForPositioning(input: { useAvatar: boolean; isDirect: boolean; hasSavedPreset: boolean }): boolean {
  return input.useAvatar && !input.isDirect && !input.hasSavedPreset;
}
