import assert from "node:assert/strict";
import fs from "node:fs";
import { decideHeroScriptAccess } from "../src/lib/hero-script-rollout.server";

const editorFlag = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/useEditorV2Flag.ts",
  "utf8",
);
assert.match(
  editorFlag,
  /NEXT_PUBLIC_EDITOR_V2 !== ["']0["']/,
  "the current editor must be the default when no rollout env is configured",
);
assert.doesNotMatch(
  editorFlag,
  /q === ["']v1["']/,
  "a stale browser override must not send customers back to the retired editor",
);

const noPaidEntitlement = {
  canUsePaidFeatures: false,
  effectivePlan: "FREE" as const,
  source: "none" as const,
  reason: "no_qualifying_evidence" as const,
  expiresAt: null,
  cashBacked: false,
  recurring: false,
};
const trialScriptAccess = decideHeroScriptAccess({
  internal: false,
  paidEquivalent: noPaidEntitlement,
  flags: { paidEnabled: true, publicPreview: false, trialPercent: 0, freePercent: 0 },
});
assert.equal(trialScriptAccess.canUse, false, "a Trial must not receive paid Script generation");
assert.equal(
  trialScriptAccess.canPreview,
  true,
  "a Trial must still see and open the locked AI Script preview",
);

const mobileTabs = fs.readFileSync("src/components/layout/bottom-tabs.tsx", "utf8");
assert.match(mobileTabs, /href:\s*["']\/hero-script["']/, "mobile primary navigation must include AI Script");

const checkoutRoute = fs.readFileSync("src/app/api/payments/checkout/route.ts", "utf8");
assert.match(checkoutRoute, /PAYMENT_NOT_CONFIGURED/, "missing Stripe config must return a stable error code");
assert.match(checkoutRoute, /userAction:\s*["'][^"']*[ก-๙]/, "missing Stripe config must include Thai customer guidance");

const pricingClient = fs.readFileSync("src/app/(dashboard)/pricing/pricing-client.tsx", "utf8");
assert.match(pricingClient, /customerApiErrorMessage\(/, "pricing must not display raw API diagnostics");

console.log("verify-reported-account-entrypoints: PASS");
