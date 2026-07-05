/**
 * Pure helpers for the Step 2 avatar picker. No React — unit-tested by
 * scripts/verify-avatar-filter.ts. Shape matches GET /api/heygen/my-avatars:
 * one entry per HeyGen "look", carrying the generation-ready `avatar_id`.
 */

export interface HeygenAvatar {
  avatar_id: string;        // HeyGen look id — used as character.avatar_id when rendering
  avatar_name: string;      // the avatar (group) name, e.g. "Mew"
  preview_image_url: string;
  group_id?: string;
}

/**
 * Group looks into sections by avatar name (so an avatar with many looks — e.g. "Mew" with
 * 15 — shows as one section with all its looks), filtered by a case-insensitive name
 * substring. First-seen order is preserved for sections and for looks within a section.
 * A blank/whitespace query = no filter.
 */
export function groupLooksByAvatar(
  list: HeygenAvatar[],
  query: string,
): { name: string; looks: HeygenAvatar[] }[] {
  const needle = query.trim().toLowerCase();
  const matches = (a: HeygenAvatar) =>
    needle === "" || (a.avatar_name ?? "").toLowerCase().includes(needle);
  const order: string[] = [];
  const byName = new Map<string, HeygenAvatar[]>();
  for (const a of list) {
    if (!matches(a)) continue;
    if (!byName.has(a.avatar_name)) { byName.set(a.avatar_name, []); order.push(a.avatar_name); }
    byName.get(a.avatar_name)!.push(a);
  }
  return order.map((name) => ({ name, looks: byName.get(name)! }));
}
