import type { ResolvedStockMood } from "@/lib/broll-preferences";

/** What the editor knows about the Style Pack pinned to the open project: the
 * Thai label Step 2 shows read-only, and the exact Stock Mood snapshot the
 * per-window search sends back to the server. Both come from one place — the
 * visual-context endpoint — so the creator can never be shown one style and
 * have another one searched. */
export type ProjectStylePack = {
  packId: string;
  thaiLabel: string;
  /** Whether this clip chose the style itself, or inherited the brand's.
   *  Purely for what the creator is told — the search uses the same mood
   *  either way, because the server already applied the precedence. */
  source: "project" | "brand";
  stockMood: ResolvedStockMood;
};
