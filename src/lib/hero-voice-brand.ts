/** Public-facing brand copy. Internal provider identifiers remain `omnivoice`. */
export const HERO_VOICE_NAME = "Hero AI Voice";
export const HERO_VOICE_COMING_SOON = "เร็ว ๆ นี้";
/** Public teaser is visible by default. Set NEXT_PUBLIC_HERO_VOICE_TEASER=0 only
 * for an emergency presentation rollback; provider/API access remains separate. */
export const HERO_VOICE_TEASER_VISIBLE = process.env.NEXT_PUBLIC_HERO_VOICE_TEASER !== "0";
