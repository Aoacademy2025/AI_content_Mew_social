import crypto from "crypto";
import { prisma } from "@/lib/prisma";

const TOKEN_PREFIX = "heroai_pat_";
const PAT_TTL_DAYS = 90; // tokens auto-expire after 90 days — bounds a leaked token's lifetime

/** Whether a bearer token uses the HERO AI Personal Access Token prefix (`heroai_pat_`). */
export function isMcpPatToken(token: string | undefined | null): boolean {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX);
}

/** Generate a new opaque PAT (plaintext). Shown to the user exactly once. */
export function generateMcpToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex of a token — what we store and look up by (never store plaintext). */
export function hashMcpToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

import type { User } from "@prisma/client";

export type ResolvedToken = { tokenId: string; userId: string; user?: User | null };

/** Minimum interval between `lastUsedAt` DB writes for the same PAT (avoids a SQLite write on every poll). */
export const MCP_TOKEN_LAST_USED_THROTTLE_MS = 60_000;

/** Cap the in-process lastUsedAt throttle cache so memory stays bounded in long-lived servers. */
export const MCP_TOKEN_LAST_USED_CACHE_MAX = 1_000;

const lastUsedTouchCache = new Map<string, number>();

function recordLastUsedTouch(tokenId: string, nowMs: number): void {
  if (lastUsedTouchCache.has(tokenId)) {
    lastUsedTouchCache.delete(tokenId);
  } else if (lastUsedTouchCache.size >= MCP_TOKEN_LAST_USED_CACHE_MAX) {
    const oldestKey = lastUsedTouchCache.keys().next().value;
    if (oldestKey !== undefined) lastUsedTouchCache.delete(oldestKey);
  }
  lastUsedTouchCache.set(tokenId, nowMs);
}

/** Clear the in-process lastUsedAt throttle cache (intended for tests). */
export function resetMcpTokenLastUsedCache(): void {
  lastUsedTouchCache.clear();
}

export type ResolveMcpTokenOptions = {
  includeUser?: boolean;
  nowMs?: number;
  /**
   * Opt-in synchronous wait for the `lastUsedAt` DB write (tests only).
   * Production callers omit this so MCP auth never blocks on a SQLite write lock.
   */
  awaitLastUsedTouch?: boolean;
  /** Test hook to observe or simulate the `lastUsedAt` persistence write. */
  touchLastUsed?: (tokenId: string, lastUsedAt: Date) => Promise<unknown>;
};

/** Create + persist a token. Returns the PLAINTEXT token (show once) + row id. */
export async function createMcpToken(userId: string, name?: string): Promise<{ token: string; id: string }> {
  const token = generateMcpToken();
  const row = await prisma.mcpToken.create({
    data: {
      userId,
      name: name?.trim() || null,
      tokenHash: hashMcpToken(token),
      expiresAt: new Date(Date.now() + PAT_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { token, id: row.id };
}

/** Count a user's active (non-revoked, non-expired) tokens. */
export async function countActiveMcpTokens(userId: string): Promise<number> {
  return prisma.mcpToken.count({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
}

/** Resolve a bearer token to its owner. null if unknown/revoked/expired. Touches lastUsedAt (throttled to 60s, non-blocking). */
export async function resolveMcpToken(
  token: string | undefined | null,
  opts?: ResolveMcpTokenOptions,
): Promise<ResolvedToken | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashMcpToken(token) },
    ...(opts?.includeUser ? { include: { user: true } } : {}),
  });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= nowMs) return null;

  const dbLastUsedMs = row.lastUsedAt?.getTime();
  const memLastUsedMs = lastUsedTouchCache.get(row.id);
  const lastTouchedMs =
    dbLastUsedMs !== undefined && memLastUsedMs !== undefined
      ? Math.max(dbLastUsedMs, memLastUsedMs)
      : (dbLastUsedMs ?? memLastUsedMs);

  if (lastTouchedMs === undefined || nowMs - lastTouchedMs >= MCP_TOKEN_LAST_USED_THROTTLE_MS) {
    recordLastUsedTouch(row.id, nowMs);
    let touchPromise: Promise<unknown>;
    try {
      touchPromise = Promise.resolve(
        opts?.touchLastUsed
          ? opts.touchLastUsed(row.id, new Date(nowMs))
          : prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(nowMs) } }),
      ).catch(() => {});
    } catch {
      touchPromise = Promise.resolve();
    }
    if (opts?.awaitLastUsedTouch) {
      await touchPromise;
    } else {
      void touchPromise;
    }
  }

  const loadedUser = (row as { user?: User | null }).user;
  return loadedUser !== undefined
    ? { tokenId: row.id, userId: row.userId, user: loadedUser }
    : { tokenId: row.id, userId: row.userId };
}

/** List a user's active tokens (no secret material). */
export async function listMcpTokens(userId: string) {
  return prisma.mcpToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true, expiresAt: true },
  });
}

/** Revoke a token the user owns. true if a row was revoked. */
export async function revokeMcpToken(userId: string, id: string): Promise<boolean> {
  const res = await prisma.mcpToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (res.count === 1) {
    lastUsedTouchCache.delete(id);
    return true;
  }
  return false;
}
