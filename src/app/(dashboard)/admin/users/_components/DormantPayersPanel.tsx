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
};

const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

function billingLabel(p: DormantPayer): string {
  const period = p.billingPeriod === "annual" ? "รายปี" : "รายเดือน";
  const mode = p.subStatus === "active" ? "ต่ออัตโนมัติ" : p.subStatus === "past_due" ? "บัตรเก็บไม่ผ่าน" : "จ่ายล่วงหน้า";
  return `${p.plan} · ${period} · ${mode}`;
}

/**
 * HERO-34 — Dormant Payers: still paying, created nothing in 30 days. Same evidence as the
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
                  <th className="py-2 pr-4 font-medium">งานล่าสุด</th>
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
                      {p.daysSinceLastJob === null
                        ? <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-semibold text-red-300">ไม่เคยกดสร้าง</span>
                        : `${p.daysSinceLastJob} วันก่อน`}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{p.jobsEver} / {p.jobsFailed}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{p.videosEver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
              ระบบส่ง &quot;คลิปแรกของคุณยังรออยู่&quot; ให้คนที่ไม่เคยกดสร้างหลังจ่าย 3 วัน อัตโนมัติ (ครั้งเดียว · อีเมลเมื่อเปิด PAID_ACTIVATION_EMAIL)
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
