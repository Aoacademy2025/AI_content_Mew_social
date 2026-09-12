// Task B3 — the authentication hot path may reuse the `User` row it already
// loaded, and it may not change a single outcome while doing so.
//
// What this proves, against a throwaway SQLite DB and the REAL route handler:
//   (a) golden equality — for eleven cases, the `User` row and the return values
//       are byte-identical to the ones the code at GOLDEN_BASE_COMMIT produced.
//       The goldens are LITERALS recorded from that commit (see below), not a
//       second run of today's code, so the shared path — the extracted `select`
//       constants and the B6 write skip — is compared against real base output.
//   (b) no duplicate read — one `getCurrentUser()` reads the `User` row once;
//   (c) steady state writes nothing — a second consecutive call issues 0 writes
//       for every fixture, INCLUDING the paid-no-Payment-evidence cohort whose
//       0-row `UPDATE User` A3 §A3.1 measured on every request (B6 row 3) —
//       while a genuine change still writes on the first call;
//   (d) statement budget — `/api/user/me` in steady state issues exactly
//       A3's measured count minus the duplicate reads §A3.2 proves, and 0 writes.
//
// Plus the two invariants `clerk-auth.ts` depends on:
//   (e) `syncUserEntitlement().rowRewritten` is true EXACTLY when the call wrote
//       the `User` row — measured against the SQL, not asserted per fixture;
//   (f) a Bundle activation that lands during the request is reflected in that
//       same `/api/user/me` response (review F1).
//
// Clerk is the only thing stubbed (`auth()` returns a clerkId; `currentUser()`
// is never reached on the fast path). Prisma, the entitlement libraries and the
// route handler are the real modules, bundled from source so that the harness
// and the app share one module instance and one PrismaClient.
//
// Run:        tsx scripts/verify-auth-query-budget.ts
// Re-record:  B3_REGENERATE_GOLDEN=1 tsx scripts/verify-auth-query-budget.ts
//             (checks the three entitlement libraries out of GOLDEN_BASE_COMMIT
//             into a temp directory, runs the same cases through them, and
//             prints a ready-to-paste GOLDEN block.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** The commit whose behaviour the GOLDEN literals below were recorded from. */
const GOLDEN_BASE_COMMIT = "75464f28";
/** The files that are checked out of that commit when re-recording. */
const GOLDEN_BASE_FILES = [
  "src/lib/entitlements.ts",
  "src/lib/bundle-entitlement.ts",
  "src/lib/paid-equivalent-entitlement.server.ts",
] as const;

