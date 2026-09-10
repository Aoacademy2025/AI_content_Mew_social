// HERO-16: a paid PRO account was shown the FREE "upgrade to use Logo Overlay"
// lock because an unresolved plan was indistinguishable from a resolved FREE
// one. This pins the three-state entitlement, the retry contract of the shared
// /api/user/me fetcher, and the two source-level traps that produced the bug.
//
// Run: npx tsx scripts/verify-logo-entitlement.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  logoControlsEnabled,
  resolveLogoEntitlement,
  type LogoEntitlementInput,
} from "../src/lib/logo-entitlement";
import { clearMeCache, fetchMe } from "../src/lib/use-me";

const ROOT = join(import.meta.dirname, "..");

function input(overrides: Partial<LogoEntitlementInput> = {}): LogoEntitlementInput {
  return {
    planResolved: true,
    plan: "FREE",
    brandVisualAllowed: false,
    hasAdmittedVisualPin: false,
    ...overrides,
  };
}

function verifyEntitlementStates(): void {
  // The customer's exact case: a paid plan that the browser has not loaded yet.
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: false, plan: null })),
    "resolving",
    "an unresolved plan must never resolve to a denial",
  );
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: true, plan: "PRO" })),
    "eligible",
    "a resolved PRO plan keeps the feature",
  );
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: true, plan: "BUSINESS" })),
    "eligible",
    "a resolved BUSINESS plan keeps the feature",
  );

  // The gate must not widen: a plan we did see, that does not carry the
  // feature, still locks.
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: true, plan: "FREE" })),
    "locked",
    "a resolved FREE plan still sees the upgrade lock",
  );

  // Affirmative capabilities stand alone; they do not wait on the plan.
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: false, plan: null, brandVisualAllowed: true })),
    "eligible",
    "brandVisualAllowed grants the Brand Mark without a resolved plan",
  );
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: false, plan: null, hasAdmittedVisualPin: true })),
    "eligible",
    "an admitted visual pin grants the Brand Mark without a resolved plan",
  );

  // A plan string is missing from a response: treated as unknown, not as FREE.
  assert.equal(
    resolveLogoEntitlement(input({ planResolved: true, plan: null })),
    "resolving",
    "a response that delivered no plan is unknown, never a denial",
  );

  // "resolving" is not permission. Only an eligible account may touch anything.
  assert.equal(logoControlsEnabled("eligible"), true);
  assert.equal(logoControlsEnabled("resolving"), false, "resolving must not enable the controls");
  assert.equal(logoControlsEnabled("locked"), false);
}

async function verifyFetchMeFailureContract(): Promise<void> {
  const realFetch = globalThis.fetch;
  try {
    clearMeCache();
    // A failed /api/user/me must be reported as "no data", so the caller can
    // tell it apart from a response that says FREE.
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    assert.equal(await fetchMe(), null, "a failed me-request resolves to null, not to a plan");

    clearMeCache();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("nope", { status: 500 })
        : Response.json({ id: "u1", plan: "PRO" });
    }) as typeof fetch;

    assert.equal(await fetchMe(), null, "first attempt fails");
    const retried = await fetchMe(true);
    assert.equal(retried?.plan, "PRO", "a forced retry after a failure reaches the real plan");
    assert.equal(calls, 2, "the retry is a real request, not the failed cache");

    // A failure must not evict a plan already delivered.
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const afterFailure = await fetchMe(true);
    assert.equal(afterFailure?.plan, "PRO", "a later failure keeps the last known plan");
  } finally {
    globalThis.fetch = realFetch;
    clearMeCache();
  }
}

function verifySourceTraps(): void {
  const hook = readFileSync(
    join(ROOT, "src/app/(dashboard)/video-editor/_v2/useV2Project.ts"),
    "utf8",
  );
  // Trap 1: coalescing an unknown plan to FREE is what locked a paying account.
  assert.equal(
    /setPlan\([^)]*"FREE"/.test(hook),
    false,
    "the editor must not default an unresolved plan to FREE",
  );
  assert.ok(
    hook.includes("resolveLogoEntitlement("),
    "the editor must derive logo eligibility from the shared three-state helper",
  );
  assert.ok(
    hook.includes("ME_RETRY_DELAYS_MS"),
    "a failed me-request must be retried rather than left unresolved for the tab's life",
  );

  const panel = readFileSync(
    join(ROOT, "src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx"),
    "utf8",
  );
  // Trap 2: rendering the upsell from a bare boolean reintroduces the bug.
  assert.equal(
    /\{!eligible && <LockedNotice/.test(panel),
    false,
    "the upgrade notice must not be rendered from the eligibility boolean alone",
  );
  assert.ok(
    panel.includes('entitlement === "locked" && <LockedNotice'),
    "only a resolved, unentitled plan may show the upgrade notice",
  );
  assert.ok(
    panel.includes('entitlement === "resolving" && <ResolvingNotice'),
    "an unresolved plan must show the checking notice instead",
  );
}

async function main(): Promise<void> {
  verifyEntitlementStates();
  await verifyFetchMeFailureContract();
  verifySourceTraps();
  console.log("verify-logo-entitlement: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
