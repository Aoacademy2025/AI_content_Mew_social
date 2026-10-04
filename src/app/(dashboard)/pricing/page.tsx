import { auth } from "@clerk/nextjs/server";
import { getPlanConfig } from "@/lib/plan-config";
import { foundingStatus, isFoundingMember } from "@/lib/founding";
import { prisma } from "@/lib/prisma";
import { preserveTrialOnConvertEnabled } from "@/lib/preserve-trial";
import {
  parseCancelReturnParams,
  promptpayMonthlyEnabled,
  promptpayMonthlyOffered,
} from "@/lib/promptpay-monthly";
import { PricingClient } from "./pricing-client";

/**
 * Server-rendered convert page. The h1 and plan prices must be in the first
 * HTML so LCP is the heading, not a blank client-only shell waiting on JS
 * (prod p75 was ~26s when this route suspended with an empty fallback).
 */
/** HERO-61: a confirmed member sees the founding price on an upgrade even when seats are sold out.
 *  Display-only and fail-closed to false (checkout re-decides on its own). */
async function viewerIsFoundingMember(): Promise<boolean> {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) return false;
    const user = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
    return user ? await isFoundingMember(user.id) : false;
  } catch {
    return false;
  }
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{
    payment?: string;
    source?: string;
    period?: string;
    method?: string;
    plan?: string;
  }>;
}) {
  const [plans, founding, foundingMember, params, offeredPro, offeredBusiness] = await Promise.all([
    getPlanConfig(),
    foundingStatus(),
    viewerIsFoundingMember(),
    searchParams,
    promptpayMonthlyOffered("PRO"),
    promptpayMonthlyOffered("BUSINESS"),
  ]);
  // ADR 0066 — the whitelist also doubles as the generic `?method=promptpay` preselect
  // reader (e.g. the past-due banner link); `plan` only matters for the cancel-return
  // banner. Flag off -> promptpayMonthlyOffered() short-circuits before any config/DB read.
  const cancelReturn = parseCancelReturnParams(params);
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10">
        <div className="mx-auto max-w-6xl px-4 pt-6 md:px-6">
          <div className="mb-6 text-center">
            <p
              className="text-[13px] font-semibold uppercase tracking-[.14em]"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "#B9A6FF" }}
            >
              อัปเกรดแผน
            </p>
            <h1
              className="mt-2 text-3xl font-bold sm:text-4xl"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
            >
              เลือกแพ็กที่ใช่
            </h1>
          </div>
        </div>
        <PricingClient
          initialPlans={plans}
          initialFounding={founding}
          foundingMember={foundingMember}
          paymentResult={params.payment ?? null}
          acquisitionSource={params.source ?? null}
          preferredPeriod={cancelReturn.period ?? null}
          minuteQuotaEnabled={process.env.MINUTE_QUOTA === "1"}
          // #348 — the promise on the trial band is only shown when the billing
          // code actually keeps the remaining days. Same helper the server uses.
          preserveTrialOnConvert={preserveTrialOnConvertEnabled()}
          // ADR 0066 — PromptPay monthly 30-day term (Task 2).
          monthlyPromptpayOffered={{ PRO: offeredPro, BUSINESS: offeredBusiness }}
          promptpayMonthlyEnabledFlag={promptpayMonthlyEnabled()}
          cancelReturn={cancelReturn}
        />
      </div>
    </div>
  );
}
