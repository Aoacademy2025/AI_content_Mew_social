// Static release-contract checks for the Hero Script launch surface.
// These catch accidental removal of API gates, payment confirmation, onboarding,
// documentation, or the post-deploy announcement from the release branch.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let passed = 0;
let failed = 0;

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function check(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`ok: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

const gatedRoutes = [
  "src/app/api/brand-profiles/[id]/route.ts",
  "src/app/api/brand-profiles/analyze/route.ts",
  "src/app/api/brand-profiles/niche-ideas/route.ts",
  "src/app/api/brand-profiles/route.ts",
  "src/app/api/scripts/[id]/route.ts",
  "src/app/api/scripts/[id]/send-to-editor/route.ts",
  "src/app/api/scripts/generate/route.ts",
  "src/app/api/scripts/hooks/route.ts",
  "src/app/api/scripts/ideas/route.ts",
  "src/app/api/scripts/regen-section/route.ts",
  "src/app/api/scripts/route.ts",
];

for (const path of gatedRoutes) {
  check(source(path).includes("requireHeroScriptUser"), `${path} keeps the server-side rollout gate`);
}

const checkout = source("src/app/api/payments/checkout/route.ts");
check(checkout.includes("session_id={CHECKOUT_SESSION_ID}"),
  "Stripe return URL carries the exact checkout session for confirmation");

const confirmationRoute = source("src/app/api/payments/confirmation/route.ts");
check(confirmationRoute.includes("getCurrentUser") && confirmationRoute.includes("findPlanPaymentConfirmation"),
  "payment confirmation is authenticated and delegated to the ownership-scoped resolver");

const confirmation = source("src/lib/payment-confirmation.ts");
check(confirmation.includes("userId,") && confirmation.includes("periodDays: { gt: 0 }") && confirmation.includes('payment.status === "PAID"'),
  "confirmation requires the caller's PAID plan purchase and excludes credit packs");

const settings = source("src/app/(dashboard)/settings/page.tsx");
check(settings.includes("/api/payments/confirmation?session_id=") && settings.includes('result.status === "PAID"'),
  "payment result UI waits for server confirmation before showing success");
check(!settings.includes("สิทธิ์ทั้งหมดพร้อมใช้งานทันที"),
  "payment UI no longer makes an unconditional instant-access claim");
check(settings.includes("การยืนยันใช้เวลานานกว่าปกติ") && settings.includes("ตรวจสอบอีกครั้ง"),
  "delayed webhook state has honest copy and a retry path");

const activation = source("src/lib/checkout-plan-activation.ts");
check(activation.includes("prisma.$transaction") && activation.includes("tx.payment.upsert") && activation.includes('status: "PAID"'),
  "plan entitlement and PAID evidence commit atomically");

const webhook = source("src/app/api/payments/webhook/route.ts");
check(webhook.includes("activatePaidCheckout") && webhook.includes('s.payment_status !== "paid"'),
  "webhook rejects unpaid sessions and uses the atomic activation path");

const rollout = source("src/lib/hero-script-rollout.server.ts");
check(rollout.includes("periodDays: { gt: 0 }") && rollout.includes('status: "PAID"'),
  "paid rollout access requires a real plan payment, not a credit purchase");

const page = source("src/app/(dashboard)/hero-script/page.tsx");
const quickStart = source("src/app/(dashboard)/hero-script/_components/HeroScriptQuickStart.tsx");
check(page.includes("HeroScriptQuickStart") && quickStart.includes("5 ขั้นตอน") && quickStart.includes("/docs/hero-script"),
  "Hero Script embeds a five-step quick start and links the full guide");

const docsRegistry = source("src/app/(docs)/docs/_content/registry.ts");
const docs = source("src/app/(docs)/docs/_content/hero-script.tsx");
check(docsRegistry.includes('import * as heroScript from "./hero-script"') && docsRegistry.includes("heroScript,"),
  "the full Hero Script guide is registered in the help center");
check(docs.includes("สิทธิ์ใช้งานและการชำระเงิน") && docs.includes("ภายใน 5 นาที") && docs.includes('href="/hero-script"'),
  "guide covers payment troubleshooting, timing, and the feature entry point");

const announcement = source("scripts/publish-v1.5.0-hero-script.ts");
check(announcement.includes('const VERSION = "v1.5.0"') && announcement.includes('state: "PUBLISHED"')
    && announcement.includes('importance: "BANNER"') && announcement.includes('ctaHref: "/hero-script"'),
  "post-deploy announcement is versioned, prominent, published, and actionable");
check(announcement.includes("AFTER the paid rollout + public preview flags are live") && announcement.includes("ภายใน 5 นาที"),
  "announcement is explicitly post-live and contains the payment support path");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} launch checks passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
