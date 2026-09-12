// Task B3 — the authentication hot path may reuse the `User` row it already
// loaded, and it may not change a single outcome while doing so.
//
// What this proves, against a throwaway SQLite DB and the REAL route handler:
//   (a) golden equality — for six fixtures, calling the entitlement functions
//       WITHOUT `preloaded` (today's code path, untouched) and WITH `preloaded`
//       leaves a byte-identical `User` row and returns identical values;
//   (b) no duplicate read — one `getCurrentUser()` reads the `User` row once;
//   (c) steady state writes nothing — a second consecutive call issues 0 writes
//       for every fixture, INCLUDING the paid-no-Payment-evidence cohort whose
//       0-row `UPDATE User` A3 §A3.1 measured on every request (B6 row 3) —
//       while a genuine change still writes on the first call;
//   (d) statement budget — `/api/user/me` in steady state issues exactly
//       A3's measured count minus the duplicate reads §A3.2 proves, and 0 writes.
//
// Clerk is the only thing stubbed (`auth()` returns a clerkId; `currentUser()`
// is never reached on the fast path). Prisma, the entitlement libraries and the
// route handler are the real modules, bundled from source so that the harness
// and the app share one module instance and one PrismaClient.
//
// Run: tsx scripts/verify-auth-query-budget.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { User } from "@prisma/client";

// ── The numbers this test pins (A3 §A3.1 / §A3.2, measured 2026-09-12) ──────
/** A3 §A3.2: `/api/user/me`, Clerk fast path, non-admin paying customer. */
const A3_USER_ME_STATEMENTS = 34;
/**
 * A3 §A3.2 proves four of those 34 statements re-read the `User` row the auth
 * path already holds: the initial `SELECT User` inside syncUserEntitlement (#2),
 * syncStoredBundleEntitlementForUser (#3) and resolvePaidEquivalentEntitlement
 * (#5), plus the route's own second `prisma.user.findUnique` (step 2).
 */
const B3_DUPLICATE_READS_REMOVED = 4;
/** (d) — what `/api/user/me` must cost after B3. */
const USER_ME_STATEMENT_BUDGET = A3_USER_ME_STATEMENTS - B3_DUPLICATE_READS_REMOVED; // 30
/** A3 §A3.2: the auth prefix is 8 statements today (12 for the no-evidence cohort). */
const A3_AUTH_PREFIX_STATEMENTS = 8;
/** (b) — one `SELECT User`, one `SELECT BundleEntitlement`, three evidence reads. */
const AUTH_PREFIX_BUDGET = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const future = (days: number) => new Date(NOW.getTime() + days * DAY_MS);
const past = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ── Harness ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "auth-query-budget-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.NODE_ENV = "test";
// Deterministic flag state: every branch below is the flag-off (default) one.
process.env.CREDITS_LIVE = "0";
process.env.MINUTE_QUOTA = "0";
delete process.env.PRESERVE_TRIAL_ON_CONVERT;
delete process.env.MCP_SERVICE_SECRET;
delete process.env.HERO_VOICE_CANARY_EXECUTION_MODE;

type Subject = {
  GET: () => Promise<Response>;
  getCurrentUser: () => Promise<User | null>;
  syncUserEntitlement: (
    userId: string,
    now?: Date,
    preloaded?: User,
  ) => Promise<{ user: unknown; decision: unknown; changed: boolean } | null>;
  syncStoredBundleEntitlementForUser: (
    userId: string,
    now?: Date,
    options?: { forcePrimary?: boolean },
    preloaded?: User,
  ) => Promise<{ changed: boolean; activated: boolean }>;
  resolvePaidEquivalentEntitlement: (
    userId: string,
    now?: Date,
    preloaded?: User,
  ) => Promise<Record<string, unknown>>;
};

/**
 * Bundle the real route + entitlement modules into one CommonJS file with Clerk
 * stubbed out. `packages: "external"` keeps @prisma/client, next/server and the
 * rest of node_modules real; `src/lib/prisma.ts` resolves the client off
 * globalThis, so the bundle and this script share one PrismaClient.
 */
