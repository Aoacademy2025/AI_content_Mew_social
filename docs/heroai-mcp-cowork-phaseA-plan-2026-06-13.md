# HERO AI MCP — Phase A (Read-only + PAT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a remote HTTP MCP server inside the existing Next.js app that lets PRO/BUSINESS members connect their own agent (Claude Code / CLI) with a Personal Access Token and call 5 read-only tools scoped to their account.

**Architecture:** A single MCP route at `src/app/api/[transport]/route.ts` built with `mcp-handler` (wraps `@modelcontextprotocol/sdk`, Streamable HTTP, no Redis needed for request/response). Auth is a Bearer PAT verified by `verifyToken` → resolves to a `McpPrincipal` (user + current effective plan). Per-tool guard enforces PRO/BUSINESS and returns a friendly upsell instead of erroring. Tool logic and token/auth live in small `src/lib/mcp/*` units, each unit-tested with the team's `scripts/verify-*.ts` (tsx + throwaway SQLite). Token management for the Settings UI is a normal Clerk-session REST API (`/api/mcp-tokens`).

**Tech Stack:** Next.js 15.3.9 (App Router) · React 19 · Prisma 6.19 (SQLite) · Clerk · `mcp-handler` + `@modelcontextprotocol/sdk` + `zod` (new deps) · shadcn/ui (Dialog/Input) · sonner.

**Source spec:** `docs/heroai-mcp-cowork-design-2026-06-13.md` (§5 Phase A). Out of scope here: `create_video_job`, VideoJob table, worker queue, OAuth, admin tools (all Phase B / later).

**Endpoint reconciliation:** With `mcp-handler` the route lives at `app/api/[transport]/route.ts` and `basePath: "/api"`, so the v1 connect URL is **`https://studio.heroaiengine.com/api/mcp`** (not bare `/mcp` as the spec sketched). The pretty subdomain `mcp.heroaiengine.com` + a rewrite to `/api/mcp` is the later cosmetic step — design/tools/schema are unaffected.

---

## File Structure

**Create:**
- `src/lib/mcp/token.ts` — PAT generate/hash/create/resolve/list/revoke (DB-backed, pure interface)
- `src/lib/mcp/auth.ts` — `resolveMcpPrincipal` (bearer → user + effective plan) + `mcpAccessAllowed` gate
- `src/lib/mcp/tools.ts` — 5 read-only tool logic functions (return plain data, no MCP types)
- `src/lib/mcp/audit.ts` — `recordToolCall` (best-effort write to `ToolCallAudit`)
- `src/app/api/[transport]/route.ts` — MCP handler: registers 5 tools, `withMcpAuth(verifyToken)`
- `src/app/api/mcp-tokens/route.ts` — GET list / POST create (Clerk session, for Settings UI)
- `src/app/api/mcp-tokens/[id]/route.ts` — DELETE revoke (Clerk session)
- `src/components/settings/mcp-access-settings.tsx` — Settings "Agent / MCP" tab body
- `scripts/verify-mcp-token.ts` — unit tests for token + auth/entitlement
- `scripts/verify-mcp-tools.ts` — unit tests for the 5 tool functions
- `scripts/mint-dev-mcp-token.ts` — DEV helper: mint a PAT for a user by email

**Modify:**
- `prisma/schema.prisma` — add `McpToken` + `ToolCallAudit` models; add `mcpTokens McpToken[]` to `User`
- `package.json` — add `mcp-handler`, `@modelcontextprotocol/sdk`, `zod` (⚠️ shared file — heads-up to `wao1234` per CLAUDE.md; additive only)
- `src/app/(dashboard)/settings/page.tsx` — add "Agent / MCP" tab + content block

---

### Task 1: Add dependencies

**Files:**
- Modify: `package.json` (via npm)

⚠️ `package.json` is a coordinate-before-touching file (CLAUDE.md). These additions are purely additive (no version bumps to existing deps). Give `wao1234` a heads-up, then proceed.

- [ ] **Step 1: Install the MCP deps + zod v3**

```bash
npm install mcp-handler @modelcontextprotocol/sdk zod@^3.23.8
```

- [ ] **Step 2: Verify versions resolved (zod must be v3 — the SDK/handler peer)**

Run: `npm ls mcp-handler @modelcontextprotocol/sdk zod`
Expected: all three listed; `zod@3.x` (NOT 4.x). If npm pulled zod 4, run `npm install zod@^3.23.8` again and re-check.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(mcp): add mcp-handler, @modelcontextprotocol/sdk, zod"
```

---

### Task 2: Prisma schema — McpToken + ToolCallAudit

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `mcpTokens` relation to the `User` model**

In `prisma/schema.prisma`, inside `model User { ... }`, in the relations block (after `videos        Video[]`), add:

```prisma
  mcpTokens     McpToken[]
