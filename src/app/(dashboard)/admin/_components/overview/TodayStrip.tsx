"use client";

import type { TrendDay } from "@/lib/admin-trends.server";

export function TodayStrip({ series }: { series: TrendDay[] }) {
  const today = series[series.length - 1];
  if (!today) return null;
  const failed = today.failedSystem + today.failedCustomer;

  return (
    <p className="text-sm" style={{ color: "var(--ui-text-secondary)" }}>
      วันนี้ · สมัคร {today.signups} · เรนเดอร์ {today.rendersDone} · ส่งออก {today.exportsDone} · จ่าย {today.paidPayments} · ล้มเหลว {failed}
    </p>
  );
}
