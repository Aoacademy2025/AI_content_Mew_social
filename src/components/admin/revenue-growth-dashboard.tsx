"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CircleDollarSign,
  Focus,
  HelpCircle,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Target,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RevenueGrowthDashboardData } from "@/lib/revenue-growth.server";

const terms = {
  "MAPC": "ลูกค้าจ่ายเงินจริงที่ยังมีสิทธิ์ และกลับมาสร้างวิดีโอ สคริปต์ หรือภาพสำเร็จอย่างน้อย 1 ครั้งใน 30 วัน",
  "รายได้รวม": "เงินเข้าจริงจากลูกค้า ก่อนหักค่าธรรมเนียมการรับชำระ และหักยอดคืนเงินแล้ว",
  "เป้ารายเดือน": "รายได้รวมย้อนหลัง 30 วัน เทียบกับเป้า ฿100,000 ต่อเดือน ไม่ใช่ยอดสะสมตลอดกาล",
  "ฐานต่ออายุ": "มูลค่ารายเดือนจาก Subscription และ Bundle ที่ระบบจะเรียกเก็บรอบถัดไปอัตโนมัติ",
  "จ่ายล่วงหน้า": "มูลค่ารายเดือนเทียบเท่าของเงินที่ลูกค้าจ่ายครั้งเดียวเพื่อใช้สิทธิ์ตามระยะเวลา จึงไม่ต่ออายุเอง",
  "ARR": "ฐานต่ออายุ × 12 เดือน ไม่รวมยอดจ่ายล่วงหน้าที่จะไม่เรียกเก็บเอง",
  "เงินรอส่งมอบ": "ส่วนของเงินจ่ายล่วงหน้าที่เรายังมีภาระให้บริการลูกค้าจนสิทธิ์หมด",
  "ยอดรอตรวจ": "ส่วนต่างระหว่างเงินเข้าจริงกับ ledger ที่ใช้จำแนกสินค้า แสดงไว้เพื่อให้ตรวจสอบ ไม่ถูกบวกซ่อนในสินค้าใด",
  "UTM": "รหัสต่อท้ายลิงก์เพื่อรู้ว่าแคมเปญ โฆษณา หรือชิ้นงานใดพาคนเข้ามาและสร้างรายได้",
} as const;

type Term = keyof typeof terms;

function TermTip({ term }: { term: Term }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`${term}: ${terms[term]}`}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[#728078] transition hover:bg-white/10 hover:text-[#f3f1e8] focus:outline-none focus:ring-2 focus:ring-[#e6b95c]/60"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      <span role="tooltip" className="pointer-events-none absolute left-1/2 top-6 z-50 hidden w-64 -translate-x-1/2 rounded-lg border border-[#3a443e] bg-[#0b0f0d] px-3 py-2 text-left text-xs font-normal leading-5 text-[#d9ddd7] shadow-2xl group-hover:block group-focus-within:block">
        {terms[term]}
      </span>
    </span>
  );
}

function number(value: number, digits = 0) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(value);
}

function money(value: number) {
  return `฿${number(value)}`;
}

function compactMoney(value: number) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function changeLabel(value: number | null) {
  if (value == null) return "ยังไม่มีฐานเทียบ";
  return `${value >= 0 ? "+" : ""}${Math.round(value)}%`;
}

