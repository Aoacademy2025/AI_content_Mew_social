/**
 * Pure helpers for the Step 2 avatar picker. No React — unit-tested by
 * scripts/verify-avatar-filter.ts. Mirrors the shape returned by
 * GET /api/heygen/avatars.
 */

export interface HeygenAvatar {
  avatar_id: string;
  avatar_name: string;
  preview_image_url: string;
  gender: string;
  is_public: boolean;
}

/**
 * Split a HeyGen avatar list into the user's own (is_public=false) vs HeyGen's
 * public/stock avatars, filtered by a case-insensitive name substring. Input
 * order is preserved within each section. A blank/whitespace query = no filter.
 */
export function partitionAvatars(
  list: HeygenAvatar[],
  query: string,
): { own: HeygenAvatar[]; publicOnes: HeygenAvatar[] } {
  const needle = query.trim().toLowerCase();
  const matches = (a: HeygenAvatar) =>
    needle === "" || (a.avatar_name ?? "").toLowerCase().includes(needle);
  const filtered = list.filter(matches);
  return {
    own: filtered.filter((a) => !a.is_public),
    publicOnes: filtered.filter((a) => a.is_public),
  };
}
