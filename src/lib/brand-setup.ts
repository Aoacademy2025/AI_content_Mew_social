import { createBrandProfileSeedFromCurrentDefaults, type BrandProfileSeed, type CurrentBrandDefaults } from "@/lib/brand-profile-seed";
import { applyStylePackToPayload } from "@/lib/style-pack-apply";
import { activeStylePacks, stylePack } from "@/lib/style-pack-catalog";
import type { BrandProfilePayload } from "@/lib/brand-profile-library.server";

export function nextBrandName(names: readonly string[]): string {
  const used = new Set(names.map((name) => name.trim()));
  const base = "แบรนด์ของฉัน";
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/** Defaults do not require inference or a paid request. Keep authored account
 * choices; a catalog-owned tone/subtitle is still replaced when trying a pack. */
export function createBrandSetupSeed(defaults: CurrentBrandDefaults, names: readonly string[]): BrandProfileSeed {
  const seed = createBrandProfileSeedFromCurrentDefaults(defaults);
  seed.name = nextBrandName(names);
  const pack = activeStylePacks().find((item) => item.id === "life-drama") ?? activeStylePacks()[0];
  if (!pack) return seed;
  return applyStylePackToPayload(seed as BrandProfilePayload, stylePack(pack.id)) as BrandProfileSeed;
}

/** Deliberately excludes name, voice, subtitles and writing: changing those
 * cannot make the same still cost money to verify again. */
export function brandPreviewInputKey(payload: BrandProfileSeed): string {
  return JSON.stringify({ niche: payload.niche.trim(), visual: payload.visual });
}

export type BrandSetupResult = { profileId: string; revisionId: string; revision: number; projectId: string | null };
export type BrandSetupRequest = {
  requestId: string;
  action: "save" | "create-clip" | "use-brand";
  profileId?: string;
  expectedRevision?: number;
  revisionId?: string;
  payload?: BrandProfileSeed;
};
