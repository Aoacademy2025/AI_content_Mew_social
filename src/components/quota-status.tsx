"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface MinutesQuota {
  used: number;
  limit: number;
  remaining: number;
}

interface QuotaData {
  plan: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  minutes?: MinutesQuota;
}

interface QuotaStatusProps {
  /** "chip" = compact inline pill (default); "row" = fuller one-line block for settings */
  variant?: "chip" | "row";
  /** Bump this to trigger a re-fetch after a render/burn completes */
  refreshKey?: number;
  className?: string;
}

function formatThaiDate(iso: string): string {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    // Buddhist Era = Gregorian + 543
    const yyyy = d.getFullYear() + 543;
    return `${dd}/${mm}/${yyyy}`;
  } catch {
    return iso;
  }
}

function isLowQuota(remaining: number, limit: number): boolean {
  if (limit <= 0) return false;
  return remaining <= 10 || remaining / limit <= 0.15;
}

export function QuotaStatus({ variant = "chip", refreshKey, className }: QuotaStatusProps) {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  // null = loading, "error" = failed silently

  useEffect(() => {
    let cancelled = false;
    fetch("/api/videos/usage", { cache: "no-store" })
      .then(r => {
        if (!r.ok) return null;
        return r.json() as Promise<QuotaData & { minutes?: MinutesQuota }>;
      })
      .then(data => {
        if (!cancelled) setQuota(data);
      })
      .catch(() => {
        // fail-soft: never throw, never block the page
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // While loading → render nothing (no skeleton flash, no layout shift)
  if (quota === null) return null;

  const mins = quota.minutes;
  // For low-quota warning: use minutes if available, else clips
  const low = mins
    ? isLowQuota(mins.remaining, mins.limit)
    : isLowQuota(quota.remaining, quota.limit);
  const resetStr = formatThaiDate(quota.resetAt);

  if (variant === "chip") {
    // Minutes-based chip (primary) — falls back to clip display if minutes absent
    if (mins) {
      return (
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium select-none",
            low
              ? "bg-amber-500/15 border border-amber-500/30 text-amber-300"
              : "bg-white/5 border border-white/8 text-white/45",
            className
          )}
          title={`แผน ${quota.plan} · เหลือ ${mins.remaining}/${mins.limit} นาที · ใช้คลิปไป ${quota.used}/${quota.limit} · รีเซ็ต ${resetStr}`}
          aria-label={`โควต้า: เหลือ ${mins.remaining} จาก ${mins.limit} นาที รีเซ็ต ${resetStr}`}
        >
          {low && (
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
          )}
          <span>
            <span className={cn("font-semibold", low ? "text-amber-200" : "text-white/70")}>
              {mins.remaining}/{mins.limit}
            </span>{" "}
            นาที{" "}
            <span className="opacity-60">(~{mins.limit} คลิป)</span>
          </span>
        </div>
      );
    }

    // Fallback: clip-based chip (minutes not in response)
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium select-none",
          low
            ? "bg-amber-500/15 border border-amber-500/30 text-amber-300"
            : "bg-white/5 border border-white/8 text-white/45",
          className
        )}
        title={`แผน ${quota.plan} · ใช้ไป ${quota.used}/${quota.limit} คลิป · รีเซ็ต ${resetStr}`}
        aria-label={`โควต้าคลิป: ใช้ไป ${quota.used} จาก ${quota.limit} คลิป เหลือ ${quota.remaining} คลิป รีเซ็ต ${resetStr}`}
      >
        {low && (
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
        )}
        <span>
          ใช้ไป{" "}
          <span className={cn("font-semibold", low ? "text-amber-200" : "text-white/70")}>
            {quota.used}/{quota.limit}
          </span>{" "}
          คลิป · เหลือ{" "}
          <span className={cn("font-semibold", low ? "text-amber-200" : "text-white/70")}>
            {quota.remaining}
          </span>
        </span>
      </div>
    );
  }

  // variant === "row"
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-sm",
        low
          ? "bg-amber-500/10 border border-amber-500/25"
          : "bg-white/4 border border-white/7",
        className
      )}
      aria-label={`โควต้าคลิป: ใช้ไป ${quota.used} จาก ${quota.limit} คลิป เหลือ ${quota.remaining} คลิป รีเซ็ต ${resetStr}`}
    >
      {/* Plan badge */}
      <span
        className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded-full"
        style={{
          background: quota.plan === "BUSINESS"
            ? "hsl(252 70% 60% / 0.15)"
            : quota.plan === "PRO"
            ? "hsl(142 60% 50% / 0.12)"
            : "hsl(0 0% 50% / 0.12)",
          color: quota.plan === "BUSINESS"
            ? "hsl(252 70% 70%)"
            : quota.plan === "PRO"
            ? "hsl(142 60% 65%)"
            : "hsl(0 0% 60%)",
          border: quota.plan === "BUSINESS"
            ? "1px solid hsl(252 70% 60% / 0.3)"
            : quota.plan === "PRO"
            ? "1px solid hsl(142 60% 50% / 0.25)"
            : "1px solid hsl(0 0% 40% / 0.2)",
        }}
      >
        {quota.plan}
      </span>

      {/* Usage */}
      <span className={cn("flex items-center gap-1", low ? "text-amber-300" : "text-white/55")}>
        {low && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />}
        <span>
          ใช้ไป{" "}
          <strong className={low ? "text-amber-200" : "text-white/80"}>
            {quota.used}/{quota.limit}
          </strong>{" "}
          คลิป · เหลือ{" "}
          <strong className={low ? "text-amber-200" : "text-white/80"}>
            {quota.remaining}
          </strong>{" "}
          คลิป
        </span>
      </span>

      {/* Reset date */}
      <span className="text-white/30 text-xs">
        รีเซ็ต {resetStr}
      </span>

      {/* Upgrade link for non-BUSINESS */}
      {quota.plan !== "BUSINESS" && (
        <a
          href="/pricing"
          className="ml-auto text-[10px] font-semibold text-violet-400 hover:text-violet-300 transition-colors underline-offset-2 hover:underline"
        >
          อัปเกรด →
        </a>
      )}
    </div>
  );
}
