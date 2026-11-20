"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowRight, Ticket } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import {
  GRANT_BANNER_LINK,
  grantBannerCopy,
  type GrantPaidPlan,
} from "@/lib/grant-expiry-reminders";

const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIEW_KEY_PREFIX = "hero-grant-banner-viewed:";

export type GrantExpiryBannerSurface = "dashboard" | "pricing" | "editor" | "post-export";

export type GrantExpiryBannerData = {
  plan: GrantPaidPlan;
  expiresAt: string;
  daysLeft: number;
  canConvertCardImmediately?: boolean;
};

function safeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const s = window.sessionStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

export function GrantExpiryBanner({
  grant,
  surface,
  compact = false,
}: {
  grant: GrantExpiryBannerData | null | undefined;
  surface: GrantExpiryBannerSurface;
  compact?: boolean;
}) {
  const viewedKeyRef = useRef<string | null>(null);
  const visible = Boolean(grant && grant.daysLeft > 0);
  const plan = grant?.plan;
  const expiresAt = grant?.expiresAt;
  const daysLeft = grant?.daysLeft;

  useEffect(() => {
    if (!visible || !plan || !expiresAt || typeof daysLeft !== "number") return;
    const dedupeKey = `${VIEW_KEY_PREFIX}${surface}:${expiresAt}`;
    if (viewedKeyRef.current === dedupeKey) return;
    viewedKeyRef.current = dedupeKey;
    const storage = safeSessionStorage();
    try {
      if (storage?.getItem(dedupeKey)) return;
      storage?.setItem(dedupeKey, "1");
    } catch {
      // private mode — still emit at most once per mount
    }
    trackEvent("grant_expiry_banner_viewed", {
      properties: {
        surface,
        plan,
        daysLeft,
      },
    });
  }, [visible, surface, plan, expiresAt, daysLeft]);

  if (!grant || grant.daysLeft <= 0) return null;

  const urgent = grant.daysLeft <= 3;
  const copy = grantBannerCopy(grant.plan, grant.daysLeft);
  const href = surface === "pricing"
    ? `${GRANT_BANNER_LINK}#plan-${grant.plan.toLowerCase()}`
    : `${GRANT_BANNER_LINK}&surface=${encodeURIComponent(surface)}`;

  return (
    <div
      data-testid={`grant-expiry-banner-${surface}`}
      className={
        compact
          ? "flex flex-wrap items-center justify-between gap-2.5 rounded-xl px-3.5 py-2.5"
          : "ve-rise mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3.5"
      }
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
      <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
        <div
          className={
            compact
              ? "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg sm:mt-0"
              : "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] sm:mt-0"
          }
          style={
            urgent
              ? { background: "rgba(251,191,36,.16)", border: "1px solid rgba(251,191,36,.35)" }
              : { background: VIOLET_GRAD }
          }
        >
          <Ticket
            className={compact ? "h-3.5 w-3.5" : "h-4 w-4"}
            style={{ color: urgent ? "#FBBF24" : "#fff" }}
            strokeWidth={2.3}
            aria-hidden
          />
        </div>
        <p
          className={
            compact
              ? "min-w-0 flex-1 text-left text-[12px] font-medium leading-snug"
              : "min-w-0 flex-1 text-[13px] font-medium leading-relaxed"
          }
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
        className={
          compact
            ? "inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold text-white transition-all hover:brightness-110"
            : "inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-all hover:brightness-110"
        }
        style={{ background: VIOLET_GRAD }}
      >
        ต่อสิทธิ์ต่อเนื่อง
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
      </Link>
    </div>
  );
}