// Fixed instants, so the recorded goldens are reproducible. `T_FUTURE`/`T_PAST`
// must straddle the real clock too, because (b)–(f) run through
// `getCurrentUser()`, which uses `new Date()`.
const FIXED_NOW = new Date("2026-09-12T03:00:00.000Z");
const T_FUTURE = new Date("2030-01-01T00:00:00.000Z");
const T_PAST = new Date("2024-01-01T00:00:00.000Z");
const T_TRIAL_STARTED = new Date("2026-09-05T00:00:00.000Z");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ── Harness ────────────────────────────────────────────────────────────────
const regenerate = process.env.B3_REGENERATE_GOLDEN === "1";
const dir = mkdtempSync(join(tmpdir(), "auth-query-budget-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.NODE_ENV = "test";
// Deterministic flag state: every branch below is the flag-off (default) one,
// except where a case sets PRESERVE_TRIAL_ON_CONVERT for itself.
process.env.CREDITS_LIVE = "0";
process.env.MINUTE_QUOTA = "0";
delete process.env.PRESERVE_TRIAL_ON_CONVERT;
delete process.env.MCP_SERVICE_SECRET;
delete process.env.HERO_VOICE_CANARY_EXECUTION_MODE;

type SyncResult = {
  user: unknown;
  decision: unknown;
  changed: boolean;
  /** Added by B3: true when this call wrote the `User` row, by any step. */
  rowRewritten?: boolean;
} | null;

type Subject = {
  GET: () => Promise<Response>;
  getCurrentUser: () => Promise<User | null>;
  syncUserEntitlement: (userId: string, now?: Date, preloaded?: User) => Promise<SyncResult>;
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
 *
 * With `baseDir`, the three entitlement libraries resolve to copies checked out
 * of GOLDEN_BASE_COMMIT instead — that is how the goldens below were recorded.
 */
async function loadSubject(tag: string, baseDir?: string): Promise<Subject> {
  const cacheDir = resolve("node_modules/.cache/verify-auth-query-budget");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, `subject-${tag}.cjs`);
  const baseNames = new Map(GOLDEN_BASE_FILES.map((file) => [
    `@/${file.replace(/^src\//, "").replace(/\.ts$/, "")}`,
    join(baseDir ?? "", file.replace(/^src\/lib\//, "")),
  ]));
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
          if (baseDir && baseNames.has(specifier)) return { path: baseNames.get(specifier)! };
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

/** Check the three entitlement libraries out of the base commit into a temp dir. */
function materializeBaseModules(): string {
  const baseDir = join(dir, "base");
  mkdirSync(baseDir, { recursive: true });
  for (const file of GOLDEN_BASE_FILES) {
    const source = execFileSync("git", ["show", `${GOLDEN_BASE_COMMIT}:${file}`], { encoding: "utf8" });
    writeFileSync(join(baseDir, file.replace(/^src\/lib\//, "")), source);
  }
  return baseDir;
}

// ── Golden literals, recorded from GOLDEN_BASE_COMMIT ───────────────────────
// Each entry holds `JSON.stringify` of, in order: the `User` row after
// `syncUserEntitlement(id, FIXED_NOW)` (minus `createdAt`/`updatedAt`, which are
// stamps of the run itself), that call's return value (minus `rowRewritten`,
// which did not exist at the base commit), then the return values of
// `syncStoredBundleEntitlementForUser(id, FIXED_NOW)` and
// `resolvePaidEquivalentEntitlement(id, FIXED_NOW)` run after it.
// Re-record with: B3_REGENERATE_GOLDEN=1 tsx scripts/verify-auth-query-budget.ts
type Golden = { row: string; sync: string; bundle: string; paid: string };
const GOLDEN: Record<string, Golden> = {
  "b3-free": {
    "row": "{\"id\":\"b3-free\",\"clerkId\":\"clerk_b3-free\",\"name\":\"b3-free\",\"email\":\"b3-free@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":0,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-free\",\"email\":\"b3-free@example.test\",\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"FREE\",\"source\":\"FREE\",\"action\":\"KEEP\",\"reason\":\"free_plan\",\"expiresAt\":null},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-trial": {
    "row": "{\"id\":\"b3-trial\",\"clerkId\":\"clerk_b3-trial\",\"name\":\"b3-trial\",\"email\":\"b3-trial@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":\"2026-09-05T00:00:00.000Z\",\"trialEndsAt\":\"2030-01-01T00:00:00.000Z\",\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":0,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-trial\",\"email\":\"b3-trial@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"trialStartedAt\":\"2026-09-05T00:00:00.000Z\",\"trialEndsAt\":\"2030-01-01T00:00:00.000Z\",\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"TRIAL\",\"action\":\"KEEP\",\"reason\":\"active_trial\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-stripe": {
    "row": "{\"id\":\"b3-stripe\",\"clerkId\":\"clerk_b3-stripe\",\"name\":\"b3-stripe\",\"email\":\"b3-stripe@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":\"sub_b3_stripe\",\"subStatus\":\"active\",\"billingPeriod\":\"monthly\",\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":0,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-stripe\",\"email\":\"b3-stripe@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":\"active\",\"stripeSubscriptionId\":\"sub_b3_stripe\",\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"SUBSCRIPTION\",\"action\":\"KEEP\",\"reason\":\"paid_equivalent:subscription\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":true,\"effectivePlan\":\"PRO\",\"source\":\"subscription\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"cashBacked\":true,\"recurring\":true,\"reason\":\"eligible\"}"
  },
  "b3-bundle-active": {
    "row": "{\"id\":\"b3-bundle-active\",\"clerkId\":\"clerk_b3-bundle-active\",\"name\":\"b3-bundle-active\",\"email\":\"b3-bundle-active@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":100,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":\"grant-active\",\"bundleSubscriptionId\":\"sub_grant-active\",\"bundleAccessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundleBillingPeriod\":\"monthly\",\"bundleAmountThb\":1990,\"bundleLastEventId\":\"evt-active-1\",\"bundleQuotaGrantId\":\"grant-active\",\"bundleCreditsGrantId\":null,\"bundlePrimary\":true,\"minutesUsed\":0,\"minutesLimit\":80,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-bundle-active\",\"email\":\"b3-bundle-active@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":100,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundlePrimary\":true},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"BUNDLE\",\"action\":\"KEEP\",\"reason\":\"paid_equivalent:bundle\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":true}",
    "paid": "{\"canUsePaidFeatures\":true,\"effectivePlan\":\"PRO\",\"source\":\"bundle\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"cashBacked\":true,\"recurring\":true,\"reason\":\"eligible\"}"
  },
  "b3-bundle-expired": {
    "row": "{\"id\":\"b3-bundle-expired\",\"clerkId\":\"clerk_b3-bundle-expired\",\"name\":\"b3-bundle-expired\",\"email\":\"b3-bundle-expired@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":\"grant-expired\",\"bundleSubscriptionId\":\"sub_grant-expired\",\"bundleAccessExpiresAt\":\"2024-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundleBillingPeriod\":\"monthly\",\"bundleAmountThb\":1990,\"bundleLastEventId\":\"evt-expired-1\",\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":5,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-bundle-expired\",\"email\":\"b3-bundle-expired@example.test\",\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":\"2024-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"FREE\",\"source\":\"EXPIRED_BUNDLE\",\"action\":\"DOWNGRADE\",\"reason\":\"bundle_expired\",\"expiresAt\":\"2024-01-01T00:00:00.000Z\"},\"changed\":true}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-no-evidence": {
    "row": "{\"id\":\"b3-no-evidence\",\"clerkId\":\"clerk_b3-no-evidence\",\"name\":\"b3-no-evidence\",\"email\":\"b3-no-evidence@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":\"sub_b3_no_evidence\",\"subStatus\":\"active\",\"billingPeriod\":\"monthly\",\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":0,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-no-evidence\",\"email\":\"b3-no-evidence@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"planExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":\"active\",\"stripeSubscriptionId\":\"sub_b3_no_evidence\",\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"SUBSCRIPTION\",\"action\":\"KEEP\",\"reason\":\"active_subscription\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-bundle-first-request": {
    "row": "{\"id\":\"b3-bundle-first-request\",\"clerkId\":\"clerk_b3-bundle-first-request\",\"name\":\"b3-bundle-first-request\",\"email\":\"b3-bundle-first-request@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":100,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":\"grant-first\",\"bundleSubscriptionId\":\"sub_grant-first\",\"bundleAccessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundleBillingPeriod\":\"monthly\",\"bundleAmountThb\":1990,\"bundleLastEventId\":\"evt-first-1\",\"bundleQuotaGrantId\":\"grant-first\",\"bundleCreditsGrantId\":null,\"bundlePrimary\":true,\"minutesUsed\":0,\"minutesLimit\":80,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-bundle-first-request\",\"email\":\"b3-bundle-first-request@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":100,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"bundleStatus\":\"ACTIVE\",\"bundlePrimary\":true},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"BUNDLE\",\"action\":\"KEEP\",\"reason\":\"paid_equivalent:bundle\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":true}",
    "paid": "{\"canUsePaidFeatures\":true,\"effectivePlan\":\"PRO\",\"source\":\"bundle\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"cashBacked\":true,\"recurring\":true,\"reason\":\"eligible\"}"
  },
  "b3-trial-expired": {
    "row": "{\"id\":\"b3-trial-expired\",\"clerkId\":\"clerk_b3-trial-expired\",\"name\":\"b3-trial-expired\",\"email\":\"b3-trial-expired@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":\"2024-01-01T00:00:00.000Z\",\"trialEndsAt\":null,\"trialEndedAt\":\"2024-01-01T00:00:00.000Z\",\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":5,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-trial-expired\",\"email\":\"b3-trial-expired@example.test\",\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":\"2024-01-01T00:00:00.000Z\",\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"FREE\",\"source\":\"EXPIRED_TRIAL\",\"action\":\"DOWNGRADE\",\"reason\":\"trial_expired\",\"expiresAt\":\"2024-01-01T00:00:00.000Z\"},\"changed\":true}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-term-expired": {
    "row": "{\"id\":\"b3-term-expired\",\"clerkId\":\"clerk_b3-term-expired\",\"name\":\"b3-term-expired\",\"email\":\"b3-term-expired@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":5,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-term-expired\",\"email\":\"b3-term-expired@example.test\",\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"FREE\",\"source\":\"EXPIRED_PLAN\",\"action\":\"DOWNGRADE\",\"reason\":\"plan_expired\",\"expiresAt\":\"2024-01-01T00:00:00.000Z\"},\"changed\":true}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-label-only": {
    "row": "{\"id\":\"b3-label-only\",\"clerkId\":\"clerk_b3-label-only\",\"name\":\"b3-label-only\",\"email\":\"b3-label-only@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":null,\"subStatus\":null,\"billingPeriod\":null,\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":5,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-label-only\",\"email\":\"b3-label-only@example.test\",\"role\":\"USER\",\"plan\":\"FREE\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":\"2026-09-12T03:00:00.000Z\",\"planExpiresAt\":null,\"trialStartedAt\":null,\"trialEndsAt\":null,\"subStatus\":null,\"stripeSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"BUSINESS\",\"source\":\"PERMANENT_OR_MANUAL\",\"action\":\"REVIEW\",\"reason\":\"paid_plan_without_expiry_or_active_subscription\",\"expiresAt\":null},\"changed\":true}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  },
  "b3-trialing-sub": {
    "row": "{\"id\":\"b3-trialing-sub\",\"clerkId\":\"clerk_b3-trialing-sub\",\"name\":\"b3-trialing-sub\",\"email\":\"b3-trialing-sub@example.test\",\"password\":null,\"googleId\":null,\"image\":null,\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"openaiKey\":null,\"geminiKey\":null,\"heygenKey\":null,\"elevenlabsKey\":null,\"pexelsKey\":null,\"pixabayKey\":null,\"kieKey\":null,\"unsplashKey\":null,\"flickrKey\":null,\"avatar\":null,\"heygenAvatarId\":null,\"heygenAvatarsCache\":null,\"heygenAvatarsCachedAt\":null,\"elevenlabsVoiceId\":null,\"ttsProvider\":\"gemini\",\"geminiVoiceName\":\"Aoede\",\"suspended\":false,\"planExpiresAt\":null,\"onboardingDismissedAt\":null,\"firstClipConvertDismissedAt\":null,\"stripeCustomerId\":null,\"stripeSubscriptionId\":\"sub_b3_trialing\",\"subStatus\":\"trialing\",\"billingPeriod\":\"monthly\",\"cancelAtPeriodEnd\":false,\"cancelAt\":null,\"trialStartedAt\":\"2024-01-01T00:00:00.000Z\",\"trialEndsAt\":\"2024-01-01T00:00:00.000Z\",\"trialEndedAt\":null,\"bundleGrantId\":null,\"bundleSubscriptionId\":null,\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundleBillingPeriod\":null,\"bundleAmountThb\":null,\"bundleLastEventId\":null,\"bundleQuotaGrantId\":null,\"bundleCreditsGrantId\":null,\"bundlePrimary\":false,\"minutesUsed\":0,\"minutesLimit\":0,\"aiAudioMinutesUsed\":0,\"aiTextCallsUsed\":0,\"geminiKeyMode\":\"byok\",\"affiliateRefCode\":null,\"resetToken\":null,\"resetExpires\":null}",
    "sync": "{\"user\":{\"id\":\"b3-trialing-sub\",\"email\":\"b3-trialing-sub@example.test\",\"role\":\"USER\",\"plan\":\"PRO\",\"usageCount\":0,\"usageLimit\":2,\"usagePeriodStartedAt\":null,\"planExpiresAt\":null,\"trialStartedAt\":\"2024-01-01T00:00:00.000Z\",\"trialEndsAt\":\"2024-01-01T00:00:00.000Z\",\"subStatus\":\"trialing\",\"stripeSubscriptionId\":\"sub_b3_trialing\",\"bundleAccessExpiresAt\":null,\"bundleStatus\":null,\"bundlePrimary\":false},\"decision\":{\"effectivePlan\":\"PRO\",\"source\":\"SUBSCRIPTION\",\"action\":\"KEEP\",\"reason\":\"stripe_trialing_subscription\",\"expiresAt\":null},\"changed\":false}",
    "bundle": "{\"changed\":false,\"activated\":false}",
    "paid": "{\"canUsePaidFeatures\":false,\"effectivePlan\":\"FREE\",\"source\":\"none\",\"expiresAt\":null,\"cashBacked\":false,\"recurring\":false,\"reason\":\"no_qualifying_evidence\"}"
  }
};

async function main() {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "inherit", env: process.env });

  const realNow = new Date();
  if (!(realNow > T_PAST && realNow < T_FUTURE)) {
    console.error(`This script's fixed fixture dates no longer straddle the clock (${realNow.toISOString()}).`
      + " Move T_FUTURE/T_PAST and re-record the goldens.");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
    datasourceUrl: process.env.DATABASE_URL,
  });
  // Installed before any subject is loaded: src/lib/prisma.ts reuses it.
  (globalThis as unknown as { prisma: unknown }).prisma = prisma;

  const FENCE = "SELECT 1 AS b3_fence";
  let captured: string[] | null = null;
  (prisma as unknown as { $on: (e: string, cb: (x: { query: string }) => void) => void })
    .$on("query", (event) => { if (captured) captured.push(event.query); });

  /**
   * Run `fn` and return every SQL statement Prisma issued while it ran. The sink
   * is closed on a fence query rather than on a wall-clock timeout: query events
   * are emitted in order, so once the fence appears, every statement before it
   * has been recorded.
   */
  async function record<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const sink: string[] = [];
    captured = sink;
    try {
      const result = await fn();
      await prisma.$queryRawUnsafe(FENCE);
      for (let i = 0; i < 200 && !sink.some((s) => s.includes("b3_fence")); i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return { result, sql: sink.filter((s) => !s.includes("b3_fence")) };
    } finally {
      captured = null;
    }
  }

  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
  const isSelect = (sql: string) => /^\s*SELECT\b/i.test(sql);
  const isUserRead = (sql: string) => isSelect(sql) && /FROM\s+`main`\.`User`/i.test(sql);
  const isUserWrite = (sql: string) => /^\s*UPDATE\s+`main`\.`User`/i.test(sql);

  // ── Cases ────────────────────────────────────────────────────────────────
  // Every case rebuilds itself from scratch so that the base recording and each
  // head run start from byte-identical state.
  type Case = {
    id: string;
    clerkId: string;
    label: string;
    create: () => Promise<void>;
    /** Env this case needs while the entitlement functions run. */
    env?: Record<string, string | undefined>;
    /** Also exercised through `getCurrentUser()` by (b)/(c). */
    auth?: boolean;
  };

  async function baseUser(id: string, data: Record<string, unknown>) {
    await prisma.user.create({
      data: { id, clerkId: `clerk_${id}`, name: id, email: `${id}@example.test`, ...data } as never,
    });
  }
  async function bundleRow(email: string, grantId: string, eventId: string, accessEndsAt: Date) {
    await prisma.bundleEntitlement.create({
      data: {
        email, grantId, subscriptionId: `sub_${grantId}`, status: "ACTIVE", accessEndsAt,
        billingPeriod: "monthly", amountThb: 1990, lastEventId: eventId, eventOccurredAt: T_PAST,
      },
    });
  }

  const cases: Case[] = [
    {
      id: "b3-free", clerkId: "clerk_b3-free", label: "FREE", auth: true,
      create: async () => { await baseUser("b3-free", { plan: "FREE" }); },
    },
    {
      id: "b3-trial", clerkId: "clerk_b3-trial", label: "PRO trial", auth: true,
      create: async () => {
        await baseUser("b3-trial", {
          plan: "PRO", trialStartedAt: T_TRIAL_STARTED, trialEndsAt: T_FUTURE, planExpiresAt: T_FUTURE,
        });
      },
    },
    {
      id: "b3-stripe", clerkId: "clerk_b3-stripe", label: "PRO Stripe subscription", auth: true,
      create: async () => {
        await baseUser("b3-stripe", {
          plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_b3_stripe",
          billingPeriod: "monthly", planExpiresAt: T_FUTURE,
        });
        await prisma.payment.create({
          data: {
            userId: "b3-stripe", stripeSessionId: "cs_b3_stripe", plan: "PRO", amount: 59900,
            currency: "thb", status: "PAID", periodDays: 30, paidAt: T_PAST,
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
      auth: true,
      create: async () => {
        await baseUser("b3-bundle-active", { plan: "FREE" });
        await bundleRow("b3-bundle-active@example.test", "grant-active", "evt-active-1", T_FUTURE);
      },
    },
    {
      id: "b3-bundle-expired", clerkId: "clerk_b3-bundle-expired", label: "bundle expired", auth: true,
      create: async () => {
        await baseUser("b3-bundle-expired", {
          plan: "PRO", bundlePrimary: true, bundleGrantId: "grant-expired",
          bundleStatus: "ACTIVE", bundleAccessExpiresAt: T_PAST, bundleAmountThb: 1990,
          bundleLastEventId: "evt-expired-0",
        });
        await bundleRow("b3-bundle-expired@example.test", "grant-expired", "evt-expired-1", T_PAST);
      },
    },
    {
      // The 107-account cohort of A3 §A3.1: a paid plan with a live subscription
      // and NO qualifying Payment row. Its downgrade guard matches 0 rows, so the
      // `UPDATE User` is pure write-lock cost on every authenticated request.
      id: "b3-no-evidence", clerkId: "clerk_b3-no-evidence",
      label: "PRO active sub, no Payment evidence", auth: true,
      create: async () => {
        await baseUser("b3-no-evidence", {
          plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_b3_no_evidence",
          billingPeriod: "monthly", planExpiresAt: T_FUTURE,
        });
      },
    },
    {
      // Review F1: the Bundle activation lands DURING the request. The stored row
      // still says FREE when `getCurrentUser()` reads it; the sync inside that
      // call rewrites it to PRO. Same shape as `b3-bundle-active`, kept separate
      // so (f) can run the route handler against a pristine row.
      id: "b3-bundle-first-request", clerkId: "clerk_b3-bundle-first-request",
      label: "bundle activation during the request (F1)", auth: true,
      create: async () => {
        await baseUser("b3-bundle-first-request", { plan: "FREE" });
        await bundleRow("b3-bundle-first-request@example.test", "grant-first", "evt-first-1", T_FUTURE);
      },
    },
    {
      id: "b3-trial-expired", clerkId: "clerk_b3-trial-expired", label: "expired trial",
      create: async () => {
        await baseUser("b3-trial-expired", {
          plan: "PRO", trialStartedAt: T_PAST, trialEndsAt: T_PAST, minutesUsed: 3,
        });
      },
    },
    {
      id: "b3-term-expired", clerkId: "clerk_b3-term-expired", label: "expired paid term",
      create: async () => { await baseUser("b3-term-expired", { plan: "PRO", planExpiresAt: T_PAST }); },
    },
    {
      id: "b3-label-only", clerkId: "clerk_b3-label-only",
      label: "paid label, no expiry, no evidence (REVIEW)",
      create: async () => { await baseUser("b3-label-only", { plan: "BUSINESS" }); },
    },
    {
      // The one mirror clause the other cases never reach: PRESERVE_TRIAL_ON_CONVERT
      // with a `trialing` Stripe subscription past its trial end.
      id: "b3-trialing-sub", clerkId: "clerk_b3-trialing-sub",
      label: "converted trialing subscription past trial end (preserve-trial ON)",
      env: { PRESERVE_TRIAL_ON_CONVERT: "1" },
      create: async () => {
        await baseUser("b3-trialing-sub", {
          plan: "PRO", subStatus: "trialing", stripeSubscriptionId: "sub_b3_trialing",
          billingPeriod: "monthly", trialStartedAt: T_PAST, trialEndsAt: T_PAST,
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
   * `createdAt`/`updatedAt` are wall-clock stamps of the run itself, not decision
   * state, and `rowRewritten` did not exist at the base commit — everything else
   * is compared byte for byte. Writes are counted directly by (c) and (e), so
   * dropping `updatedAt` cannot hide a stray write.
   */
  function snapshot(value: unknown): string {
    return JSON.stringify(value, (key, inner) =>
      key === "createdAt" || key === "updatedAt" || key === "rowRewritten" ? undefined : inner);
  }

  function withEnv<T>(env: Case["env"], fn: () => Promise<T>): Promise<T> {
    if (!env) return fn();
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn().finally(() => {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });
  }

  /**
   * One case's observable behaviour: the row `syncUserEntitlement` leaves, what
   * it returned, and what the two helpers return when run after it. `preloaded`
   * selects the path under test; at the base commit the argument is ignored.
   */
  async function runCase(subject: Subject, c: Case, usePreloaded: boolean) {
    await resetAll();
    await c.create();
    return withEnv(c.env, async () => {
      const preloaded = usePreloaded
        ? (await prisma.user.findUnique({ where: { id: c.id } }))! : undefined;
      const synced = await record(() => subject.syncUserEntitlement(c.id, FIXED_NOW, preloaded));
      const row = await prisma.user.findUnique({ where: { id: c.id } });
      const bundlePreload = usePreloaded
        ? (await prisma.user.findUnique({ where: { id: c.id } }))! : undefined;
      const bundle = await subject.syncStoredBundleEntitlementForUser(
        c.id, FIXED_NOW, undefined, bundlePreload);
      const paidPreload = usePreloaded
        ? (await prisma.user.findUnique({ where: { id: c.id } }))! : undefined;
      const paid = await subject.resolvePaidEquivalentEntitlement(c.id, FIXED_NOW, paidPreload);
      return {
        golden: {
          row: snapshot(row),
          sync: snapshot(synced.result),
          bundle: JSON.stringify(bundle),
          paid: JSON.stringify(paid),
        } satisfies Golden,
        rowRewritten: synced.result?.rowRewritten,
        changed: synced.result?.changed,
        userWrites: synced.sql.filter(isUserWrite).length,
      };
    });
  }

  // ── Re-record mode ───────────────────────────────────────────────────────
  if (regenerate) {
    const base = await loadSubject("base", materializeBaseModules());
    const recorded: Record<string, Golden> = {};
    for (const c of cases) recorded[c.id] = (await runCase(base, c, false)).golden;
    console.log(`\n// recorded from ${GOLDEN_BASE_COMMIT}\n${JSON.stringify(recorded, null, 2)}\n`);
    await prisma.$disconnect();
    return;
  }

  const subject = await loadSubject("head");

  // ── (a) golden equality against the base commit ──────────────────────────
  console.log(`\n(a) golden: row and return values match the code at ${GOLDEN_BASE_COMMIT}`);
  for (const c of cases) {
    const golden = GOLDEN[c.id];
    if (!golden) {
      check(`${c.label}: has a recorded golden`, false, `no GOLDEN entry for ${c.id}`);
      continue;
    }
    for (const usePreloaded of [false, true]) {
      const how = usePreloaded ? "with preloaded" : "without preloaded";
      const run = await runCase(subject, c, usePreloaded);
      check(`${c.label} (${how}): User row is byte-identical to ${GOLDEN_BASE_COMMIT}`,
        run.golden.row === golden.row,
        `base=${golden.row}\n        head=${run.golden.row}`);
      check(`${c.label} (${how}): syncUserEntitlement returns the same value`,
        run.golden.sync === golden.sync,
        `base=${golden.sync}\n        head=${run.golden.sync}`);
      check(`${c.label} (${how}): syncStoredBundleEntitlementForUser returns the same value`,
        run.golden.bundle === golden.bundle,
        `base=${golden.bundle} head=${run.golden.bundle}`);
      check(`${c.label} (${how}): resolvePaidEquivalentEntitlement returns the same decision`,
        run.golden.paid === golden.paid,
        `base=${golden.paid} head=${run.golden.paid}`);
      // (e) — the signal `clerk-auth.ts` re-reads on must mean exactly "this call
      // wrote the User row", or a write goes unnoticed (review F1).
      check(`${c.label} (${how}): rowRewritten === (the call wrote the User row)`,
        run.rowRewritten === (run.userWrites > 0),
        `rowRewritten=${String(run.rowRewritten)} UPDATE User statements=${run.userWrites}`);
    }
  }

  // Evidence that only reaches the decision through a relation load: the
  // preloaded path fetches those relations on their own instead of nesting them
  // under the `User` read, so both shapes must decide identically.
  console.log("\n(a2) golden: coupon-grant and administrator-grant evidence");
  {
    await resetAll();
    await baseUser("b3-coupon", { plan: "PRO", planExpiresAt: T_FUTURE });
    await prisma.coupon.create({
      data: { code: "B3GRANT", type: "GRANT", plan: "PRO", durationDays: 30, maxUses: 10 },
    });
    const coupon = await prisma.coupon.findUnique({ where: { code: "B3GRANT" } });
    await prisma.couponRedemption.create({
      data: {
        userId: "b3-coupon", couponId: coupon!.id, redeemedAt: T_PAST, outcome: "ACTIVATED",
        entitlementPlan: "PRO", entitlementStartsAt: T_PAST, entitlementExpiresAt: T_FUTURE,
      },
    });
    await baseUser("b3-grant", { plan: "BUSINESS" });
    await prisma.administratorGrant.create({
      data: {
        userId: "b3-grant", plan: "BUSINESS", reason: "comped", startsAt: T_PAST,
        expiresAt: T_FUTURE, permanent: false, grantedById: "b3-coupon",
      },
    });
    for (const id of ["b3-coupon", "b3-grant"]) {
      const nested = await subject.resolvePaidEquivalentEntitlement(id, FIXED_NOW);
      const row = (await prisma.user.findUnique({ where: { id } }))!;
      const fresh = await subject.resolvePaidEquivalentEntitlement(id, FIXED_NOW, row);
      check(`${id}: relation-only evidence decides identically`,
        JSON.stringify(nested) === JSON.stringify(fresh),
        `nested=${JSON.stringify(nested)} preloaded=${JSON.stringify(fresh)}`);
    }
  }

  // ── (b) + (c) one auth call: one User read, and a steady state that writes ─
  console.log("\n(b)(c) getCurrentUser(): one User read, and no writes in steady state");
  for (const c of cases.filter((x) => x.auth)) {
    await resetAll();
    await c.create();
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = c.clerkId;

    const first = await record(() => subject.getCurrentUser());
    check(`${c.label}: authenticates`, first.result?.id === c.id, `got ${String(first.result?.id)}`);

    const steady = await record(() => subject.getCurrentUser());
    const userReads = steady.sql.filter(isUserRead).length;
    const writes = steady.sql.filter(isWrite).length;
    check(`${c.label}: steady state reads the User row exactly once (A3: 4–5)`,
      userReads === 1, `got ${userReads}\n        ${steady.sql.join("\n        ")}`);
    check(`${c.label}: steady-state auth prefix is ${AUTH_PREFIX_BUDGET} statements (A3: ${A3_AUTH_PREFIX_STATEMENTS})`,
      steady.sql.length === AUTH_PREFIX_BUDGET,
      `got ${steady.sql.length}\n        ${steady.sql.join("\n        ")}`);
    check(`${c.label}: steady state issues 0 writes`,
      writes === 0, `got ${writes}\n        ${steady.sql.filter(isWrite).join("\n        ")}`);
  }

  // ── (c2) B6 row 3: the skip must not swallow a real downgrade ─────────────
  console.log("\n(c2) a genuine change still writes on the first call");
  {
    const noEvidence = cases.find((c) => c.id === "b3-no-evidence")!;
    await resetAll();
    await noEvidence.create();
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = noEvidence.clerkId;
    await subject.getCurrentUser();
    const quiet = await record(() => subject.getCurrentUser());
    check("no-evidence cohort: steady state writes nothing",
      quiet.sql.filter(isWrite).length === 0, `got ${quiet.sql.filter(isWrite).length}`);

    await prisma.user.update({
      where: { id: "b3-no-evidence" },
      data: { subStatus: null, planExpiresAt: T_PAST },
    });
    const changed = await record(() => subject.getCurrentUser());
    const after = await prisma.user.findUnique({ where: { id: "b3-no-evidence" } });
    check("no-evidence cohort: the first call after a genuine change DOES write",
      changed.sql.filter(isWrite).length > 0 && after?.plan === "FREE",
      `writes=${changed.sql.filter(isWrite).length} plan=${after?.plan}`);
    check("no-evidence cohort: getCurrentUser returns the DOWNGRADED row, not the stale one",
      changed.result?.plan === "FREE", `got ${String(changed.result?.plan)}`);
  }

  // ── (d) /api/user/me statement budget ────────────────────────────────────
  console.log("\n(d) /api/user/me statement budget");
  {
    const paying = cases.find((c) => c.id === "b3-stripe")!;
    await resetAll();
    await paying.create(); // the non-admin paying customer A3 measured
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = paying.clerkId;
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

  // ── (f) review F1: a write that lands during the request must be visible ──
  console.log("\n(f) a Bundle activation during the request is reflected in that response");
  {
    const f1 = cases.find((c) => c.id === "b3-bundle-first-request")!;
    await resetAll();
    await f1.create();
    (globalThis as unknown as { __authQueryBudgetClerkId: string }).__authQueryBudgetClerkId = f1.clerkId;
    const stored = await prisma.user.findUnique({ where: { id: f1.id } });
    check("F1 precondition: the stored row is still FREE when the request starts",
      stored?.plan === "FREE", `got ${stored?.plan}`);

    const body = await (await subject.GET()).json() as Record<string, unknown>;
    const after = await prisma.user.findUnique({ where: { id: f1.id } });
    check("F1: the Bundle activation is persisted by this request", after?.plan === "PRO",
      `got ${after?.plan}`);
    check("F1: /api/user/me reports plan=PRO on that very request", body.plan === "PRO",
      `plan=${String(body.plan)} effectivePlan=${String(body.effectivePlan)}`);
    check("F1: effectivePlan agrees with plan", body.effectivePlan === "PRO",
      `got ${String(body.effectivePlan)}`);
    check("F1: getCurrentUser() returns the rewritten row",
      (await subject.getCurrentUser())?.plan === "PRO");
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
