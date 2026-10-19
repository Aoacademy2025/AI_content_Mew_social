// Token + auth/entitlement proof. Run against a throwaway SQLite DB with an ABSOLUTE path:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-token.ts
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
  generateMcpToken, hashMcpToken, createMcpToken, isMcpPatToken,
  resolveMcpToken, revokeMcpToken, listMcpTokens, countActiveMcpTokens,
  MCP_TOKEN_LAST_USED_THROTTLE_MS,
} from "../src/lib/mcp/token";
import { resolveMcpPrincipal, mcpAccessAllowed } from "../src/lib/mcp/auth";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

let n = 0;
async function mkUser(over: Record<string, unknown> = {}) {
  n++;
  return prisma.user.create({ data: { name: "u" + n, email: `u${n}@t.test`, ...over } });
}

async function main() {
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();

  // format + hash
  const raw = generateMcpToken();
  assert(raw.startsWith("heroai_pat_"), "generateMcpToken has heroai_pat_ prefix");
  assert(isMcpPatToken(raw) === true, "isMcpPatToken recognizes generated PAT");
  assert(isMcpPatToken("heroai_pat_revoked") === true, "isMcpPatToken recognizes any heroai_pat_ token");
  assert(isMcpPatToken("oat_clerk_oauth_token") === false, "isMcpPatToken rejects Clerk OAuth token");
  assert(isMcpPatToken(undefined) === false && isMcpPatToken(null) === false && isMcpPatToken("") === false, "isMcpPatToken rejects empty/missing token");
  const publicMcpRoute = readFileSync("src/app/api/[transport]/route.ts", "utf8");
  const internalMcpRoute = readFileSync("src/app/api/story-film/[transport]/route.ts", "utf8");
  assert(
    publicMcpRoute.includes("if (!token) return undefined;") && publicMcpRoute.includes("if (isMcpPatToken(token))"),
    "public MCP route short-circuits empty and heroai_pat_ tokens before Clerk OAuth verification",
  );
  assert(
    internalMcpRoute.includes("if (!token) return undefined;") && internalMcpRoute.includes("if (isMcpPatToken(token))"),
    "story-film MCP route short-circuits empty and heroai_pat_ tokens before Clerk OAuth verification",
  );
  assert(raw.length > 30, "generateMcpToken is long");
  assert(hashMcpToken(raw) === hashMcpToken(raw), "hash is deterministic");
  assert(hashMcpToken(raw) !== raw, "hash differs from plaintext");

  // create + resolve + lastUsedAt throttle
  const pro = await mkUser({ plan: "PRO" });
  const { token } = await createMcpToken(pro.id, "MacBook");
  const t0 = 1_700_000_000_000;
  const firstResolved = await resolveMcpToken(token, { includeUser: true, nowMs: t0 });
  assert(firstResolved?.userId === pro.id, "resolveMcpToken maps a fresh token to its owner");
  assert(firstResolved?.user?.id === pro.id, "resolveMcpToken(includeUser) joins owner row in 1 query");
  const afterFirst = (await listMcpTokens(pro.id))[0].lastUsedAt;
  assert(afterFirst?.getTime() === t0, "first resolveMcpToken populates lastUsedAt immediately");

  await resolveMcpToken(token, { nowMs: t0 + MCP_TOKEN_LAST_USED_THROTTLE_MS - 1 });
  const afterWithinWindow = (await listMcpTokens(pro.id))[0].lastUsedAt;
  assert(
    afterWithinWindow?.getTime() === t0,
    "resolveMcpToken skips SQLite write when lastUsedAt is within 60s throttle window",
  );

  const t1 = t0 + MCP_TOKEN_LAST_USED_THROTTLE_MS;
  await resolveMcpToken(token, { nowMs: t1 });
  const afterWindowElapsed = (await listMcpTokens(pro.id))[0].lastUsedAt;
  assert(
    afterWindowElapsed?.getTime() === t1,
    "resolveMcpToken refreshes lastUsedAt once 60s throttle window has elapsed",
  );

  assert((await countActiveMcpTokens(pro.id)) === 1, "countActiveMcpTokens = 1 after first token");
  assert((await resolveMcpToken("heroai_pat_bogus")) === null, "unknown token → null");
  assert((await resolveMcpToken("not-a-pat")) === null, "non-prefixed token → null");
  assert((await resolveMcpToken(undefined)) === null, "undefined token → null");

  // principal + entitlement gate
  const p = await resolveMcpPrincipal(token);
  assert(p?.userId === pro.id, "resolveMcpPrincipal returns the user");
  assert(p?.effectivePlan === "PRO", "PRO user effectivePlan is PRO");
  assert(mcpAccessAllowed(p!.effectivePlan) === true, "PRO is allowed");
  assert(mcpAccessAllowed("BUSINESS") === true, "BUSINESS is allowed");
  assert(mcpAccessAllowed("FREE") === false, "FREE is denied");

  // expired trial → downgraded + denied
  const expired = await mkUser({ plan: "PRO", trialEndsAt: new Date(Date.now() - 1000) });
  const { token: et } = await createMcpToken(expired.id);
  const ep = await resolveMcpPrincipal(et);
  assert(ep?.effectivePlan === "FREE", "expired trial downgrades effectivePlan to FREE");
  assert(mcpAccessAllowed(ep!.effectivePlan) === false, "expired-trial user denied");

  // revoke + ownership guard
  const proTokenId = (await listMcpTokens(pro.id))[0].id;
  assert((await revokeMcpToken(pro.id, proTokenId)) === true, "owner can revoke own token");
  assert((await resolveMcpToken(token)) === null, "revoked token no longer resolves");
  assert((await countActiveMcpTokens(pro.id)) === 0, "countActiveMcpTokens = 0 after revoke");
  assert((await resolveMcpPrincipal(token)) === null, "revoked token → no principal");

  const other = await mkUser({ plan: "PRO" });
  const { token: ot } = await createMcpToken(other.id);
  const otherTokenId = (await listMcpTokens(other.id))[0].id;
  assert((await revokeMcpToken(pro.id, otherTokenId)) === false, "cannot revoke another user's token");
  assert((await resolveMcpToken(ot)) !== null, "victim token still valid after failed cross-revoke");

  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP TOKEN CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