```

- [ ] **Step 2: Add the two new models** (place after the `Video` model block, before `enum Role`)

```prisma
model McpToken {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique
  name       String?
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  @@index([userId])
}

model ToolCallAudit {
  id           String   @id @default(cuid())
  userId       String?
  toolName     String
  status       String   // ok | denied | error
  durationMs   Int?
  requestJson  String?
  responseJson String?
  ipAddress    String?
  userAgent    String?
  createdAt    DateTime @default(now())

  @@index([userId])
  @@index([toolName, createdAt])
}
```

- [ ] **Step 3: Sync the dev DB (additive) + regenerate the client**

Run:
```bash
npx prisma db push
npx prisma generate
```
Expected: "Your database is now in sync with your Prisma schema." and the client regenerates (now exposes `prisma.mcpToken` and `prisma.toolCallAudit`).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(mcp): McpToken + ToolCallAudit models"
```

> Prod deploy note: `deploy.sh` runs `prisma db push` (additive) before restart, so these new tables land safely without a migration.

---

### Task 3 + 4: Token lib + auth/entitlement resolver (TDD)

Tasks 3 and 4 are tested by one script (`scripts/verify-mcp-token.ts`) because the auth resolver builds directly on the token lib.

**Files:**
- Create: `src/lib/mcp/token.ts`
- Create: `src/lib/mcp/auth.ts`
- Test: `scripts/verify-mcp-token.ts`

- [ ] **Step 1: Write the failing test** — create `scripts/verify-mcp-token.ts`

```typescript
// Token + auth/entitlement proof. Run against a throwaway SQLite DB with an ABSOLUTE path:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-token.ts
import { prisma } from "../src/lib/prisma";
import {
  generateMcpToken, hashMcpToken, createMcpToken,
  resolveMcpToken, revokeMcpToken, listMcpTokens,
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
  assert(raw.length > 30, "generateMcpToken is long");
  assert(hashMcpToken(raw) === hashMcpToken(raw), "hash is deterministic");
  assert(hashMcpToken(raw) !== raw, "hash differs from plaintext");

  // create + resolve
  const pro = await mkUser({ plan: "PRO" });
  const { token } = await createMcpToken(pro.id, "MacBook");
  assert((await resolveMcpToken(token))?.userId === pro.id, "resolveMcpToken maps a fresh token to its owner");
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
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
ROOT="$(pwd)"
DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-token.ts
```
Expected: FAIL — cannot resolve module `../src/lib/mcp/token` (not created yet).

- [ ] **Step 3: Implement `src/lib/mcp/token.ts`**

```typescript
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
```

- [ ] **Step 4: Implement `src/lib/mcp/auth.ts`**

```typescript
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaid } from "@/lib/plan-limits";
import { classifyEntitlement } from "@/lib/entitlements";
import { resolveMcpToken } from "@/lib/mcp/token";

export type McpPrincipal = {
  userId: string;
  plan: string;          // raw stored plan
  effectivePlan: string; // after entitlement classification (expired trial/plan → FREE)
  user: User;
};

/**
 * Resolve a bearer PAT to a principal with its CURRENT effective plan.
 * null when the token is invalid/revoked/expired or the user is gone.
 * Does NOT enforce plan — the per-tool guard does, so we can return a friendly
 * upsell instead of a bare 401 for downgraded-but-authenticated users.
 */
export async function resolveMcpPrincipal(token: string | undefined | null): Promise<McpPrincipal | null> {
  const resolved = await resolveMcpToken(token);
  if (!resolved) return null;
  const user = await prisma.user.findUnique({ where: { id: resolved.userId } });
  if (!user) return null;
  return { userId: user.id, plan: user.plan, effectivePlan: classifyEntitlement(user).effectivePlan, user };
}

/** Whether a principal's current effective plan may use member MCP tools. */
export function mcpAccessAllowed(effectivePlan: string): boolean {
  return isPaid(effectivePlan); // PRO | BUSINESS
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
ROOT="$(pwd)"
DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-token.ts
```
Expected: `✅ ALL <n> MCP TOKEN CHECKS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/token.ts src/lib/mcp/auth.ts scripts/verify-mcp-token.ts
git commit -m "feat(mcp): PAT token lib + entitlement resolver (tested)"
```

---

### Task 5: Tool logic functions (TDD)

