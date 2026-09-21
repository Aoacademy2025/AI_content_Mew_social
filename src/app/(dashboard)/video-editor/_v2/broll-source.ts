/**
 * HERO-42: the single definition of the v2 editor's B-roll sources and how each
 * one is named to the jobs API.
 *
 * The mapping used to live inline in `useV2Job` as a ternary chain ending in
 * `: "stock"`. That shape silently swallows any member added to the union — a
 * new source reaches the backend as plain stock and its feature does nothing,
 * with TypeScript perfectly happy. Keeping the list and the mapping together,
 * with `satisfies Record<V2BrollSource, ...>`, makes a missing case a build
 * error instead; `verify:v2-broll-source` covers what types cannot.
 */
export const V2_BROLL_SOURCES = [
  "automix",
  "stock",
  "kie-image",
  "kie-video",
  "none",
] as const;

export type V2BrollSource = (typeof V2_BROLL_SOURCES)[number];

/** Values accepted by `STOCK_SOURCES` in `src/app/api/videos/jobs/route.ts`. */
export type ApiStockSource = "stock" | "kie-image" | "auto-mix" | "none";

const API_STOCK_SOURCE = {
  automix: "auto-mix",
  stock: "stock",
  "kie-image": "kie-image",
  // Still "coming soon" in the picker; it has no backend of its own yet and
  // deliberately falls back to stock rather than failing a job.
  "kie-video": "stock",
  // The one source that contacts no provider at all.
  none: "none",
} satisfies Record<V2BrollSource, ApiStockSource>;

export function apiStockSource(source: V2BrollSource): ApiStockSource {
  return API_STOCK_SOURCE[source];
}

/** True when the customer asked for a video with no B-roll. */
export function brollDisabled(source: V2BrollSource | undefined): boolean {
  return source === "none";
}
