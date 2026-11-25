import { createBlankBrandProfileSeed, createBrandProfileSeedFromCurrentDefaults, type BrandProfileSeed, type CurrentBrandDefaults } from "@/lib/brand-profile-seed";
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
 * choices; a catalog-owned tone/subtitle is still replaced when trying a pack.
 * New brands start in zero-credit mode (stock with the starter style pack) so
 * creators reach their first clip without hitting surprise credit charges. */
export function createBrandSetupSeed(defaults: CurrentBrandDefaults, names: readonly string[]): BrandProfileSeed {
  const seed = createBlankBrandProfileSeed();
  const hydrated = createBrandProfileSeedFromCurrentDefaults(defaults);
  hydrated.name = nextBrandName(names);
  hydrated.visual.defaultBrollSource = "stock";
  const pack = activeStylePacks().find((item) => item.id === "life-drama") ?? activeStylePacks()[0];
  if (!pack) return { ...seed, ...hydrated };
  return applyStylePackToPayload(hydrated as BrandProfilePayload, stylePack(pack.id)) as BrandProfileSeed;
}

/** Deliberately excludes name, voice, subtitles, writing and motion theme:
 * changing those cannot make the same AI still cost money to verify again. */
export function brandPreviewInputKey(payload: BrandProfileSeed): string {
  const stillVisual = { ...payload.visual };
  delete stillVisual.defaultBrollSource;
  delete stillVisual.motionThemeId;
  delete stillVisual.motionMascot;
  return JSON.stringify({ niche: payload.niche.trim(), visual: stillVisual });
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
