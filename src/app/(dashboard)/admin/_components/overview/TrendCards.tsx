"use client";

import type { AdminTrends, TrendDay } from "@/lib/admin-trends.server";
import { TrendBarChart, bangkokDateFromKey } from "./TrendBarChart";

const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const RED = "#EF4444";
const AMBER = "#F59E0B";
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

const weekdayFmt = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", weekday: "narrow" });
const dayMonthFmt = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" });
const shortLabel = (dateKey: string) => `${weekdayFmt.format(bangkokDateFromKey(dateKey))} ${dayMonthFmt.format(bangkokDateFromKey(dateKey))}`;
const failedTotal = (d: TrendDay) => d.failedSystem + d.failedCustomer;

function formatSigned(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function deltaLabel(days: 14 | 30, current: number, previous: number): string {
  const pct = previous > 0 ? `${formatSigned(Math.round((100 * (current - previous)) / previous))}%` : "—%";
  return `เทียบ ${days} วันก่อน ${formatSigned(current - previous)} (${pct})`;
}

interface CardShellProps {
  title: string;
  total: number;
  prevTotal: number;
  days: 14 | 30;
  footnote?: string;
  legend?: { label: string; color: string }[];
  children: React.ReactNode;
}

function CardShell({ title, total, prevTotal, days, footnote, legend, children }: CardShellProps) {
  return (
    <div className="rounded-lg p-4" style={cardStyle}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{title}</p>
        <p className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>{total}</p>
      </div>
      <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{deltaLabel(days, total, prevTotal)}</p>
      {legend && (
        <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ color: "var(--ui-text-secondary)" }}>
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2">{children}</div>
      {footnote && <p className="mt-2 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{footnote}</p>}
    </div>
  );
}

interface TrendCardsProps {
  trends: AdminTrends;
  days: 14 | 30;
  onDaysChange: (days: 14 | 30) => void;
}

export function TrendCards({ trends, days, onDaysChange }: TrendCardsProps) {
  const { series, totals } = trends;
  const dates = series.map((d) => d.date);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="inline-flex overflow-hidden rounded-md text-xs" style={{ border: "1px solid var(--ui-card-border)" }}>
          {([14, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDaysChange(d)}
              className="px-3 py-1"
              style={{ background: days === d ? VIOLET : "transparent", color: days === d ? "#fff" : "var(--ui-text-secondary)" }}
            >
              {d} วัน
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CardShell title="สมัครใหม่/วัน" total={totals.current.signups} prevTotal={totals.previous.signups} days={days}>
          <TrendBarChart
            dates={dates}
            layout="single"
            bars={[{ key: "signups", color: VIOLET, values: series.map((d) => d.signups) }]}
            tooltipText={(i) => `${shortLabel(dates[i])} · สมัคร ${series[i].signups}`}
            ariaLabel={`สมัครใหม่ ${days} วันล่าสุด รวม ${totals.current.signups} คน`}
          />
        </CardShell>

        <CardShell
          title="สร้างคลิป/วัน"
          total={totals.current.rendersDone + totals.current.exportsDone}
          prevTotal={totals.previous.rendersDone + totals.previous.exportsDone}
          days={days}
          legend={[
            { label: "เรนเดอร์สำเร็จ", color: VIOLET },
            { label: "ส่งออกสำเร็จ", color: VIOLET_LIGHT },
            { label: "ล้มเหลว", color: RED },
          ]}
          footnote="สำเร็จนับต่อไฟล์ที่เรนเดอร์ · ล้มเหลวนับต่องาน (งาน 1 ชิ้นล้มครั้งเดียว)"
        >
          <TrendBarChart
            dates={dates}
            layout="grouped"
            bars={[
              { key: "rendersDone", color: VIOLET, values: series.map((d) => d.rendersDone) },
              { key: "exportsDone", color: VIOLET_LIGHT, values: series.map((d) => d.exportsDone) },
            ]}
            overlay={{ color: RED, values: series.map(failedTotal) }}
            tooltipText={(i) => `${shortLabel(dates[i])} · เรนเดอร์ ${series[i].rendersDone} · ส่งออก ${series[i].exportsDone} · ล้มเหลว ${failedTotal(series[i])}`}
            ariaLabel={`สร้างคลิป ${days} วันล่าสุด เรนเดอร์รวม ${totals.current.rendersDone} ส่งออกรวม ${totals.current.exportsDone} ล้มเหลวรวม ${totals.current.failedSystem + totals.current.failedCustomer}`}
          />
        </CardShell>

        <CardShell
          title="จ่ายจริง/วัน"
          total={totals.current.paidPayments}
          prevTotal={totals.previous.paidPayments}
          days={days}
          footnote="นับจำนวนครั้งที่จ่าย ไม่ใช่ยอดเงิน — ยอดเงินดูที่ รายได้"
        >
          <TrendBarChart
            dates={dates}
            layout="single"
            bars={[{ key: "paidPayments", color: VIOLET, values: series.map((d) => d.paidPayments) }]}
            tooltipText={(i) => `${shortLabel(dates[i])} · จ่าย ${series[i].paidPayments}`}
            ariaLabel={`จ่ายจริง ${days} วันล่าสุด รวม ${totals.current.paidPayments} ครั้ง`}
          />
        </CardShell>

        <CardShell
          title="งานล้มเหลว/วัน"
          total={totals.current.failedSystem + totals.current.failedCustomer}
          prevTotal={totals.previous.failedSystem + totals.previous.failedCustomer}
          days={days}
          legend={[
            { label: "ฝั่งเรา", color: RED },
            { label: "ฝั่งลูกค้า", color: AMBER },
          ]}
          footnote="ฝั่งลูกค้า = คีย์/เครดิตของลูกค้า หรือชนเพดานแผน"
        >
          <TrendBarChart
            dates={dates}
            layout="stacked"
            bars={[
              { key: "failedSystem", color: RED, values: series.map((d) => d.failedSystem) },
              { key: "failedCustomer", color: AMBER, values: series.map((d) => d.failedCustomer) },
            ]}
            tooltipText={(i) => `${shortLabel(dates[i])} · ฝั่งเรา ${series[i].failedSystem} · ฝั่งลูกค้า ${series[i].failedCustomer}`}
            ariaLabel={`งานล้มเหลว ${days} วันล่าสุด ฝั่งเรารวม ${totals.current.failedSystem} ฝั่งลูกค้ารวม ${totals.current.failedCustomer}`}
          />
        </CardShell>
      </div>
    </div>
  );
}