**Files:**
- Create: `src/lib/mcp/tools.ts`
- Test: `scripts/verify-mcp-tools.ts`

- [ ] **Step 1: Write the failing test** — create `scripts/verify-mcp-tools.ts`

```typescript
// 5 read-only tool functions: scoping, cross-user denial, title/duration derivation.
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-tools.ts
import { prisma } from "../src/lib/prisma";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoTool, downloadVideoTool,
} from "../src/lib/mcp/tools";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();

  const alice = await prisma.user.create({ data: { name: "alice", email: "alice@t.test", plan: "PRO", geminiKey: "g" } });
  const bob = await prisma.user.create({ data: { name: "bob", email: "bob@t.test", plan: "BUSINESS" } });

  const content = await prisma.content.create({ data: { userId: alice.id, headline: "My Headline", videoDuration: 60 } });
  const done = await prisma.video.create({ data: { userId: alice.id, contentId: content.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 3, status: "COMPLETED", videoUrl: "https://x/v.mp4" } });
  const pending = await prisma.video.create({ data: { userId: alice.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 2, status: "PROCESSING", script: "raw script text used as fallback title" } });
  const bobVideo = await prisma.video.create({ data: { userId: bob.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1, status: "COMPLETED", videoUrl: "https://x/bob.mp4" } });

  // get_current_user
  const me = await getCurrentUserTool(alice);
  assert(me.plan === "PRO" && me.effectivePlan === "PRO", "get_current_user returns plan");
  assert(me.keysConfigured.gemini === true && me.keysConfigured.heygen === false, "keysConfigured reflects set keys");

  // list_my_videos — scoped + title/duration derivation
  const list = await listMyVideosTool(alice.id);
  assert(list.length === 2, "list_my_videos returns only the caller's videos");
  assert(list.every((v) => v.id !== bobVideo.id), "list_my_videos never leaks another user's video");
  const doneItem = list.find((v) => v.id === done.id)!;
  assert(doneItem.title === "My Headline", "title comes from content.headline");
  assert(doneItem.durationSec === 60, "durationSec comes from content.videoDuration");
  assert(doneItem.hasDownload === true, "hasDownload true when videoUrl present");
  const pendingItem = list.find((v) => v.id === pending.id)!;
  assert(pendingItem.title.startsWith("raw script"), "title falls back to script when no headline");

  // get_video_status — cross-user denial
  const st = await getVideoStatusTool(alice.id, done.id);
  assert(st.found && st.status === "COMPLETED" && st.hasDownload === true, "get_video_status: owner sees COMPLETED");
  assert((await getVideoStatusTool(alice.id, bobVideo.id)).found === false, "get_video_status denies cross-user");

  // get_video
  const gv = await getVideoTool(alice.id, pending.id);
  assert(gv.found && gv.status === "PROCESSING" && gv.hasDownload === false, "get_video returns detail for owner");
  assert((await getVideoTool(alice.id, bobVideo.id)).found === false, "get_video denies cross-user");

  // download_video
  const dl = await downloadVideoTool(alice.id, done.id);
  assert(dl.found && dl.ready && dl.url === "https://x/v.mp4", "download_video returns url when COMPLETED");
  const dlPending = await downloadVideoTool(alice.id, pending.id);
  assert(dlPending.found && dlPending.ready === false, "download_video not-ready for processing video");
  assert((await downloadVideoTool(alice.id, bobVideo.id)).found === false, "download_video denies cross-user");

  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP TOOLS CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-tools.ts`
Expected: FAIL — cannot resolve `../src/lib/mcp/tools`.

- [ ] **Step 3: Implement `src/lib/mcp/tools.ts`**

