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

/** The inputs that determine the HeyGen GENERATION output. If any of these changes, the
 *  existing green is stale and HeyGen must re-render (costs credit). Scale/offset/chroma are
 *  deliberately ABSENT — they're composite-layer (free ffmpeg), so adjusting them can never
 *  invalidate the gen. This is the guard against the "tweak size → pay HeyGen again" trap. */
export type AvatarGenInputs = {
  inputMode: string;   // "generate" | "direct"
  avatarId: string;
  directUrl: string;
  voiceUrl: string;    // the TTS/voice (or direct) audio that drives the avatar's mouth
  timing: string;      // "" | "full" | "bookend" | "bookend-both"
  bookendSecs: number; // intro length (bookend modes trim the audio → different gen)
  tailSecs: number;    // tail length (bookend-both)
};

export function avatarGenSignature(i: AvatarGenInputs): string {
  return [i.inputMode, i.avatarId, i.directUrl, i.voiceUrl, i.timing, i.bookendSecs, i.tailSecs].join("|");
}

export type AvatarPrimaryAction = "gen" | "composite";

/** What the editor's primary avatar button should do when clicked.
 *  - no green yet → "gen" (first render; first-timer then pauses to position)
 *  - green exists but a gen-input changed since it was made → "gen" (legit re-render)
 *  - green exists and gen-inputs are unchanged → "composite" (free re-layout, NO HeyGen)
 *  `lastGenSig` is the signature the current green was generated from (null = unknown
 *  provenance ⇒ treated as changed ⇒ gen). Position/scale tweaks never touch the signature,
 *  so they always resolve to "composite". */
export function nextAvatarAction(input: { hasGreen: boolean; lastGenSig: string | null; currentSig: string }): AvatarPrimaryAction {
  if (!input.hasGreen) return "gen";
  return input.lastGenSig === input.currentSig ? "composite" : "gen";
}
