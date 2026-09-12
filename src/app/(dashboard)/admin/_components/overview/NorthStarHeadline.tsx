"use client";

import type { AdminTrends } from "@/lib/admin-trends.server";

const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };
const TITLE = "ลูกค้าจ่ายที่กลับมาสร้างคลิป (MAPC)";
const FOOTNOTE = "อัปเดตทุกคืน 00:15 · นิยาม: จ่ายอยู่ (ต่ออายุหรือซื้อรายปีที่ยังไม่หมดอายุ) + สร้างงานสำเร็จอย่างน้อย 1 ชิ้นใน 30 วัน";

function deltaChip(delta: number | null): string {
  if (delta === null) return "— ยังไม่มีข้อมูลเทียบ";
  const arrow = delta < 0 ? "▼" : "▲";
  const signed = delta < 0 ? `−${Math.abs(delta)}` : `+${delta}`;
  return `${arrow} ${signed} เทียบ 30 วันก่อน`;
}

export function NorthStarHeadline({ northStar }: { northStar: AdminTrends["northStar"] }) {
  if (!northStar) {
    return (
      <div className="rounded-lg p-5" style={cardStyle}>
        <p className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{TITLE}</p>
        <p className="mt-2 text-lg" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มี snapshot</p>
        <p className="mt-2 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{FOOTNOTE}</p>
      </div>
    );
  }

  const { activeCreators, activePayingCustomers, deltaActiveCreatorsVs30d } = northStar;
  const rate = activePayingCustomers > 0 ? Math.round((100 * activeCreators) / activePayingCustomers) : null;

  return (
    <div className="rounded-lg p-5" style={cardStyle}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{TITLE}</p>
        <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{deltaChip(deltaActiveCreatorsVs30d)}</span>
      </div>
      <p className="mt-1 text-4xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>
        {activeCreators}
      </p>
      <p className="mt-1 text-sm" style={{ color: "var(--ui-text-secondary)" }}>
        จาก {activePayingCustomers} คนที่จ่ายอยู่ · {rate === null ? "—" : rate}%
      </p>
      <p className="mt-3 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{FOOTNOTE}</p>
    </div>
  );
}