```typescript
import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";

function deriveTitle(v: { content: { headline: string | null } | null; script: string | null }): string {
  const h = v.content?.headline?.trim();
  if (h) return h;
  const s = v.script?.trim();
  if (s) return s.length > 60 ? s.slice(0, 57) + "…" : s;
  return "Untitled";
}

export async function getCurrentUserTool(user: User) {
  return {
    email: user.email,
    plan: user.plan,
    effectivePlan: classifyEntitlement(user).effectivePlan,
    usageCount: user.usageCount,
    usageLimit: user.usageLimit,
    keysConfigured: {
      gemini: !!user.geminiKey,
      heygen: !!user.heygenKey,
      elevenlabs: !!user.elevenlabsKey,
      pexels: !!user.pexelsKey,
      pixabay: !!user.pixabayKey,
    },
  };
}

export async function listMyVideosTool(userId: string, opts: { limit?: number; status?: VideoStatus } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const videos = await prisma.video.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, status: true, videoUrl: true, createdAt: true, script: true,
      content: { select: { headline: true, videoDuration: true } },
    },
  });
  return videos.map((v) => ({
    id: v.id,
    title: deriveTitle(v),
    status: v.status,
    durationSec: v.content?.videoDuration ?? null,
    hasDownload: !!v.videoUrl,
    createdAt: v.createdAt.toISOString(),
  }));
}

async function ownedVideo(userId: string, videoId: string) {
  return prisma.video.findFirst({
    where: { id: videoId, userId },
    select: {
      id: true, status: true, videoUrl: true, createdAt: true, updatedAt: true, script: true,
      avatarModel: true, voiceModel: true, sceneCount: true,
      content: { select: { headline: true, videoDuration: true } },
    },
  });
}

export async function getVideoStatusTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  return {
    found: true as const,
    videoId: v.id,
    status: v.status, // PENDING | PROCESSING | COMPLETED | FAILED
    hasDownload: !!v.videoUrl,
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function getVideoTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  return {
    found: true as const,
    videoId: v.id,
    title: deriveTitle(v),
    status: v.status,
    durationSec: v.content?.videoDuration ?? null,
    avatarModel: v.avatarModel,
    voiceModel: v.voiceModel,
    sceneCount: v.sceneCount,
    hasDownload: !!v.videoUrl,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function downloadVideoTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  if (v.status !== "COMPLETED" || !v.videoUrl) return { found: true as const, ready: false as const, status: v.status };
  return { found: true as const, ready: true as const, url: v.videoUrl };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-tools.ts`
Expected: `✅ ALL <n> MCP TOOLS CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/tools.ts scripts/verify-mcp-tools.ts
git commit -m "feat(mcp): 5 read-only tool functions (tested)"
```

---

### Task 6: Audit lib

**Files:**
- Create: `src/lib/mcp/audit.ts`

No dedicated test — it's a best-effort writer covered indirectly by the route smoke test (Task 7). Keep it tiny and crash-proof.

- [ ] **Step 1: Implement `src/lib/mcp/audit.ts`**

```typescript
import { prisma } from "@/lib/prisma";

export async function recordToolCall(entry: {
  userId?: string | null;
  toolName: string;
  status: "ok" | "denied" | "error";
  durationMs?: number;
  requestJson?: unknown;
}): Promise<void> {
  try {
    await prisma.toolCallAudit.create({
      data: {
        userId: entry.userId ?? null,
        toolName: entry.toolName,
        status: entry.status,
        durationMs: entry.durationMs ?? null,
        requestJson: entry.requestJson ? JSON.stringify(entry.requestJson).slice(0, 4000) : null,
      },
    });
  } catch {
    // audit must never break a tool call
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/mcp/audit.ts
git commit -m "feat(mcp): best-effort tool-call audit"
```

---

### Task 7: MCP route handler

**Files:**
- Create: `src/app/api/[transport]/route.ts`
- Create: `scripts/mint-dev-mcp-token.ts`

- [ ] **Step 1: Implement the route** — `src/app/api/[transport]/route.ts`

