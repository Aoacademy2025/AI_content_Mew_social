"use client";

import Link from "next/link";
import { ArrowRight, Ticket } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import {
  GRANT_BANNER_LINK,
  grantBannerCopy,
  type GrantPaidPlan,
} from "@/lib/grant-expiry-reminders";

const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";

export type GrantExpiryBannerData = {
  plan: GrantPaidPlan;
  expiresAt: string;
  daysLeft: number;
  canConvertCardImmediately?: boolean;
};

export function GrantExpiryBanner({
  grant,
  surface,
}: {
  grant: GrantExpiryBannerData | null | undefined;
  surface: "dashboard" | "pricing";
}) {
  if (!grant || grant.daysLeft <= 0) return null;

  const urgent = grant.daysLeft <= 3;
  const copy = grantBannerCopy(grant.plan, grant.daysLeft);
  const href = surface === "pricing"
    ? `${GRANT_BANNER_LINK}#plan-${grant.plan.toLowerCase()}`
    : GRANT_BANNER_LINK;

  return (
    <div
      data-testid={`grant-expiry-banner-${surface}`}
      className="ve-rise mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3.5"
      style={
        urgent
          ? {
              background: "rgba(251,191,36,.08)",
              border: "1px solid rgba(251,191,36,.32)",
            }
          : {
              background: "rgba(139,92,246,.08)",
              border: "1px solid rgba(139,92,246,.30)",
            }
      }
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] sm:mt-0"
          style={
            urgent
              ? { background: "rgba(251,191,36,.16)", border: "1px solid rgba(251,191,36,.35)" }
              : { background: VIOLET_GRAD }
          }
        >
          <Ticket
            className="h-4 w-4"
            style={{ color: urgent ? "#FBBF24" : "#fff" }}
            strokeWidth={2.3}
            aria-hidden
          />
        </div>
        <p
          className="min-w-0 flex-1 text-[13px] font-medium leading-relaxed"
          style={{ color: "var(--ui-text-primary)" }}
        >
          {copy}
        </p>
      </div>

      <Link
        href={href}
        onClick={() => {
          trackEvent("grant_expiry_banner_clicked", {
            properties: {
              surface,
              plan: grant.plan,
              daysLeft: grant.daysLeft,
            },
          });
        }}
        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-all hover:brightness-110"
        style={{ background: VIOLET_GRAD }}
      >
        ต่อสิทธิ์ต่อเนื่อง
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
      </Link>
    </div>
  );
}
