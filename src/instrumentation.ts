import * as Sentry from "@sentry/nextjs";

declare global {
  var __heroAiUnhandledRejectionGuardInstalled: boolean | undefined;
  var __heroAiRemotionTargetClosedRejections: number | undefined;
  var __heroAiRemotionTargetClosedLastLogAt: number | undefined;
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`;
  }
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function reasonSummary(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return reasonText(reason).slice(0, 240);
}

function isRemotionTargetClosedRejection(reason: unknown): boolean {
  const text = reasonText(reason);
  return (
    /ProtocolError/i.test(text) &&
    (
      /Target\.attachToTarget/i.test(text) ||
      /Target closed/i.test(text) ||
      /remotion\.dev\/docs\/target-closed/i.test(text)
    )
  );
}

function installUnhandledRejectionGuard() {
  if (global.__heroAiUnhandledRejectionGuardInstalled) return;
  global.__heroAiUnhandledRejectionGuardInstalled = true;

  process.on("unhandledRejection", (reason) => {
    if (isRemotionTargetClosedRejection(reason)) {
      global.__heroAiRemotionTargetClosedRejections =
        (global.__heroAiRemotionTargetClosedRejections ?? 0) + 1;
      const now = Date.now();
      const lastLogAt = global.__heroAiRemotionTargetClosedLastLogAt ?? 0;
      if (now - lastLogAt > 10 * 60 * 1000) {
        global.__heroAiRemotionTargetClosedLastLogAt = now;
        console.warn(
          `[instrumentation] suppressed Remotion target-closed unhandledRejection ` +
          `(count=${global.__heroAiRemotionTargetClosedRejections}): ${reasonSummary(reason)}`
        );
      }
      return;
    }

    console.error("[instrumentation] unhandledRejection:", reason);
  });
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    installUnhandledRejectionGuard();

    // The marked local canary must finish every durable deletion intent before
    // auth bootstrap, generation, review, or another delete can mutate state.
    // Failure is intentionally sticky for this process: reads remain possible,
    // while every canary mutation boundary fails closed.
    const { initializeHeroVoiceDeletionCoordinator } = await import(
      "@/lib/hero-voice-deletion-coordinator.server"
    );
    const deletionStartup = await initializeHeroVoiceDeletionCoordinator();
    if (deletionStartup.mode === "read_only") {
      console.error("[instrumentation] Hero Voice canary is read-only: deletion recovery incomplete");
    }

    const { prisma } = await import("@/lib/prisma");
    const { resetStripeClient } = await import("@/lib/stripe");

    const keys = [
      { db: "stripe_secret_key", env: "STRIPE_SECRET_KEY" },
      { db: "stripe_webhook_secret", env: "STRIPE_WEBHOOK_SECRET" },
      { db: "stripe_price_pro", env: "STRIPE_PRICE_PRO_MONTHLY" },
      { db: "stripe_price_business", env: "STRIPE_PRICE_BUSINESS_MONTHLY" },
    ];

    try {
      const rows = await prisma.siteConfig.findMany({
        where: { key: { in: keys.map(k => k.db) } },
        select: { key: true, value: true },
      });

      let changed = false;
      for (const { db, env } of keys) {
        const row = rows.find(r => r.key === db);
        if (row?.value && !process.env[env]) {
          process.env[env] = row.value;
          changed = true;
        }
      }

      if (changed) {
        resetStripeClient();
        console.log("[instrumentation] Loaded Stripe config from DB");
      }
    } catch (e) {
      console.error("[instrumentation] Failed to load Stripe config from DB:", e);
    }

    // Managed Gemini: hydrate the platform key set via /admin into the env the SYNC
    // resolver reads (GEMINI_SERVER_KEY) — so the key is UI-managed (no SSH / no
    // secret in chat) and the same key also powers the loanword cron.
    try {
      const { hydrateServerGeminiKeyEnv } = await import("@/lib/server-keys");
      if (await hydrateServerGeminiKeyEnv()) console.log("[instrumentation] Loaded server Gemini key from DB");
    } catch (e) {
      console.error("[instrumentation] Failed to load server Gemini key from DB:", e);
    }
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