```typescript
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { resolveMcpPrincipal, mcpAccessAllowed } from "@/lib/mcp/auth";
import { recordToolCall } from "@/lib/mcp/audit";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoTool, downloadVideoTool,
} from "@/lib/mcp/tools";
import type { User, VideoStatus } from "@prisma/client";

export const runtime = "nodejs";

const UPSELL =
  "ฟีเจอร์ MCP ใช้ได้เฉพาะแผน PRO หรือ BUSINESS — แผนปัจจุบันยังเข้าถึงไม่ได้ อัปเกรดที่ studio.heroaiengine.com/pricing";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

type Extra = { authInfo?: AuthInfo };
function principalFrom(extra: Extra) {
  const e = (extra.authInfo?.extra ?? {}) as { userId?: string; effectivePlan?: string; user?: User };
  return { userId: e.userId, effectivePlan: e.effectivePlan, user: e.user };
}

// Per-tool guard (PRO/BUSINESS) + audit wrapper.
async function runTool(
  toolName: string,
  extra: Extra,
  fn: (p: { userId: string; user: User }) => Promise<unknown>,
  args?: unknown,
) {
  const started = Date.now();
  const { userId, effectivePlan, user } = principalFrom(extra);
  if (!userId || !user || !effectivePlan || !mcpAccessAllowed(effectivePlan)) {
    await recordToolCall({ userId, toolName, status: "denied", durationMs: Date.now() - started, requestJson: args });
    return text({ error: "plan_required", message: UPSELL });
  }
  try {
    const result = await fn({ userId, user });
    await recordToolCall({ userId, toolName, status: "ok", durationMs: Date.now() - started, requestJson: args });
    return text(result);
  } catch {
    await recordToolCall({ userId, toolName, status: "error", durationMs: Date.now() - started, requestJson: args });
    return text({ error: "internal_error", message: "เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง" });
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_current_user",
      { title: "Get current user", description: "บัญชี/แผน/โควตา/คีย์ที่ตั้งค่าไว้ของผู้ใช้ปัจจุบัน", inputSchema: {} },
      async (_args, extra) => runTool("get_current_user", extra, async (p) => getCurrentUserTool(p.user)),
    );

    server.registerTool(
      "list_my_videos",
      {
        title: "List my videos",
        description: "รายการวิดีโอของผู้ใช้ (ใหม่สุดก่อน)",
        inputSchema: {
          limit: z.number().int().min(1).max(100).default(20),
          status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]).optional(),
        },
      },
      async (args, extra) =>
        runTool("list_my_videos", extra, async (p) => listMyVideosTool(p.userId, { limit: args.limit, status: args.status as VideoStatus | undefined }), args),
    );

    server.registerTool(
      "get_video_status",
      { title: "Get video status", description: "สถานะของวิดีโอ 1 รายการ", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video_status", extra, async (p) => getVideoStatusTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "get_video",
      { title: "Get video", description: "รายละเอียดวิดีโอ 1 รายการ", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video", extra, async (p) => getVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "download_video",
      { title: "Download video", description: "ลิงก์ดาวน์โหลดวิดีโอ (ถ้าเรนเดอร์เสร็จแล้ว)", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("download_video", extra, async (p) => downloadVideoTool(p.userId, args.videoId), args),
    );
  },
  { serverInfo: { name: "heroai", version: "0.1.0" }, capabilities: { tools: {} } },
  { basePath: "/api", maxDuration: 60, verboseLogs: process.env.NODE_ENV === "development" },
);

// Bearer PAT → principal stored in authInfo.extra (consumed by runTool).
const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  const principal = await resolveMcpPrincipal(bearerToken);
  if (!principal) return undefined; // invalid/revoked/expired → 401
  return {
    token: bearerToken!,
    scopes: ["heroai:read"],
    clientId: principal.userId,
    extra: { userId: principal.userId, plan: principal.plan, effectivePlan: principal.effectivePlan, user: principal.user },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
```

- [ ] **Step 2: Add the dev token-mint helper** — `scripts/mint-dev-mcp-token.ts`

```typescript
// DEV ONLY: mint a PAT for an existing user by email (uses the dev DATABASE_URL from .env).
// Usage: npx tsx scripts/mint-dev-mcp-token.ts you@example.com
import { prisma } from "../src/lib/prisma";
import { createMcpToken } from "../src/lib/mcp/token";

async function main() {
  const email = process.argv[2];
  if (!email) { console.error("usage: tsx scripts/mint-dev-mcp-token.ts <email>"); process.exit(1); }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) { console.error("no user with email " + email); process.exit(1); }
  const { token } = await createMcpToken(user.id, "dev-cli");
  console.log(token);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 3: Build to catch bundling issues**

Run: `npm run build`
Expected: build succeeds. **If it fails** with a bundling error mentioning `@modelcontextprotocol/sdk` or `mcp-handler`, add `serverExternalPackages` to the ACTIVE config (`next.config.js` — it shadows `next.config.ts`, see CLAUDE.md; coordinate with `wao1234` before editing):

```javascript
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["mcp-handler", "@modelcontextprotocol/sdk"],
};