function RevenueTrend({ data }: { data: RevenueGrowthDashboardData["cash"]["trend"] }) {
  const [active, setActive] = useState<number | null>(null);
  const width = 760;
  const height = 280;
  const left = 58;
  const right = 18;
  const top = 22;
  const bottom = 42;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const values = data.flatMap((row) => [row.current, row.previous]);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = Math.max(1, max - min);
  const x = (index: number) => left + (data.length <= 1 ? innerWidth / 2 : (index / (data.length - 1)) * innerWidth);
  const y = (value: number) => top + ((max - value) / span) * innerHeight;
  const path = (key: "current" | "previous") => data.map((row, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  const selected = active == null ? null : data[active];

  function pick(clientX: number, target: SVGSVGElement) {
    const bounds = target.getBoundingClientRect();
    const local = ((clientX - bounds.left) / bounds.width) * width;
    const index = Math.round(((local - left) / innerWidth) * Math.max(0, data.length - 1));
    setActive(Math.min(data.length - 1, Math.max(0, index)));
  }

  return (
    <div className="relative">
      <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-4 text-[#9ba79e]">
          <span className="inline-flex items-center gap-2"><i className="h-0.5 w-5 bg-[#75d69a]" />ช่วงนี้</span>
          <span className="inline-flex items-center gap-2"><i className="h-0.5 w-5 bg-[#6b756f]" />ช่วงก่อน</span>
        </div>
        {selected && <div className="rounded-full border border-[#3a443e] bg-[#171d19] px-3 py-1.5 text-[#d9ddd7]">{selected.label} · {money(selected.current)} / {money(selected.previous)}</div>}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full touch-pan-y overflow-visible"
        role="img"
        aria-label="กราฟรายได้รวมรายวัน เปรียบเทียบช่วงนี้กับช่วงก่อน"
        onPointerMove={(event) => pick(event.clientX, event.currentTarget)}
        onPointerLeave={() => setActive(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const value = min + span * tick;
          const yy = y(value);
          return <g key={tick}><line x1={left} x2={width - right} y1={yy} y2={yy} stroke={Math.abs(value) < span * 0.13 ? "#4a554e" : "#263029"} strokeWidth="1" /><text x={left - 10} y={yy + 4} textAnchor="end" fill="#728078" fontSize="11">{compactMoney(value)}</text></g>;
        })}
        <path d={path("previous")} fill="none" stroke="#6b756f" strokeWidth="2" strokeDasharray="6 7" vectorEffect="non-scaling-stroke" />
        <path d={path("current")} fill="none" stroke="#75d69a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {data.map((row, index) => {
          const every = Math.max(1, Math.ceil(data.length / 5));
          if (index % every !== 0 && index !== data.length - 1) return null;
          return <text key={row.date} x={x(index)} y={height - 12} textAnchor="middle" fill="#728078" fontSize="11">{row.label}</text>;
        })}
        {active != null && selected && <g><line x1={x(active)} x2={x(active)} y1={top} y2={top + innerHeight} stroke="#e6b95c" strokeOpacity=".45" /><circle cx={x(active)} cy={y(selected.current)} r="5" fill="#0b0f0d" stroke="#75d69a" strokeWidth="3" /></g>}
      </svg>
      <table className="sr-only"><caption>รายได้รายวัน</caption><thead><tr><th>วันที่</th><th>ช่วงนี้</th><th>ช่วงก่อน</th></tr></thead><tbody>{data.map((row) => <tr key={row.date}><td>{row.label}</td><td>{row.current}</td><td>{row.previous}</td></tr>)}</tbody></table>
    </div>
  );
}

function NorthStarTrend({ data }: { data: RevenueGrowthDashboardData["northStar"]["history"] }) {
  const width = 540;
  const height = 190;
  const pad = 18;
  const max = Math.max(1, ...data.flatMap((row) => [row.activeCreators, row.activePayingCustomers]));
  const x = (index: number) => pad + (data.length <= 1 ? (width - pad * 2) / 2 : (index / (data.length - 1)) * (width - pad * 2));
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const path = (key: "activeCreators" | "activePayingCustomers") => data.map((row, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(row[key])}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="แนวโน้ม MAPC และฐานลูกค้าจ่ายจริง">
        {[0.25, 0.5, 0.75, 1].map((tick) => <line key={tick} x1={pad} x2={width - pad} y1={y(max * tick)} y2={y(max * tick)} stroke="#263029" />)}
        <path d={path("activePayingCustomers")} fill="none" stroke="#e6b95c" strokeWidth="2" strokeDasharray="5 6" />
        <path d={path("activeCreators")} fill="none" stroke="#75d69a" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((row, index) => <circle key={row.date} cx={x(index)} cy={y(row.activeCreators)} r={data.length === 1 ? 6 : 2.5} fill="#75d69a" />)}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-[#9ba79e]"><span className="inline-flex items-center gap-2"><i className="h-1 w-5 rounded-full bg-[#75d69a]" />MAPC</span><span className="inline-flex items-center gap-2"><i className="h-0.5 w-5 border-t border-dashed border-[#e6b95c]" />ลูกค้าจ่ายจริง</span></div>
    </div>
  );
}

function LoadingState() {
  return <div className="flex min-h-[60vh] items-center justify-center text-[#9ba79e]"><Loader2 className="mr-3 h-5 w-5 animate-spin text-[#75d69a]" />กำลังรวมเงินเข้าจริง…</div>;
}

