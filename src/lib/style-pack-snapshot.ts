import { z } from "zod";
import {
  MUSIC_MOODS,
  STYLE_PACK_IDS,
  type PacingLevel,
  type StockMood,
  type StylePackId,
} from "@/lib/style-pack-catalog";

/** The Style Pack fields a Brand Revision (and, from wave 1 Task 7, a per-clip
 * Project Visual Context) SNAPSHOTS at publish time. A Revision is a promise
 * about what a clip will look like (ADR 0005): render-time consumers read this
 * snapshot out of the stored JSON and never re-resolve it from the catalog, so
 * a later catalog edit can't reach back and change an existing clip.
 *
 * This module owns only the wire/storage SHAPE. `broll-preferences.ts` owns
 * what the Stock Mood then does to a search. Both the storage schema and the
 * request schema live here so a stored snapshot and an API body can never
 * drift apart. */

const PACING_LEVELS = ["slow", "normal", "fast"] as const satisfies readonly PacingLevel[];

/** Wire limits. A Stock Mood arrives from a client on the per-window search
 * route, so every field is bounded before it can reach a provider query, an
 * LLM prompt, or a cache key. The bounds are the catalog's own ceilings with a
 * little headroom, not arbitrary numbers. */
export const STOCK_MOOD_LIMITS = {
  queryToken: 24,
  concept: 64,
  positive: 12,
  avoid: 8,
  direction: 160,
  fallbackQueries: 5,
} as const;

export const stockMoodSchema = z.object({
  queryToken: z.string().trim().min(1).max(STOCK_MOOD_LIMITS.queryToken),
  positive: z.array(z.string().trim().min(1).max(STOCK_MOOD_LIMITS.concept)).max(STOCK_MOOD_LIMITS.positive),
  avoid: z.array(z.string().trim().min(1).max(STOCK_MOOD_LIMITS.concept)).max(STOCK_MOOD_LIMITS.avoid),
  direction: z.string().trim().max(STOCK_MOOD_LIMITS.direction),
  fallbackQueries: z
    .array(z.string().trim().min(1).max(STOCK_MOOD_LIMITS.concept))
    .length(STOCK_MOOD_LIMITS.fallbackQueries),
});

/** The pack snapshot as written into `visualRecipeJson` (Task 2) and, later,
 * into `projectVisualContextJson` (Task 7). `pacing`/`musicMood` are carried
 * for the render-side consumers that land after this task; a snapshot missing
 * them is not a snapshot this system wrote, so it is ignored rather than
 * half-trusted. */
export const stylePackSnapshotSchema = z.object({
  id: z.enum(STYLE_PACK_IDS),
  version: z.string().trim().min(1).max(16),
  stockMood: stockMoodSchema,
  pacing: z.enum(PACING_LEVELS),
  musicMood: z.enum(MUSIC_MOODS),
});

export type StylePackSnapshot = z.infer<typeof stylePackSnapshotSchema>;

/** One Stock Mood plus the pack it came from. `packId` rides along so the
 * managed-stock cache can discriminate two moods without hashing the whole
 * object (`brollPreferenceCacheVariant`). */
export type ResolvedStockMood = StockMood & { packId: StylePackId };

/** Request-body shape: the same mood, with the pack id the caller claims. */
export const stockMoodRequestSchema = stockMoodSchema.extend({
  packId: z.enum(STYLE_PACK_IDS),
});

export type StockMoodRequestResult =
  | { ok: true; stockMood: ResolvedStockMood | null }
  | { ok: false };

/** Validate a `stockMood` field taken off a request body. A missing/null field
 * is a legitimate "no mood" (every mood path fails open to the no-mood
 * behaviour); anything present but malformed is rejected so an oversized mood
 * can never reach a provider query or an LLM prompt. */
export function parseStockMoodRequest(raw: unknown): StockMoodRequestResult {
  if (raw === undefined || raw === null) return { ok: true, stockMood: null };
  const parsed = stockMoodRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const { packId, ...stockMood } = parsed.data;
  return { ok: true, stockMood: { packId, ...stockMood } };
}

/** Read the pack snapshot out of one stored recipe/context JSON blob. Fails
 * open to `null` on anything unreadable — a mood is a flavour, never a reason
 * for a render to stop. */
export function stylePackSnapshotFromJson(json: string | null | undefined): StylePackSnapshot | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const snapshot = stylePackSnapshotSchema.safeParse((parsed as { stylePack?: unknown }).stylePack);
  return snapshot.success ? snapshot.data : null;
}