module.exports = nextConfig;
```
Then re-run `npm run build`.

- [ ] **Step 4: Manual smoke test — unauthorized returns 401**

Start dev (`npm run dev`), then:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer heroai_pat_bogus" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: `401`.

- [ ] **Step 5: Manual smoke test — tools work with a real PAT (MCP Inspector)**

Mint a PAT for your dev login user (e.g. the local QA `mewtest` user), then open the Inspector:
```bash
npx tsx scripts/mint-dev-mcp-token.ts mewtest@example.com   # prints heroai_pat_...
npx @modelcontextprotocol/inspector
```
In the Inspector UI: Transport = **Streamable HTTP**, URL = `http://localhost:3000/api/mcp`, add header `Authorization: Bearer <PAT>` → **Connect** → **List Tools** shows the 5 tools → **Call** `get_current_user` returns your plan JSON; **Call** `list_my_videos` returns your videos.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/[transport]/route.ts" scripts/mint-dev-mcp-token.ts
git commit -m "feat(mcp): Streamable HTTP route with PAT auth + 5 read-only tools"
```

---

### Task 8: Token management REST API (for Settings UI)

**Files:**
- Create: `src/app/api/mcp-tokens/route.ts`
- Create: `src/app/api/mcp-tokens/[id]/route.ts`

These use the normal Clerk **browser session** (`getCurrentUser`), NOT a PAT — they're called by the logged-in Settings page.

- [ ] **Step 1: Implement `src/app/api/mcp-tokens/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isPaid } from "@/lib/plan-limits";
import { classifyEntitlement } from "@/lib/entitlements";
import { apiError } from "@/lib/api-error";
import { createMcpToken, listMcpTokens } from "@/lib/mcp/token";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const tokens = await listMcpTokens(user.id);
    return NextResponse.json({ tokens });
  } catch (error) {
    return apiError({ route: "GET /api/mcp-tokens", error });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isPaid(classifyEntitlement(user).effectivePlan)) {
      return NextResponse.json({ error: "MCP token ใช้ได้เฉพาะแผน PRO/BUSINESS" }, { status: 403 });
    }
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    const { token, id } = await createMcpToken(user.id, name);
    return NextResponse.json({ id, token }, { status: 201 }); // token shown once
  } catch (error) {
    return apiError({ route: "POST /api/mcp-tokens", error });
  }
}
```

- [ ] **Step 2: Implement `src/app/api/mcp-tokens/[id]/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { revokeMcpToken } from "@/lib/mcp/token";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const ok = await revokeMcpToken(user.id, id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "DELETE /api/mcp-tokens/[id]", error });
  }
}
```

- [ ] **Step 3: Manual check (logged in via the dev QA login)**

With dev running and logged in, in the browser devtools console:
```js
await fetch("/api/mcp-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "test" }) }).then(r => r.json())
// → { id, token: "heroai_pat_..." }
await fetch("/api/mcp-tokens").then(r => r.json())
// → { tokens: [{ id, name: "test", lastUsedAt: null, createdAt }] }
```
A FREE user must get `403` from the POST.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/mcp-tokens/
git commit -m "feat(mcp): token management API for settings (create/list/revoke)"
```

---

### Task 9: Settings UI — "Agent / MCP" tab

**Files:**
- Create: `src/components/settings/mcp-access-settings.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`

- [ ] **Step 1: Implement `src/components/settings/mcp-access-settings.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Copy, Trash2, Terminal, Check, ArrowRight } from "lucide-react";
import { toast } from "sonner";

type TokenRow = { id: string; name: string | null; lastUsedAt: string | null; createdAt: string };

const MCP_URL = "https://studio.heroaiengine.com/api/mcp";
const connectCommand = (token: string) =>
  `claude mcp add --transport http heroai ${MCP_URL} \\\n  --header "Authorization: Bearer ${token}"`;

export function McpAccessSettings({ allowed }: { allowed: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/mcp-tokens")
      .then((r) => r.json())
      .then((d) => setTokens(Array.isArray(d.tokens) ? d.tokens : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  useEffect(() => { if (allowed) load(); else setLoading(false); }, [allowed]);

  async function createToken() {
    setCreating(true);
    try {
      const res = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "สร้าง token ไม่สำเร็จ"); return; }
      setNewToken(data.token);
      setName("");
      load();
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      const res = await fetch(`/api/mcp-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("เพิกถอนไม่สำเร็จ"); return; }
      toast.success("เพิกถอน token แล้ว");
      setTokens((t) => t.filter((x) => x.id !== id));
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setRevoking(null);
    }
  }

  function copy(textValue: string, label: string) {
    navigator.clipboard.writeText(textValue).then(() => toast.success(`คัดลอก${label}แล้ว`)).catch(() => toast.error("คัดลอกไม่สำเร็จ"));
  }

  if (!allowed) {
    return (
      <a href="/pricing" className="group block rounded-xl p-5 transition-all hover:-translate-y-0.5"
        style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.12), hsl(var(--accent-secondary) / 0.08))", border: "1px solid hsl(var(--accent-primary) / 0.25)" }}>
        <p className="text-base font-bold" style={{ color: "var(--ui-text-primary)" }}>Agent / MCP เป็นฟีเจอร์ของแผน PRO/BUSINESS</p>
        <p className="text-sm mt-1 flex items-center gap-1" style={{ color: "var(--ui-text-muted)" }}>
          อัปเกรดเพื่อต่อ Claude Code / agent ของคุณเข้ากับ HERO AI <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </p>
      </a>
    );
  }

  return (
    <div className="space-y-5">
      {/* How to connect */}
      <div className="rounded-2xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="h-4 w-4 text-cyan-400" strokeWidth={2.25} />
          <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ต่อ agent ของคุณเข้ากับ HERO AI</p>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--ui-text-muted)" }}>
          สร้าง token แล้ววางในคำสั่งนี้ (Claude Code / CLI) — Endpoint: <code className="text-cyan-300">{MCP_URL}</code>
        </p>
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">{`claude mcp add --transport http heroai ${MCP_URL} \\
  --header "Authorization: Bearer <YOUR_TOKEN>"`}</pre>
      </div>

      {/* Tokens */}
      <div className="flex items-center justify-between">
        <p className="eyebrow">Access Tokens</p>
        <button onClick={() => { setNewToken(null); setName(""); setOpen(true); }}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> สร้าง Token
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div>
      ) : tokens.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center text-sm" style={{ color: "var(--ui-text-muted)" }}>
          ยังไม่มี token — กด “สร้าง Token” เพื่อเริ่ม
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/3 p-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>{t.name || "Token"}</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                  สร้าง {new Date(t.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}
                  {t.lastUsedAt ? ` · ใช้ล่าสุด ${new Date(t.lastUsedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}` : " · ยังไม่เคยใช้"}
                </p>
              </div>
              <button onClick={() => revoke(t.id)} disabled={revoking === t.id}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                style={{ border: "1px solid hsl(0 0% 100% / 0.08)", color: "var(--ui-text-muted)" }}>
                {revoking === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />}
                เพิกถอน
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Generate / show-once dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{newToken ? "Token ของคุณ" : "สร้าง Access Token"}</DialogTitle>
            <DialogDescription>
              {newToken ? "คัดลอกเก็บไว้เดี๋ยวนี้ — token นี้จะไม่ถูกแสดงอีก" : "ตั้งชื่อเครื่อง/agent เพื่อจำว่า token นี้ใช้ที่ไหน"}
            </DialogDescription>
          </DialogHeader>

          {newToken ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-black/40 p-3 text-xs break-all text-cyan-300">{newToken}</div>
              <button onClick={() => copy(newToken, "token")} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white" style={{ background: "hsl(var(--accent-primary) / 0.15)", border: "1px solid hsl(var(--accent-primary) / 0.3)" }}>
                <Copy className="h-4 w-4" /> คัดลอก token
              </button>
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">{connectCommand(newToken)}</pre>
              <button onClick={() => copy(connectCommand(newToken), "คำสั่ง connect")} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white/80" style={{ border: "1px solid hsl(0 0% 100% / 0.1)" }}>
                <Copy className="h-4 w-4" /> คัดลอกคำสั่ง connect
              </button>
            </div>
          ) : (
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น MacBook Claude Code" className="h-10 rounded-lg border-0 text-sm" style={{ background: "var(--ui-input-bg)", padding: "0 12px", color: "var(--ui-text-secondary)" }} />
          )}

          <DialogFooter>
            {newToken ? (
              <button onClick={() => setOpen(false)} className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
                <Check className="h-4 w-4" /> เสร็จแล้ว
              </button>
            ) : (
              <button onClick={createToken} disabled={creating} className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} สร้าง
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab into `src/app/(dashboard)/settings/page.tsx` — import + icon**

Add the component import after the other settings imports (near line 17):
```tsx
import { McpAccessSettings } from "@/components/settings/mcp-access-settings";
```
Add `Terminal` to the existing lucide-react import (line 8–11): change `MessageCircle,` to `MessageCircle, Terminal,` (anywhere in that import list).

- [ ] **Step 3: Add the tab entry**

Find:
```tsx
  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
    { id: "billing",  label: "Billing",  icon: CreditCard },
  ];
