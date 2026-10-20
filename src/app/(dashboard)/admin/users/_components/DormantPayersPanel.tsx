"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoonStar, Loader2 } from "lucide-react";

type DormantPayer = {
  id: string;
  name: string | null;
  email: string;
  plan: string;
  billingPeriod: string | null;
  subStatus: string | null;
  daysSincePay: number | null;
  daysSinceLastJob: number | null;
  jobsEver: number;
  jobsFailed: number;
  videosEver: number;
  previewsDone30d?: number;
  projectsTouched30d?: number;
  dormancyReason?: "never_created" | "preview_or_draft_30d" | "lapsed_creator";
};

const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

function billingLabel(p: DormantPayer): string {
  const period = p.billingPeriod === "annual" ? "รายปี" : "รายเดือน";
  const mode = p.subStatus === "active" ? "ต่ออัตโนมัติ" : p.subStatus === "past_due" ? "บัตรเก็บไม่ผ่าน" : "จ่ายล่วงหน้า";
  return `${p.plan} · ${period} · ${mode}`;
}

function dormancyBadge(p: DormantPayer) {
  const previews = p.previewsDone30d ?? 0;
  const projects = p.projectsTouched30d ?? 0;
  if (p.dormancyReason === "preview_or_draft_30d" || previews > 0 || projects > 0) {
    return (
      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs font-semibold text-violet-300">
        {previews > 0
          ? `พรีวิวสำเร็จ ${previews} · ยังไม่ Export`
          : `แก้ดราฟต์ ${projects} โปรเจกต์ · ยังไม่เรนเดอร์`}
      </span>
    );
  }
  if (p.daysSinceLastJob === null || p.dormancyReason === "never_created") {
    return (
      <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-semibold text-red-300">
        ไม่เคยกดสร้าง
      </span>
    );
  }
  return (
    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-200">
      เงียบ {p.daysSinceLastJob} วัน (เดือนที่ 2+)
    </span>
  );
}

/**
 * HERO-34 / HERO-81 — Dormant Payers: still paying, created nothing in 30 days. Same evidence as the
 * MAPC headline on /admin/revenue (count here = ลูกค้าจ่ายจริง − MAPC). Never-created first,
 * then longest silent — the order to reach out in. Identity is fine on this admin page
 * (it already lists every user); money is not shown (ADR 0062).
 */
export function DormantPayersPanel({ onSelect }: { onSelect?: (email: string) => void }) {
  const [rows, setRows] = useState<DormantPayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/dormant-payers")
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => setRows(Array.isArray(data?.dormant) ? data.dormant : []))
      .catch(() => setError("โหลดรายชื่อไม่สำเร็จ"));
  }, []);

  const neverCreatedCount = rows
    ? rows.filter((p) => (p.dormancyReason ? p.dormancyReason === "never_created" : p.daysSinceLastJob === null)).length
    : 0;
  const previewOnlyCount = rows
    ? rows.filter((p) => p.dormancyReason === "preview_or_draft_30d" || (p.previewsDone30d ?? 0) > 0 || (p.projectsTouched30d ?? 0) > 0).length
    : 0;
  const lapsedCreatorCount = rows
    ? Math.max(0, rows.length - neverCreatedCount - previewOnlyCount)
    : 0;

  return (
    <Card className="shadow-none" style={cardStyle} data-testid="dormant-payers-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm" style={{ color: "var(--ui-text-primary)" }}>
            <MoonStar className="h-4 w-4 text-amber-300" strokeWidth={2} />
            ลูกค้าจ่ายที่เงียบ (Dormant Payers)
            {rows && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-200">{rows.length}</span>}
          </CardTitle>
          <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
            จ่ายเงินจริงและยังมีสิทธิ์ แต่ไม่มีวิดีโอ/สคริปต์/ภาพสำเร็จใน 30 วัน · = จ่ายจริง − MAPC บนหน้ารายได้
          </p>
        </div>
        {rows && rows.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-red-500/15 px-2 py-0.5 font-medium text-red-300">
              ไม่เคยกดสร้าง: {neverCreatedCount}
            </span>
            <span className="rounded bg-violet-500/15 px-2 py-0.5 font-medium text-violet-300">
              ค้างที่พรีวิว/ดราฟต์ใน 30 วัน: {previewOnlyCount}
            </span>
            <span className="rounded bg-amber-500/15 px-2 py-0.5 font-medium text-amber-200">
              เคยสร้างแล้วเงียบ &gt; 30 วัน: {lapsedCreatorCount}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {error ? (
          <p className="text-sm text-zinc-500">{error}</p>
        ) : rows === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> กำลังโหลด</div>
        ) : rows.length === 0 ? (
          <p className="py-2 text-sm text-zinc-500">ลูกค้าจ่ายทุกคนกลับมาสร้างงานใน 30 วัน</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  <th className="py-2 pr-4 font-medium">ลูกค้า</th>
                  <th className="py-2 pr-4 font-medium">แผน</th>
                  <th className="py-2 pr-4 font-medium">จ่ายล่าสุด</th>
                  <th className="py-2 pr-4 font-medium">สถานะ / งานล่าสุด</th>
                  <th className="py-2 pr-4 font-medium">งาน / ล้ม</th>
                  <th className="py-2 pr-4 font-medium">วิดีโอ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t" style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-secondary)" }}>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={() => onSelect?.(p.email)}
                        className="text-left hover:underline underline-offset-4"
                        style={{ color: "var(--ui-text-primary)" }}
                        title="กรองรายชื่อด้านล่างเป็นคนนี้"
                      >
                        {p.name || p.email}
                      </button>
                      {p.name && <div className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{p.email}</div>}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{billingLabel(p)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{p.daysSincePay === null ? "—" : `${p.daysSincePay} วันก่อน`}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {dormancyBadge(p)}
                        {p.daysSinceLastJob !== null && p.dormancyReason === "preview_or_draft_30d" && (
                          <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                            ({p.daysSinceLastJob} วันก่อน)
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{p.jobsEver} / {p.jobsFailed}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{p.videosEver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
              ระบบส่งแจ้งเตือนอัตโนมัติ: (1) &quot;คลิปแรกของคุณยังรออยู่&quot; หลังจ่าย 3 วันหากยังไม่เคยสร้างงาน และ (2) แจ้งเตือนชวนสร้างคลิปถัดไปเมื่อลูกค้าที่เคยสร้างงานเงียบครบ 21 วัน (อีเมลเมื่อเปิด PAID_ACTIVATION_EMAIL)
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
