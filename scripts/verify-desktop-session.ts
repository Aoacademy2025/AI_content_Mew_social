// Desktop session gate + bearer auth. Run against a throwaway SQLite DB:
//   node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-desktop-session.ts
//   npm run verify:desktop-session
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "desktop-session-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.DESKTOP_SESSION_VERIFY = "1";
execSync("./node_modules/.bin/prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const THAI_TEXT = /[ก-๙]/;

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) {
    console.error("❌ " + m);
    process.exit(1);
  }
  console.log("✓ " + m);
  passed++;
}

function bearerReq(url: string, token?: string) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(url, { method: "GET", headers });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json() as Record<string, unknown>;
  return body;
}

function collectDesktopRouteFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dirPath: string) {
    for (const name of readdirSync(dirPath)) {
      const full = join(dirPath, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

async function main() {
  const proxySource = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
  const publicBlock = proxySource.match(/const isPublicRoute = createRouteMatcher\(\[([\s\S]*?)\]\);/);
  assert(!!publicBlock, "isPublicRoute matcher exists in src/proxy.ts");
  assert(
    publicBlock![1].includes('"/api/mcp(.*)"'),
    '"/api/mcp(.*)" is in isPublicRoute',
  );
  assert(
    publicBlock![1].includes('"/api/desktop(.*)"'),
    '"/api/desktop(.*)" is in isPublicRoute like /api/mcp so cookie-less Bearer reaches withDesktop',
  );

  const { prisma } = await import("../src/lib/prisma");
  const { createMcpToken, revokeMcpToken } = await import("../src/lib/mcp/token");
  const { isDesktopEnabled, isDesktopInvited } = await import("../src/lib/desktop/flag");
  const { resolveDesktopPrincipal } = await import("../src/lib/desktop/auth");
  const { withDesktop } = await import("../src/lib/desktop/with-desktop");
  const { seatLimitForEffectivePlan } = await import("../src/lib/desktop/seats");
  const { setClerkOAuthAccessTokenVerifierForTests } = await import("../src/lib/mcp/clerk-token");
  const { GET } = await import("../src/app/api/desktop/session/route");
  const { NextResponse } = await import("next/server");

  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: {
      name: "desktop-pro",
      email: "desktop-pro@t.test",
      clerkId: "clerk_desktop_pro",
      plan: "PRO",
      subStatus: "active",
      minutesLimit: 80,
      minutesUsed: 0,
      aiAudioMinutesUsed: 10,
      aiTextCallsUsed: 25,
      usagePeriodStartedAt: new Date(),
    },
  });
  const { token: pat } = await createMcpToken(user.id, "desktop");

  const probe = withDesktop(async () => NextResponse.json({ ok: true }));
  const desktopRoutes: Array<{ name: string; handler: (req: Request) => Promise<Response> }> = [
    { name: "GET /api/desktop/session", handler: GET },
    { name: "GET /api/desktop/probe", handler: probe },
  ];

  const routeFiles = collectDesktopRouteFiles(join(process.cwd(), "src/app/api/desktop"));
  assert(routeFiles.length >= 1, "at least one /api/desktop/* route exists");
  for (const file of routeFiles) {
    const mod = await import(pathToFileURL(file).href) as Record<string, unknown>;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const handler = mod[method];
      if (typeof handler === "function") {
        desktopRoutes.push({
          name: `${method} ${file.replace(process.cwd(), "")}`,
          handler: handler as (req: Request) => Promise<Response>,
        });
      }
    }
  }

  // 1. flag off → 403 DESKTOP_DISABLED for every /api/desktop/*
  delete process.env.DESKTOP_APP;
  delete process.env.DESKTOP_ALLOWLIST;
  assert(isDesktopEnabled() === false, "DESKTOP_APP unset → flag off");
  for (const route of desktopRoutes) {
    const res = await route.handler(bearerReq("http://localhost/api/desktop/session", pat));
    const body = await jsonOf(res);
    assert(res.status === 403, `${route.name} flag off → 403`);
    assert(body.code === "DESKTOP_DISABLED", `${route.name} flag off → DESKTOP_DISABLED`);
    assert(typeof body.message === "string" && THAI_TEXT.test(body.message as string), `${route.name} flag off → Thai message`);
  }

  // 2. allowlist set and user absent → 403 DESKTOP_NOT_INVITED
  process.env.DESKTOP_APP = "1";
  process.env.DESKTOP_ALLOWLIST = "someone-else,another-id";
  assert(isDesktopEnabled() === true, "DESKTOP_APP=1 → flag on");
  assert(isDesktopInvited(user.id) === false, "user absent from allowlist");
  const notInvited = await GET(bearerReq("http://localhost/api/desktop/session", pat));
  const notInvitedBody = await jsonOf(notInvited);
  assert(notInvited.status === 403, "absent from allowlist → 403");
  assert(notInvitedBody.code === "DESKTOP_NOT_INVITED", "absent from allowlist → DESKTOP_NOT_INVITED");
  assert(typeof notInvitedBody.message === "string" && THAI_TEXT.test(notInvitedBody.message as string), "not invited → Thai message");
  const probeNotInvited = await probe(bearerReq("http://localhost/api/desktop/probe", pat));
  const probeNotInvitedBody = await jsonOf(probeNotInvited);
  assert(probeNotInvited.status === 403 && probeNotInvitedBody.code === "DESKTOP_NOT_INVITED", "probe route also DESKTOP_NOT_INVITED");

  // 3. PAT and Clerk token both resolve the same user
  process.env.DESKTOP_ALLOWLIST = "";
  assert(isDesktopInvited(user.id) === true, "empty allowlist → everyone invited");
  setClerkOAuthAccessTokenVerifierForTests(async (token) => {
    if (token === "clerk_oauth_live") return "clerk_desktop_pro";
    if (token === "clerk_oauth_expired") return null;
    return null;
  });

  const clerkPrincipal = await resolveDesktopPrincipal(bearerReq("http://localhost/api/desktop/session", "clerk_oauth_live"));
  const patPrincipal = await resolveDesktopPrincipal(bearerReq("http://localhost/api/desktop/session", pat));
  assert(!!clerkPrincipal && !!patPrincipal, "Clerk token and PAT both resolve a principal");
  assert(clerkPrincipal!.userId === user.id && patPrincipal!.userId === user.id, "PAT and Clerk token resolve the same user");

  const clerkSession = await GET(bearerReq("http://localhost/api/desktop/session", "clerk_oauth_live"));
  const patSession = await GET(bearerReq("http://localhost/api/desktop/session", pat));
  assert(clerkSession.status === 200 && patSession.status === 200, "session 200 for both Clerk token and PAT");
  const clerkBody = await jsonOf(clerkSession);
  const patBody = await jsonOf(patSession);
  assert(clerkBody.userId === user.id && patBody.userId === user.id, "session userId matches for both auth methods");
  assert(clerkBody.plan === "PRO" && clerkBody.effectivePlan === "PRO", "session plan + effectivePlan");
  assert(clerkBody.seatLimit === 2, "PRO seatLimit is 2");
  assert(typeof clerkBody.aiAudioMinutesRemaining === "number", "session reports aiAudioMinutesRemaining");
  assert(typeof clerkBody.aiTextCallsRemaining === "number", "session reports aiTextCallsRemaining");
  assert(typeof clerkBody.serverTime === "string", "session reports serverTime");

  const trialUser = await prisma.user.create({
    data: {
      name: "desktop-trial",
      email: "desktop-trial@t.test",
      plan: "PRO",
      trialEndsAt: new Date(Date.now() + 86400000),
      minutesLimit: 15,
      usagePeriodStartedAt: new Date(),
    },
  });
  assert(seatLimitForEffectivePlan("FREE") === 1, "FREE seats = 1");
  assert(seatLimitForEffectivePlan("PRO") === 2, "PRO seats = 2");
  assert(seatLimitForEffectivePlan("BUSINESS") === 5, "BUSINESS seats = 5");
  const { token: trialPat } = await createMcpToken(trialUser.id);
  const trialSession = await GET(bearerReq("http://localhost/api/desktop/session", trialPat));
  const trialBody = await jsonOf(trialSession);
  assert(trialSession.status === 200, "trial user session 200");
  assert(trialBody.effectivePlan === "PRO" && trialBody.seatLimit === 2, "trial → PRO seats via classifyEntitlement");

  // 4. expired/revoked → 401 with Thai message
  const listed = await prisma.mcpToken.findMany({ where: { userId: user.id } });
  assert(listed.length >= 1, "PAT row exists to revoke");
  assert(await revokeMcpToken(user.id, listed[0].id) === true, "revoke own PAT");
  const revoked = await GET(bearerReq("http://localhost/api/desktop/session", pat));
  const revokedBody = await jsonOf(revoked);
  assert(revoked.status === 401, "revoked PAT → 401");
  assert(typeof revokedBody.code === "string", "revoked PAT → stable code");
  assert(typeof revokedBody.message === "string" && THAI_TEXT.test(revokedBody.message as string), "revoked PAT → Thai message");

  const expiredOwner = await prisma.user.create({
    data: { name: "desktop-expired", email: "desktop-expired@t.test", plan: "PRO", subStatus: "active" },
  });
  const { token: soonExpired, id: expiredId } = await createMcpToken(expiredOwner.id);
  await prisma.mcpToken.update({ where: { id: expiredId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await GET(bearerReq("http://localhost/api/desktop/session", soonExpired));
  const expiredBody = await jsonOf(expired);
  assert(expired.status === 401, "expired PAT → 401");
  assert(typeof expiredBody.message === "string" && THAI_TEXT.test(expiredBody.message as string), "expired PAT → Thai message");

  const expiredClerk = await GET(bearerReq("http://localhost/api/desktop/session", "clerk_oauth_expired"));
  const expiredClerkBody = await jsonOf(expiredClerk);
  assert(expiredClerk.status === 401, "expired Clerk token → 401");
  assert(typeof expiredClerkBody.message === "string" && THAI_TEXT.test(expiredClerkBody.message as string), "expired Clerk token → Thai message");

  setClerkOAuthAccessTokenVerifierForTests(null);
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} DESKTOP SESSION CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