```
Replace with:
```tsx
  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
    { id: "mcp",      label: "Agent / MCP", icon: Terminal },
    { id: "billing",  label: "Billing",  icon: CreditCard },
  ];
```

- [ ] **Step 4: Allow `?tab=mcp` deep-link**

Find:
```tsx
    if (t === "api-keys" || t === "billing") setTab(t);
```
Replace with:
```tsx
    if (t === "api-keys" || t === "billing" || t === "mcp") setTab(t);
```

- [ ] **Step 5: Add the tab content block**

Find the end of the Billing tab block (the `)}` that closes `{tab === "billing" && (` ... `</div>\n        )}`) and insert AFTER it, before `{/* Coupon */}`:
```tsx
        {/* Agent / MCP Tab */}
        {tab === "mcp" && (
          <div className="pp-card p-7"><span aria-hidden className="pp-card-border" />
            <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{ background: "hsl(var(--accent-primary) / 0.1)", border: "1px solid hsl(var(--accent-primary) / 0.2)" }}>
                <Terminal className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>Agent / MCP Access</h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>ต่อ Claude Code / agent ของคุณเข้ากับ HERO AI</p>
              </div>
            </div>
            <McpAccessSettings allowed={meUser?.plan === "PRO" || meUser?.plan === "BUSINESS"} />
          </div>
        )}