export default function RevenueGrowthDashboard() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [meeting, setMeeting] = useState(false);
  const [data, setData] = useState<RevenueGrowthDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/admin/revenue?days=${days}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "โหลดข้อมูลไม่สำเร็จ");
        return response.json() as Promise<RevenueGrowthDashboardData>;
      })
      .then(setData)
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "โหลดข้อมูลไม่สำเร็จ"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, reload]);

  const northStarHistory = useMemo(() => {
    if (!data) return [];
    const rows = [...data.northStar.history];
    const today = data.northStar.asOf.slice(0, 10);
    if (!rows.some((row) => row.date === today)) rows.push({
      date: today,
      activeCreators: data.northStar.activeCreators,
      activePayingCustomers: data.northStar.activePayingCustomers,
      videoCreators: data.northStar.outcomes.videoCreators,
      scriptCreators: data.northStar.outcomes.scriptCreators,
      imageCreators: data.northStar.outcomes.imageCreators,
    });
    return rows;
  }, [data]);

  if (loading && !data) return <LoadingState />;
  if (error && !data) return <div className="mx-auto mt-20 max-w-lg border border-[#ef806f]/30 bg-[#ef806f]/5 p-8 text-center"><p className="text-[#f3f1e8]">{error}</p><button type="button" onClick={() => setReload((value) => value + 1)} className="mt-5 inline-flex items-center gap-2 rounded-full bg-[#f3f1e8] px-4 py-2 text-sm font-semibold text-[#0b0f0d]"><RefreshCw className="h-4 w-4" />ลองใหม่</button></div>;
  if (!data) return null;

  const mixRows = [
    { label: "Studio", value: data.cash.mix.studio, color: "#75d69a" },
    { label: "Bundle", value: data.cash.mix.bundle, color: "#e6b95c" },
    { label: "เครดิต", value: data.cash.mix.credit, color: "#7fa6c9" },
    { label: "บันทึกมือ", value: data.cash.mix.manual, color: "#c79bd7" },
    { label: "อื่น ๆ", value: data.cash.mix.other, color: "#77837c" },
  ].filter((row) => row.value > 0);
  const mixMax = Math.max(1, ...mixRows.map((row) => row.value));
  const recurringShare = data.base.activeMonthlyValue > 0 ? (data.base.recurringMonthly / data.base.activeMonthlyValue) * 100 : 0;

  return (
    <main
      className={cn("min-h-screen bg-[#0b0f0d] text-[#f3f1e8]", meeting && "lg:px-4")}
      style={{ fontFamily: '"IBM Plex Sans Thai", sans-serif' }}
    >
      <div className={cn("mx-auto px-4 py-7 sm:px-7 sm:py-10", meeting ? "max-w-[1600px]" : "max-w-[1380px]")}> 
        <header className="flex flex-col gap-5 border-b border-[#27302a] pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-[#75d69a]"><CircleDollarSign className="h-4 w-4" />Revenue &amp; Growth</div>
            <h1 className="text-3xl font-semibold leading-tight sm:text-5xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>รายได้และการเติบโต</h1>
            <p className="mt-3 text-sm text-[#9ba79e] sm:text-base">เงินเข้า → คนจ่าย → คนกลับมาสร้าง → งานรอบถัดไป</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-[#303a33] bg-[#111713] p-1" aria-label="เลือกช่วงเวลา">
              {([7, 30, 90] as const).map((option) => <button key={option} type="button" onClick={() => setDays(option)} className={cn("min-h-10 rounded-full px-4 text-sm font-semibold transition", days === option ? "bg-[#f3f1e8] text-[#0b0f0d]" : "text-[#9ba79e] hover:text-[#f3f1e8]")}>{option} วัน</button>)}
            </div>
            <button type="button" onClick={() => setMeeting((value) => !value)} aria-pressed={meeting} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-[#3a443e] px-4 text-sm font-semibold text-[#d9ddd7] transition hover:border-[#e6b95c]/60 hover:text-[#f3f1e8]">
              {meeting ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}{meeting ? "ออกจากมุมประชุม" : "มุมประชุม"}
            </button>
          </div>
        </header>

        <section className="relative overflow-hidden border-b border-[#27302a] py-9 sm:py-12" aria-labelledby="north-star-title">
          <div className="pointer-events-none absolute -right-24 top-0 h-64 w-64 rounded-full bg-[#75d69a]/[.07] blur-3xl" />
          <div className="grid gap-9 lg:grid-cols-[1.25fr_.75fr] lg:items-end">
            <div>
              <div className="flex items-center text-xs font-semibold uppercase tracking-[.18em] text-[#75d69a]"><Focus className="mr-2 h-4 w-4" />North Star · MAPC<TermTip term="MAPC" /></div>
              <h2 id="north-star-title" className="mt-5 max-w-4xl text-3xl font-semibold leading-[1.2] sm:text-5xl xl:text-6xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>คนจ่ายที่กลับมา<br className="hidden sm:block" />สร้างจริง</h2>
              <div className="mt-6 flex flex-wrap items-end gap-x-5 gap-y-2">
                <strong className="text-6xl font-semibold tabular-nums text-[#75d69a] sm:text-8xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>{number(data.northStar.activeCreators)}</strong>
                <span className="pb-2 text-[#9ba79e]">จากลูกค้าจ่ายจริง {number(data.northStar.activePayingCustomers)} คน<br /><b className="font-semibold text-[#f3f1e8]">กลับมา {number(data.northStar.creatorRatePct)}%</b> ใน 30 วัน</span>
              </div>
              <div className="mt-7 flex flex-wrap gap-x-7 gap-y-2 text-sm text-[#9ba79e]"><span>วิดีโอ <b className="text-[#f3f1e8]">{number(data.northStar.outcomes.videoCreators)}</b></span><span>สคริปต์ <b className="text-[#f3f1e8]">{number(data.northStar.outcomes.scriptCreators)}</b></span><span>ภาพ <b className="text-[#f3f1e8]">{number(data.northStar.outcomes.imageCreators)}</b></span></div>
            </div>
            <div className="border-l-2 border-[#e6b95c] pl-5 sm:pl-7">
              <div className="flex items-center text-xs font-semibold uppercase tracking-[.16em] text-[#e6b95c]"><Target className="mr-2 h-4 w-4" />เป้ารอบนี้<TermTip term="เป้ารายเดือน" /></div>
              <div className="mt-3 text-3xl font-semibold sm:text-4xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>{money(data.goal.monthlyRevenueTarget)}<span className="text-lg text-[#9ba79e]"> / เดือน</span></div>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#222a25]"><div className="h-full rounded-full bg-[#e6b95c] transition-[width] duration-500" style={{ width: `${data.goal.progressPct}%` }} /></div>
              <div className="mt-3 flex justify-between text-xs text-[#9ba79e]"><span>ทำได้ {money(data.goal.last30DaysGross)} · {number(data.goal.progressPct)}%</span><span>เหลือ {money(data.goal.gap)}</span></div>
            </div>
          </div>
        </section>

        <section className="border-b border-[#27302a] py-9 sm:py-12" aria-labelledby="cash-title">
          <div className="grid gap-8 xl:grid-cols-[.34fr_.66fr] xl:gap-12">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[.16em] text-[#9ba79e]">Business outcome</div>
              <h2 id="cash-title" className="mt-3 flex items-center text-xl font-semibold">รายได้รวม {days} วัน<TermTip term="รายได้รวม" /></h2>
              <div className="mt-5 text-5xl font-semibold tabular-nums sm:text-6xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>{money(data.cash.currentGross)}</div>
              <div className={cn("mt-3 inline-flex items-center gap-2 text-sm font-semibold", data.cash.changePct == null ? "text-[#9ba79e]" : data.cash.changePct >= 0 ? "text-[#75d69a]" : "text-[#ef806f]")}>{data.cash.changePct != null && (data.cash.changePct >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />)}{changeLabel(data.cash.changePct)} จากช่วงก่อน</div>
              <dl className="mt-8 space-y-3 border-t border-[#27302a] pt-5 text-sm"><div className="flex justify-between"><dt className="text-[#9ba79e]">เงินเข้าตลอดกาล</dt><dd className="font-semibold tabular-nums">{money(data.cash.lifetimeGross)}</dd></div><div className="flex justify-between"><dt className="text-[#9ba79e]">รายการรับเงิน</dt><dd>{number(data.cash.transactions)} รายการ</dd></div><div className="flex justify-between"><dt className="text-[#9ba79e]">ลูกค้าใหม่ / เดิม</dt><dd>{number(data.cash.newPayers)} / {number(data.cash.repeatPayers)}</dd></div>{data.cash.refunds > 0 && <div className="flex justify-between text-[#ef806f]"><dt>คืนเงิน</dt><dd>-{money(data.cash.refunds)}</dd></div>}</dl>
            </div>
            <RevenueTrend data={data.cash.trend} />
          </div>
        </section>

        <section className="grid border-b border-[#27302a] lg:grid-cols-2" aria-label="ที่มารายได้และฐานรายเดือน">
          <div className="py-9 pr-0 sm:py-12 lg:border-r lg:border-[#27302a] lg:pr-10">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.16em] text-[#9ba79e]"><BarChart3 className="h-4 w-4" />เงินมาจากไหน</div>
            <div className="mt-7 space-y-5">{mixRows.map((row) => <div key={row.label}><div className="mb-2 flex items-center justify-between text-sm"><span>{row.label}</span><b className="tabular-nums">{money(row.value)}</b></div><div className="h-1.5 bg-[#222a25]"><div className="h-full" style={{ width: `${(row.value / mixMax) * 100}%`, background: row.color }} /></div></div>)}</div>
            {Math.abs(data.cash.mix.reconciliation) > 0.5 && <div className="mt-6 flex items-start justify-between gap-3 border-l-2 border-[#ef806f] pl-4 text-sm"><span className="text-[#9ba79e]">ยอดรอตรวจ<TermTip term="ยอดรอตรวจ" /></span><b className="text-[#ef806f]">{money(data.cash.mix.reconciliation)}</b></div>}
          </div>
          <div className="border-t border-[#27302a] py-9 sm:py-12 lg:border-t-0 lg:pl-10">
            <div className="text-xs font-semibold uppercase tracking-[.16em] text-[#9ba79e]">ฐานรายได้ปัจจุบัน</div>
            <div className="mt-5 flex flex-wrap items-baseline justify-between gap-4"><div className="text-4xl font-semibold sm:text-5xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>{money(data.base.activeMonthlyValue)}<span className="text-base text-[#9ba79e]"> / เดือน</span></div><span className="text-sm text-[#9ba79e]">ลูกค้าจ่าย {number(data.base.activePayingCustomers)} คน</span></div>
            <div className="mt-8 flex h-4 overflow-hidden rounded-full bg-[#222a25]" aria-label={`ฐานต่ออายุ ${Math.round(recurringShare)} เปอร์เซ็นต์ จ่ายล่วงหน้า ${Math.round(100 - recurringShare)} เปอร์เซ็นต์`}><div className="bg-[#75d69a]" style={{ width: `${recurringShare}%` }} /><div className="bg-[#e6b95c]" style={{ width: `${100 - recurringShare}%` }} /></div>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm"><div><dt className="text-[#9ba79e]">ฐานต่ออายุ<TermTip term="ฐานต่ออายุ" /></dt><dd className="mt-1 text-lg font-semibold text-[#75d69a]">{money(data.base.recurringMonthly)}</dd></div><div><dt className="text-[#9ba79e]">จ่ายล่วงหน้า<TermTip term="จ่ายล่วงหน้า" /></dt><dd className="mt-1 text-lg font-semibold text-[#e6b95c]">{money(data.base.prepaidMonthlyEquivalent)}</dd></div><div><dt className="text-[#9ba79e]">ARR<TermTip term="ARR" /></dt><dd className="mt-1 font-semibold">{money(data.base.arr)}</dd></div><div><dt className="text-[#9ba79e]">เงินรอส่งมอบ<TermTip term="เงินรอส่งมอบ" /></dt><dd className="mt-1 font-semibold">{money(data.base.deferredRevenue)}</dd></div></dl>
          </div>
        </section>

        <section className="border-b border-[#27302a] py-9 sm:py-12" aria-labelledby="signal-title">
          <div className="grid gap-9 lg:grid-cols-[.44fr_.56fr] lg:items-center">
            <div><div className="text-xs font-semibold uppercase tracking-[.16em] text-[#75d69a]">สัญญาณนำ</div><h2 id="signal-title" className="mt-3 text-2xl font-semibold sm:text-3xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>MAPC กำลังไปทางไหน</h2><p className="mt-3 max-w-md text-sm leading-6 text-[#9ba79e]">รายได้บอกผลลัพธ์ที่ผ่านมา ส่วน MAPC บอกว่าลูกค้าจ่ายแล้วยังกลับมาได้รับคุณค่าหรือไม่</p><div className="mt-6 flex gap-8"><div><span className="text-xs text-[#9ba79e]">รายเดือน</span><div className="mt-1 text-2xl font-semibold">{number(data.northStar.monthlyCreators)}</div></div><div><span className="text-xs text-[#9ba79e]">รายปี</span><div className="mt-1 text-2xl font-semibold">{number(data.northStar.annualCreators)}</div></div></div></div>
            <NorthStarTrend data={northStarHistory} />
          </div>
        </section>

        <section className="border-b border-[#27302a] py-9 sm:py-12" aria-labelledby="insights-title">
          <div className="flex items-center justify-between gap-4"><div><div className="text-xs font-semibold uppercase tracking-[.16em] text-[#9ba79e]">อ่านตัวเลขให้เป็นการตัดสินใจ</div><h2 id="insights-title" className="mt-3 text-2xl font-semibold sm:text-3xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>3 เรื่องที่ทีมต้องรู้</h2></div></div>
          <div className="mt-7 divide-y divide-[#27302a] border-y border-[#27302a]">{data.insights.map((insight, index) => <article key={insight.title} className="grid gap-2 py-5 sm:grid-cols-[50px_.38fr_1fr] sm:items-center"><span className="text-xs tabular-nums text-[#728078]">0{index + 1}</span><h3 className={cn("font-semibold", insight.tone === "positive" ? "text-[#75d69a]" : insight.tone === "attention" ? "text-[#e6b95c]" : "text-[#f3f1e8]")}>{insight.title}</h3><p className="text-sm text-[#9ba79e]">{insight.detail}</p></article>)}</div>
        </section>

        <section className="py-9 sm:py-12" aria-labelledby="team-title">
          <div className="max-w-2xl"><div className="text-xs font-semibold uppercase tracking-[.16em] text-[#e6b95c]">One team · One North Star</div><h2 id="team-title" className="mt-3 text-2xl font-semibold sm:text-3xl" style={{ fontFamily: '"Bai Jamjuree", sans-serif' }}>รอบนี้แต่ละทีมทำอะไร</h2><p className="mt-3 text-sm text-[#9ba79e]">ทุกงานต้องตอบได้ว่า ช่วยให้คนจ่ายกลับมาสร้าง หรือช่วยพารายได้เข้าอย่างไร</p></div>
          <div className="mt-8 grid border-l border-t border-[#27302a] sm:grid-cols-2 xl:grid-cols-4">{data.teamActions.map((item, index) => <article key={item.team} className="min-h-52 border-b border-r border-[#27302a] p-5 sm:p-6"><div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[.14em] text-[#75d69a]">{item.team}</span><span className="text-xs text-[#728078]">0{index + 1}</span></div><h3 className="mt-6 text-xl font-semibold">{item.focus}</h3><p className="mt-3 text-sm leading-6 text-[#9ba79e]">{item.action}{item.team === "Media" && <TermTip term="UTM" />}</p><div className="mt-6 text-xs text-[#728078]">วัด: <b className="font-semibold text-[#d9ddd7]">{item.measure}</b></div></article>)}</div>
        </section>

        {!meeting && <section className="grid gap-7 border-t border-[#27302a] py-8 text-sm text-[#9ba79e] sm:grid-cols-3" aria-label="ฐานลูกค้าและวิธีนับ"><div><div className="flex items-center gap-2 font-semibold text-[#d9ddd7]"><Users className="h-4 w-4" />ฐานลูกค้า</div><p className="mt-3 leading-6">จ่ายจริง {number(data.base.activePayingCustomers)} · Trial {number(data.base.trials)} · Free {number(data.base.free)} · เคยจ่าย {number(data.base.lapsed)}</p></div><div><div className="font-semibold text-[#d9ddd7]">สินค้า</div><p className="mt-3 leading-6">Studio {number(data.base.directPayers)} คน · Bundle {number(data.base.bundlePayers)} คน · ซื้อเครดิต {number(data.base.creditBuyers)} คน ({money(data.base.creditRevenue)})</p></div><div><div className="font-semibold text-[#d9ddd7]">วิธีนับ</div><p className="mt-3 leading-6">ยอดรวมยึดเงินเข้าจริง จำแนกสินค้าจาก ledger และไม่แสดงค่าธรรมเนียมรับชำระ อัปเดต {new Date(data.range.until).toLocaleString("th-TH")}</p></div></section>}
        {loading && <div className="fixed bottom-5 right-5 inline-flex items-center gap-2 rounded-full border border-[#3a443e] bg-[#111713]/95 px-4 py-2 text-xs text-[#9ba79e] shadow-xl"><Loader2 className="h-3.5 w-3.5 animate-spin text-[#75d69a]" />กำลังอัปเดต</div>}
      </div>
    </main>
  );
}