async function loadSubject(): Promise<Subject> {
  const cacheDir = resolve("node_modules/.cache/verify-auth-query-budget");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "subject.cjs");
  await build({
    stdin: {
      contents: `
        export { GET } from "@/app/api/user/me/route";
        export { getCurrentUser } from "@/lib/clerk-auth";
        export { syncUserEntitlement } from "@/lib/entitlements";
        export { syncStoredBundleEntitlementForUser } from "@/lib/bundle-entitlement";
        export { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
      `,
      resolveDir: process.cwd(),
      sourcefile: "verify-auth-query-budget-entry.ts",
      loader: "ts",
    },
    bundle: true,
    outfile,
    platform: "node",
    format: "cjs",
    packages: "external",
    logLevel: "error",
    plugins: [{
      name: "auth-query-budget",
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, ({ path: specifier }) => {
          const base = resolve("src", specifier.slice(2));
          for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
            if (existsSync(candidate)) return { path: candidate };
          }
          throw new Error(`cannot resolve ${specifier}`);
        });
        // Clerk and the request-scoped Next helpers are the ONLY stubs.
        builder.onResolve(
          { filter: /^(server-only|next\/headers|@clerk\/nextjs\/server)$/ },
          ({ path: specifier }) => ({ path: specifier, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path: specifier }) => {
          if (specifier === "server-only") return { contents: "export {};" };
          if (specifier === "next/headers") {
            return {
              contents: "export const cookies = async () => ({ get: () => undefined });"
                + "export const headers = async () => new Headers();",
            };
          }
          return {
            contents: "export const auth = async () => ({ userId: globalThis.__authQueryBudgetClerkId });"
              + "export const currentUser = async () => { throw new Error('Clerk slow path must not run'); };",
          };
        });
      },
    }],
  });
  return createRequire(resolve("package.json"))(outfile) as Subject;
}

