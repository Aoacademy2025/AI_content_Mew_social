import { createHash, randomUUID } from "node:crypto";

/** Still-derived files belong to this materialization, not a reusable scene
 * number. Even a retry of the same VideoJob must leave saved project URLs intact.
 * Keep the owner prefix for existing cleanup; hash job IDs to bound path length. */
export function createStockImagePrefix(userId: string, videoJobId?: string | null): string {
  const job = createHash("sha256").update(videoJobId || "ad-hoc").digest("hex").slice(0, 12);
  return `stock-${userId}-${job}-${randomUUID()}-`;
}
