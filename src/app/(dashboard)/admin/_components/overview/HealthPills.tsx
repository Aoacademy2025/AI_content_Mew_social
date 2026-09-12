"use client";

import Link from "next/link";
import type { AdminTrends } from "@/lib/admin-trends.server";

interface HealthPillsProps {
  openTickets: number;
  diskUsedPercent: number | null;
  queue: AdminTrends["queue"];
  secondary: AdminTrends["secondary"];
  days: 14 | 30;
}

const pillStyle: React.CSSProperties = {
  background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-secondary)",
};

export function HealthPills({ openTickets, diskUsedPercent, queue, secondary, days }: HealthPillsProps) {
  const queued = queue.renderQueued + queue.videoJobsQueued;
  const diskLabel = diskUsedPercent === null ? "—" : Math.round(diskUsedPercent);
  const errorTooltip = `นับจาก notification ERROR_SYSTEM (รวมซ้ำทุก 5 นาทีต่อ route) และ frontend_error ${secondary.frontendErrors}`;

  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <Link href="/admin/support" className="rounded-full px-3 py-1" style={pillStyle}>Ticket ค้าง {openTickets}</Link>
      <Link href="/admin/storage" className="rounded-full px-3 py-1" style={pillStyle}>ดิสก์ {diskLabel}%</Link>
      <span className="rounded-full px-3 py-1" style={pillStyle}>คิวเรนเดอร์ {queued}</span>
      <span className="rounded-full px-3 py-1" style={pillStyle} title={errorTooltip}>
        แจ้งเตือน error ระบบ {secondary.serverErrorNotifications} ({days} วัน)
      </span>
    </div>
  );
}
