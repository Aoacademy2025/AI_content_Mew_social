"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminTrends } from "@/lib/admin-trends.server";
// Client-safe: no prisma/fs/child_process import chain (see admin-trends-shared.ts).
import { defaultTrendDays } from "@/lib/admin-trends-shared";
import { NorthStarHeadline } from "./_components/overview/NorthStarHeadline";
import { TrendCards } from "./_components/overview/TrendCards";
import { TodayStrip } from "./_components/overview/TodayStrip";
import { HealthPills } from "./_components/overview/HealthPills";

const VIOLET_LIGHT = "#B9A6FF";
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

function bangkokTodayLabel(): string {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", weekday: "long" }).format(now);
  const date = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric",
  }).format(now);
  return `${weekday} ${date}`;
}

export default function AdminOverviewPage() {
  const [days, setDays] = useState<14 | 30>(30);
  // Fetching waits for this: without it, mount would fire ?days=30 (the initial state) and then
  // immediately ?days=14 on narrow viewports once the effect below applies — two requests, and
  // whichever response lands second (not necessarily the 14-day one) wins.
  const [ready, setReady] = useState(false);
  const [trends, setTrends] = useState<AdminTrends | null>(null);
  const [error, setError] = useState(false);
  const requestId = useRef(0);

  // Narrow viewports cannot read 30 bars — viewport width is read only inside this mount effect.
  useEffect(() => {
    setDays(defaultTrendDays(window.innerWidth));
    setReady(true);
  }, []);

  const load = useCallback((d: 14 | 30) => {
    const id = ++requestId.current;
    setError(false);
    fetch(`/api/admin/trends?days=${d}`)
      .then((r) => { if (!r.ok) throw new Error("bad status"); return r.json() as Promise<AdminTrends>; })
      .then((data) => { if (id === requestId.current) setTrends(data); })
      .catch(() => { if (id === requestId.current) setError(true); });
  }, []);

  // Gated on `ready` so the viewport decision above always lands before the first fetch; the
  // request-id check in `load` still guards a stale response from an earlier toggle click.
  useEffect(() => { if (ready) load(days); }, [ready, days, load]);

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-6">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
            ผู้ดูแลระบบ · Admin Panel
          </p>
          <h1
            className="text-[30px] font-bold leading-tight tracking-tight"
            style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
          >
            ภาพรวมวันนี้
          </h1>
          <p className="mt-1 text-[15px]" style={{ color: "var(--ui-text-secondary)" }}>{bangkokTodayLabel()}</p>
        </div>

        {error ? (
          <div className="rounded-lg p-6 text-center" style={cardStyle}>
            <button
              type="button"
              className="text-sm underline"
              style={{ color: "var(--ui-text-secondary)" }}
              onClick={() => load(days)}
            >
              โหลดแนวโน้มไม่สำเร็จ · ลองใหม่
            </button>
          </div>
        ) : !trends ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-lg" style={cardStyle} />
            ))}
          </div>
        ) : (
          <>
            <NorthStarHeadline northStar={trends.northStar} />
            <TrendCards trends={trends} days={days} onDaysChange={setDays} />
            <TodayStrip series={trends.series} />
            <HealthPills
              openTickets={trends.openTickets}
              diskUsedPercent={trends.diskUsedPercent}
              queue={trends.queue}
              secondary={trends.secondary}
              days={trends.days}
            />
          </>
        )}
      </div>
    </div>
  );
}