```

- [ ] **Step 6: Manual verification**

`npm run dev`, open `/settings`, click the **Agent / MCP** tab:
- As a PRO/BUSINESS user: see connect instructions, "สร้าง Token" → modal shows a `heroai_pat_…` once with copy buttons → new row appears → "เพิกถอน" removes it.
- As a FREE user: see the upsell card (no token UI).

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/mcp-access-settings.tsx "src/app/(dashboard)/settings/page.tsx"
git commit -m "feat(mcp): Settings Agent/MCP tab — generate/list/revoke tokens"
```

---

### Task 10: End-to-end with a real Claude Code client

**Files:** none (verification only)

- [ ] **Step 1: Connect a real agent to the local server**

Generate a token from the Settings UI (Task 9) for your dev PRO user, then:
```bash
claude mcp add --transport http heroai-local http://localhost:3000/api/mcp \
  --header "Authorization: Bearer <PASTE_TOKEN>"
claude mcp list   # heroai-local should report "connected"
```

- [ ] **Step 2: Exercise the tools from an agent**

In a Claude Code session, confirm the agent can call `get_current_user` (returns your plan) and `list_my_videos` (returns your videos), and that `download_video` on a COMPLETED video returns a URL.

- [ ] **Step 3: Confirm the deny path**

Downgrade the dev user to FREE (or use a FREE user's token), call any tool → expect the friendly `plan_required` upsell message (not a crash). Confirm rows appear in `ToolCallAudit` (`status` ok/denied).

- [ ] **Step 4: Clean up the local connection**

```bash
claude mcp remove heroai-local
rm -f prisma/test-mcp.db   # remove the throwaway test DB
```

---

## Self-Review

**Spec coverage (vs `docs/heroai-mcp-cowork-design-2026-06-13.md` §5):**
- §5.1 five read-only tools → Task 5 (logic) + Task 7 (registered). ✓ (`get_current_user`, `list_my_videos`, `get_video_status`, `get_video`, `download_video`)
- §5.2 PAT design (heroai_pat_ prefix, sha256 hash, show-once, revoke, expiry check) → Task 3. ✓
- §5.3 Settings UI (PRO/BUSINESS gate, generate modal show-once, connect command, tokens list, revoke, FREE upsell) → Task 9. ✓
- §5.4 MCP transport on app path (`/api/mcp`), Bearer in header, stateless → Task 7. ✓
- §5.5 gates: auth (401), entitlement (friendly upsell), audit every call → Task 7 (`runTool`). ✓ Rate-limit is listed in §5.5 as a gate — **deferred to a follow-up** (see Open Questions #1; not in this plan's tasks). Flagged here so it isn't silently dropped.
- §7 data model `McpToken`, `ToolCallAudit` → Task 2. ✓ (`VideoJob` is Phase B — correctly excluded.)

**Type consistency:** `McpPrincipal.effectivePlan` (auth.ts) feeds `mcpAccessAllowed` (auth.ts) and `runTool` (route). `resolveMcpToken`/`resolveMcpPrincipal` return shapes match their test assertions. Tool functions' return keys (`found`, `ready`, `hasDownload`, `durationSec`, `title`) match the verify-mcp-tools assertions. `VideoStatus` enum values (`PENDING|PROCESSING|COMPLETED|FAILED`) are identical in the zod enum, the tool cast, and the schema. ✓

**Placeholder scan:** none — every step ships real code or a concrete command. The one conditional (Task 7 Step 3 `serverExternalPackages`) includes the exact change and is gated on an observable build error.

## Deferred to follow-up / Phase B (not built here)
- Per-token **rate limiting** (§5.5) — decide req/min per plan, then add to `runTool`.
- PAT **expiry policy** (`expiresAt` column exists & is enforced, but the UI never sets it → tokens are non-expiring for now).
- **OAuth** connect flow (for Claude.ai/desktop "paste URL only" clients).
- `create_video_job` + `VideoJob` table + worker queue + quota/BYOK gates (Phase B).
- MCP usage surfaced in a Settings usage dashboard.