async function main() {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "inherit", env: process.env });

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    datasourceUrl: process.env.DATABASE_URL,
  });
  // Installed before the subject is loaded: src/lib/prisma.ts reuses it.
  (globalThis as unknown as { prisma: unknown }).prisma = prisma;

  let captured: string[] | null = null;
  (prisma as unknown as { $on: (e: string, cb: (x: { query: string }) => void) => void })
    .$on("query", (event) => { if (captured) captured.push(event.query); });

  /** Run `fn` and return every SQL statement Prisma issued while it ran. */
  async function record<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const sink: string[] = [];
    captured = sink;
    try {
      const result = await fn();
      // Prisma emits the query event as the response is decoded; let the
      // microtask queue drain before the sink is read.
      await new Promise((r) => setTimeout(r, 20));
      return { result, sql: [...sink] };
    } finally {
      captured = null;
    }
  }

  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
  const isSelect = (sql: string) => /^\s*SELECT\b/i.test(sql);
  const isUserRead = (sql: string) => isSelect(sql) && /FROM\s+`main`\.`User`/i.test(sql);

  const subject = await loadSubject();

  // ── Fixtures ─────────────────────────────────────────────────────────────
  // Each fixture rebuilds itself from scratch so the golden run and the
  // preloaded run start from byte-identical state.
  type Fixture = { id: string; clerkId: string; label: string; create: () => Promise<void> };

  async function baseUser(id: string, data: Record<string, unknown>) {
    await prisma.user.create({
      data: {
        id,
        clerkId: `clerk_${id}`,
        name: id,
        email: `${id}@example.test`,
        ...data,
      } as never,
    });
  }

  const fixtures: Fixture[] = [
    {
      id: "b3-free", clerkId: "clerk_b3-free", label: "FREE",
      create: async () => { await baseUser("b3-free", { plan: "FREE" }); },
    },
    {
      id: "b3-trial", clerkId: "clerk_b3-trial", label: "PRO trial",
      create: async () => {
        await baseUser("b3-trial", {
          plan: "PRO", trialStartedAt: past(2), trialEndsAt: future(5), planExpiresAt: future(5),
        });
      },
    },
    {
      id: "b3-stripe", clerkId: "clerk_b3-stripe", label: "PRO Stripe subscription",
      create: async () => {
        await baseUser("b3-stripe", {
          plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_b3_stripe",
          billingPeriod: "monthly", planExpiresAt: future(30),
        });
        await prisma.payment.create({
          data: {
            userId: "b3-stripe", stripeSessionId: "cs_b3_stripe", plan: "PRO", amount: 59900,
            currency: "thb", status: "PAID", periodDays: 30, paidAt: past(1),
          },
        });
        // A completed clip: this is A3's measured fixture (a paying customer who
        // is off the First-Clip Path), which is what makes 34 the baseline.
        await prisma.video.create({
          data: {
            userId: "b3-stripe", script: "s", status: "COMPLETED", videoUrl: "/renders/b3.mp4",
            avatarModel: "none", voiceModel: "gemini", sceneCount: 1,
          },
        });
      },
    },
    {
      id: "b3-bundle-active", clerkId: "clerk_b3-bundle-active", label: "bundle active (first activation)",
      create: async () => {
        await baseUser("b3-bundle-active", { plan: "FREE" });
        await prisma.bundleEntitlement.create({
          data: {
            email: "b3-bundle-active@example.test", grantId: "grant-active",
            subscriptionId: "sub_bundle_active", status: "ACTIVE", accessEndsAt: future(30),
            billingPeriod: "monthly", amountThb: 1990, lastEventId: "evt-active-1",
            eventOccurredAt: past(1),
          },
        });
      },
    },
    {
      id: "b3-bundle-expired", clerkId: "clerk_b3-bundle-expired", label: "bundle expired",
      create: async () => {
        await baseUser("b3-bundle-expired", {
          plan: "PRO", bundlePrimary: true, bundleGrantId: "grant-expired",
          bundleStatus: "ACTIVE", bundleAccessExpiresAt: past(1), bundleAmountThb: 1990,
          bundleLastEventId: "evt-expired-0",
        });
        await prisma.bundleEntitlement.create({
          data: {
            email: "b3-bundle-expired@example.test", grantId: "grant-expired",
            subscriptionId: "sub_bundle_expired", status: "ACTIVE", accessEndsAt: past(1),
            billingPeriod: "monthly", amountThb: 1990, lastEventId: "evt-expired-1",
            eventOccurredAt: past(1),
          },
        });
      },
    },
    {
      // The 107-account cohort of A3 §A3.1: a paid plan with a live subscription
      // and NO qualifying Payment row. Its downgrade guard matches 0 rows, so the
      // `UPDATE User` is pure write-lock cost on every authenticated request.
      id: "b3-no-evidence", clerkId: "clerk_b3-no-evidence", label: "PRO active sub, no Payment evidence",
      create: async () => {
        await baseUser("b3-no-evidence", {
          plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_b3_no_evidence",
          billingPeriod: "monthly", planExpiresAt: future(30),
        });
      },
    },
  ];

  async function resetAll() {
    await prisma.payment.deleteMany({});
    await prisma.video.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.couponRedemption.deleteMany({});
    await prisma.coupon.deleteMany({});
    await prisma.administratorGrant.deleteMany({});
    await prisma.bundleEntitlement.deleteMany({});
    await prisma.user.deleteMany({});
  }

  /**
   * `createdAt`/`updatedAt` are wall-clock stamps of the run itself, not
   * decision state — every other column is compared byte for byte. Writes are
   * counted directly by (c), so dropping `updatedAt` cannot hide a stray write.
   */
  function snapshot(row: unknown): string {
    return JSON.stringify(row, (key, value) =>
      key === "createdAt" || key === "updatedAt" ? undefined : value);
  }

  // ── (a) golden equality ───────────────────────────────────────────────────
  console.log("\n(a) golden: the preloaded path leaves the same row and returns the same value");
  for (const fixture of fixtures) {
    await resetAll();
    await fixture.create();
    const goldenReturn = await subject.syncUserEntitlement(fixture.id, NOW);
    const goldenRow = await prisma.user.findUnique({ where: { id: fixture.id } });
    const goldenBundle = await subject.syncStoredBundleEntitlementForUser(fixture.id, NOW);
    const goldenPaid = await subject.resolvePaidEquivalentEntitlement(fixture.id, NOW);

    await resetAll();
    await fixture.create();
    const preloaded = (await prisma.user.findUnique({ where: { id: fixture.id } }))!;
    const newReturn = await subject.syncUserEntitlement(fixture.id, NOW, preloaded);
    const newRow = await prisma.user.findUnique({ where: { id: fixture.id } });
    const bundlePreload = (await prisma.user.findUnique({ where: { id: fixture.id } }))!;
    const newBundle = await subject.syncStoredBundleEntitlementForUser(
      fixture.id, NOW, undefined, bundlePreload);
    const paidPreload = (await prisma.user.findUnique({ where: { id: fixture.id } }))!;
    const newPaid = await subject.resolvePaidEquivalentEntitlement(fixture.id, NOW, paidPreload);

    check(`${fixture.label}: User row is byte-identical`,
      snapshot(goldenRow) === snapshot(newRow),
      `golden=${snapshot(goldenRow)}\n        new   =${snapshot(newRow)}`);
    check(`${fixture.label}: syncUserEntitlement returns the same value`,
      snapshot(goldenReturn) === snapshot(newReturn),
      `golden=${snapshot(goldenReturn)}\n        new   =${snapshot(newReturn)}`);
    check(`${fixture.label}: syncStoredBundleEntitlementForUser returns the same value`,
      JSON.stringify(goldenBundle) === JSON.stringify(newBundle),
      `golden=${JSON.stringify(goldenBundle)} new=${JSON.stringify(newBundle)}`);
    check(`${fixture.label}: resolvePaidEquivalentEntitlement returns the same decision`,
      JSON.stringify(goldenPaid) === JSON.stringify(newPaid),
      `golden=${JSON.stringify(goldenPaid)} new=${JSON.stringify(newPaid)}`);
  }

  // Evidence that only reaches the decision through a relation load: the
  // preloaded path fetches those relations on their own instead of nesting them
  // under the `User` read, so both shapes must decide identically.
  console.log("\n(a2) golden: coupon-grant and administrator-grant evidence");
  {
    await resetAll();
    await baseUser("b3-coupon", { plan: "PRO", planExpiresAt: future(20) });
    await prisma.coupon.create({
      data: { code: "B3GRANT", type: "GRANT", plan: "PRO", durationDays: 30, maxUses: 10 },
    });
    const coupon = await prisma.coupon.findUnique({ where: { code: "B3GRANT" } });
    await prisma.couponRedemption.create({
      data: {
        userId: "b3-coupon", couponId: coupon!.id, redeemedAt: past(2), outcome: "ACTIVATED",
        entitlementPlan: "PRO", entitlementStartsAt: past(2), entitlementExpiresAt: future(28),
      },
    });
    await baseUser("b3-grant", { plan: "BUSINESS" });
    await prisma.administratorGrant.create({
      data: {
        userId: "b3-grant", plan: "BUSINESS", reason: "comped", startsAt: past(1),
        expiresAt: future(30), permanent: false, grantedById: "b3-coupon",
      },
    });
    for (const id of ["b3-coupon", "b3-grant"]) {
      const golden = await subject.resolvePaidEquivalentEntitlement(id, NOW);
      const row = (await prisma.user.findUnique({ where: { id } }))!;
      const fresh = await subject.resolvePaidEquivalentEntitlement(id, NOW, row);
      check(`${id}: relation-only evidence decides identically`,
        JSON.stringify(golden) === JSON.stringify(fresh),
        `golden=${JSON.stringify(golden)} new=${JSON.stringify(fresh)}`);
    }
  }

  // ── (b) + (c) one auth call: one User read, and a steady state that writes ─
  console.log("\n(b)(c) getCurrentUser(): one User read, and no writes in steady state");
  for (const fixture of fixtures) {
    await resetAll();
    await fixture.create();
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = fixture.clerkId;

    const first = await record(() => subject.getCurrentUser());
    check(`${fixture.label}: authenticates`, first.result?.id === fixture.id,
      `got ${String(first.result?.id)}`);

    const steady = await record(() => subject.getCurrentUser());
    const userReads = steady.sql.filter(isUserRead).length;
    const writes = steady.sql.filter(isWrite).length;
    check(`${fixture.label}: steady state reads the User row exactly once (A3: 4–5)`,
      userReads === 1, `got ${userReads}\n        ${steady.sql.join("\n        ")}`);
    check(`${fixture.label}: steady-state auth prefix is ${AUTH_PREFIX_BUDGET} statements (A3: ${A3_AUTH_PREFIX_STATEMENTS})`,
      steady.sql.length === AUTH_PREFIX_BUDGET,
      `got ${steady.sql.length}\n        ${steady.sql.join("\n        ")}`);
    check(`${fixture.label}: steady state issues 0 writes`,
      writes === 0, `got ${writes}\n        ${steady.sql.filter(isWrite).join("\n        ")}`);
  }

  // ── (c2) B6 row 3: the skip must not swallow a real downgrade ─────────────
  console.log("\n(c2) a genuine change still writes on the first call");
  {
    // The no-evidence cohort, after its subscription really ends.
    await resetAll();
    await fixtures[5].create();
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = fixtures[5].clerkId;
    await subject.getCurrentUser();
    const quiet = await record(() => subject.getCurrentUser());
    check("no-evidence cohort: steady state writes nothing",
      quiet.sql.filter(isWrite).length === 0, `got ${quiet.sql.filter(isWrite).length}`);

    await prisma.user.update({
      where: { id: "b3-no-evidence" },
      data: { subStatus: null, planExpiresAt: past(1) },
    });
    const changed = await record(() => subject.getCurrentUser());
    const after = await prisma.user.findUnique({ where: { id: "b3-no-evidence" } });
    check("no-evidence cohort: the first call after a genuine change DOES write",
      changed.sql.filter(isWrite).length > 0 && after?.plan === "FREE",
      `writes=${changed.sql.filter(isWrite).length} plan=${after?.plan}`);
  }

  console.log("\n(c3) every downgrade the guard is supposed to catch still fires");
  const downgrades: { id: string; label: string; create: () => Promise<void> }[] = [
    {
      id: "b3-trial-expired", label: "expired trial",
      create: async () => {
        await baseUser("b3-trial-expired", {
          plan: "PRO", trialStartedAt: past(9), trialEndsAt: past(2), minutesUsed: 3,
        });
      },
    },
    {
      id: "b3-term-expired", label: "expired paid term",
      create: async () => {
        await baseUser("b3-term-expired", { plan: "PRO", planExpiresAt: past(2) });
      },
    },
    {
      id: "b3-label-only", label: "paid label with no expiry and no evidence (REVIEW)",
      create: async () => { await baseUser("b3-label-only", { plan: "BUSINESS" }); },
    },
  ];
  for (const fixture of downgrades) {
    await resetAll();
    await fixture.create();
    const golden = await subject.syncUserEntitlement(fixture.id, NOW);
    const goldenRow = await prisma.user.findUnique({ where: { id: fixture.id } });

    await resetAll();
    await fixture.create();
    const preloaded = (await prisma.user.findUnique({ where: { id: fixture.id } }))!;
    const result = await record(() => subject.syncUserEntitlement(fixture.id, NOW, preloaded));
    const row = await prisma.user.findUnique({ where: { id: fixture.id } });
    check(`${fixture.label}: still downgraded to FREE (write not skipped)`,
      row?.plan === "FREE" && result.result?.changed === true
      && result.sql.filter(isWrite).length > 0,
      `plan=${row?.plan} changed=${result.result?.changed} writes=${result.sql.filter(isWrite).length}`);
    check(`${fixture.label}: identical to the golden run`,
      snapshot(goldenRow) === snapshot(row) && snapshot(golden) === snapshot(result.result),
      `golden=${snapshot(goldenRow)}\n        new   =${snapshot(row)}`);
  }

  // ── (d) /api/user/me statement budget ────────────────────────────────────
  console.log("\n(d) /api/user/me statement budget");
  {
    await resetAll();
    await fixtures[2].create(); // the non-admin paying customer A3 measured
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = fixtures[2].clerkId;
    const warm = await subject.GET();
    check("/api/user/me responds 200", warm.status === 200, `got ${warm.status}`);

    const steady = await record(() => subject.GET());
    const writes = steady.sql.filter(isWrite).length;
    console.log(`        measured: ${steady.sql.length} statements (A3 measured ${A3_USER_ME_STATEMENTS}), ${writes} writes`);
    check(`/api/user/me steady state issues ${USER_ME_STATEMENT_BUDGET} statements (${A3_USER_ME_STATEMENTS} − ${B3_DUPLICATE_READS_REMOVED})`,
      steady.sql.length === USER_ME_STATEMENT_BUDGET,
      `got ${steady.sql.length}`);
    check("/api/user/me steady state issues only SELECTs", steady.sql.every(isSelect), `writes=${writes}`);
    check("/api/user/me steady state issues 0 writes", writes === 0, `got ${writes}`);

    // The response must not widen: `authUser` carries all 63 columns, including
    // every provider API key. Only the 16 fields the route selected may ship.
    const body = await (await subject.GET()).json() as Record<string, unknown>;
    const leaked = ["geminiKey", "heygenKey", "elevenlabsKey", "pexelsKey", "pixabayKey",
      "openaiKey", "kieKey", "password", "resetToken", "clerkId", "stripeCustomerId",
      "stripeSubscriptionId", "heygenAvatarsCache"].filter((key) => key in body);
    check("/api/user/me leaks no server-only User columns", leaked.length === 0,
      `leaked: ${leaked.join(", ")}`);
    check("/api/user/me still reports the subscription as a boolean only",
      body.hasStripeSubscription === true, `got ${String(body.hasStripeSubscription)}`);
    for (const field of ["id", "name", "email", "role", "plan", "usageCount", "usageLimit",
      "usagePeriodStartedAt", "avatar", "cancelAtPeriodEnd", "cancelAt", "trialStartedAt",
      "trialEndsAt", "subStatus", "billingPeriod", "planExpiresAt"]) {
      check(`/api/user/me still returns \`${field}\``, field in body);
    }
  }

  await prisma.$disconnect();
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nverify-auth-query-budget: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
