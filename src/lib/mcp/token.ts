import crypto from "crypto";
import { prisma } from "@/lib/prisma";

const TOKEN_PREFIX = "heroai_pat_";

/** Generate a new opaque PAT (plaintext). Shown to the user exactly once. */
export function generateMcpToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex of a token — what we store and look up by (never store plaintext). */
export function hashMcpToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export type ResolvedToken = { tokenId: string; userId: string };

/** Create + persist a token. Returns the PLAINTEXT token (show once) + row id. */
export async function createMcpToken(userId: string, name?: string): Promise<{ token: string; id: string }> {
  const token = generateMcpToken();
  const row = await prisma.mcpToken.create({
    data: { userId, name: name?.trim() || null, tokenHash: hashMcpToken(token) },
  });
  return { token, id: row.id };
}

/** Resolve a bearer token to its owner. null if unknown/revoked/expired. Touches lastUsedAt. */
export async function resolveMcpToken(token: string | undefined | null): Promise<ResolvedToken | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = await prisma.mcpToken.findUnique({ where: { tokenHash: hashMcpToken(token) } });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { tokenId: row.id, userId: row.userId };
}

/** List a user's active tokens (no secret material). */
export async function listMcpTokens(userId: string) {
  return prisma.mcpToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });
}

/** Revoke a token the user owns. true if a row was revoked. */
export async function revokeMcpToken(userId: string, id: string): Promise<boolean> {
  const res = await prisma.mcpToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count === 1;
}
