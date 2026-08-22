import { getPlanConfig } from "@/lib/plan-config";
import { foundingStatus } from "@/lib/founding";
import { PricingClient } from "./pricing-client";

/**
 * Server-rendered convert page. The h1 and plan prices must be in the first
 * HTML so LCP is the heading, not a blank client-only shell waiting on JS
 * (prod p75 was ~26s when this route suspended with an empty fallback).
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; source?: string }>;
}) {
  const [plans, founding, params] = await Promise.all([
    getPlanConfig(),
    foundingStatus(),
    searchParams,
  ]);
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
          paymentResult={params.payment ?? null}
          acquisitionSource={params.source ?? null}
        />
      </div>
    </div>
  );
}
