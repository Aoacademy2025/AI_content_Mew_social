"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CircleDollarSign,
  Focus,
  HelpCircle,
  Lightbulb,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Rocket,
  Target,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RevenueGrowthDashboardData } from "@/lib/revenue-growth.server";
import type { RevenueGrowthOpportunity } from "@/lib/revenue-growth-opportunities";

const BRAND = "#8B5CF6";
const BRAND_LIGHT = "#B9A6FF";
const SKY = "#60A5FA";
const SUCCESS = "#34D399";
const WARNING = "#FBBF24";
const DANGER = "#FB7185";

const surfaceStyle = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
} as const;

const terms = {
  "MAPC": "ลูกค้าจ่ายเงินจริงที่ยังมีสิทธิ์ และกลับมาสร้างวิดีโอ สคริปต์ หรือภาพสำเร็จอย่างน้อย 1 ครั้งใน 30 วัน",
  "รายได้รวม": "เงินเข้าจริงจากลูกค้า ก่อนหักค่าธรรมเนียมการรับชำระ และหักยอดคืนเงินแล้ว",
  "เป้ารายเดือน": "รายได้รวมย้อนหลัง 30 วัน เทียบกับเป้า ฿100,000 ต่อเดือน ไม่ใช่ยอดสะสมตลอดกาล",
  "ฐานต่ออายุ": "มูลค่ารายเดือนจาก Subscription และ Bundle ที่ระบบจะเรียกเก็บรอบถัดไปอัตโนมัติ",
  "จ่ายล่วงหน้า": "มูลค่ารายเดือนเทียบเท่าของเงินที่ลูกค้าจ่ายครั้งเดียว จึงไม่ต่ออายุเอง",
  "ARR": "ฐานต่ออายุ × 12 เดือน ไม่รวมยอดจ่ายล่วงหน้าที่จะไม่เรียกเก็บเอง",
  "เงินรอส่งมอบ": "ส่วนของเงินจ่ายล่วงหน้าที่เรายังมีภาระให้บริการลูกค้าจนสิทธิ์หมด",
  "ยอดรอตรวจ": "ส่วนต่างระหว่างเงินเข้าจริงกับ Ledger จำแนกสินค้า แสดงไว้เพื่อให้ตรวจสอบโดยไม่บวกซ่อนในสินค้าใด",
  "UTM": "รหัสต่อท้ายลิงก์เพื่อรู้ว่าแคมเปญ โฆษณา หรือชิ้นงานใดพาคนเข้ามาและสร้างรายได้",
  "B-roll": "ภาพหรือวิดีโอแทรกที่ช่วยเล่าเรื่องแทนการเห็นผู้พูดตลอดคลิป",
  "Face Lock": "การล็อกใบหน้าหรือตัวละครให้ยังดูเป็นคนเดิมข้ามหลายภาพและหลายซีน",
  "Pre-sell": "เปิดรับความสนใจหรือคำสั่งซื้อก่อนพัฒนาเต็ม เพื่อพิสูจน์ว่าลูกค้ายอมจ่ายจริง",
  "Impact": "ขนาดผลลัพธ์ที่คาดว่าจะส่งต่อยอดขาย การใช้ซ้ำ หรือการรักษาลูกค้า",
  "Confidence": "ความมั่นใจจากข้อมูลใช้งาน คำขอลูกค้า และหลักฐานรายได้ที่มีอยู่",
  "Effort": "แรงพัฒนา ออกแบบ ทดสอบ และดูแลระบบโดยประมาณ",
  "Trial→Paid": "อัตราที่ผู้ทดลองใช้เปลี่ยนเป็นลูกค้าจ่ายเงินจริง",
} as const;

type Term = keyof typeof terms;

function TermTip({ term }: { term: Term }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`${term}: ${terms[term]}`}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full transition hover:bg-white/[.06] focus:outline-none focus:ring-2"
        style={{ color: "var(--ui-text-muted)", "--tw-ring-color": `${BRAND}80` } as CSSProperties}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-50 hidden w-64 -translate-x-1/2 rounded-lg px-3 py-2 text-left text-xs font-normal leading-5 shadow-2xl group-hover:block group-focus-within:block"
        style={{ ...surfaceStyle, color: "var(--ui-text-secondary)", background: "var(--ui-card-bg-3)" }}
      >
        {terms[term]}
      </span>
    </span>
  );
}

function Panel({ children, className, ...props }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl shadow-sm", className)} style={surfaceStyle} {...props}>{children}</div>;
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
  const height = 270;
  const left = 58;
  const right = 18;
  const top = 20;
  const bottom = 40;
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
    <div className="relative min-w-0">
      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-4" style={{ color: "var(--ui-text-muted)" }}>
          <span className="inline-flex items-center gap-2"><i className="h-0.5 w-5" style={{ background: BRAND }} />ช่วงนี้</span>
          <span className="inline-flex items-center gap-2"><i className="h-0.5 w-5" style={{ background: "var(--ui-text-muted)" }} />ช่วงก่อน</span>
        </div>
        {selected && (
          <div className="rounded-lg px-3 py-1.5" style={{ ...surfaceStyle, background: "var(--ui-card-bg-2)", color: "var(--ui-text-secondary)" }}>
            {selected.label} · {money(selected.current)} / {money(selected.previous)}
          </div>
        )}
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
          return (
            <g key={tick}>
              <line x1={left} x2={width - right} y1={yy} y2={yy} stroke="var(--ui-divider)" strokeWidth="1" />
              <text x={left - 10} y={yy + 4} textAnchor="end" fill="var(--ui-text-muted)" fontSize="11">{compactMoney(value)}</text>
            </g>
          );
        })}
        <path d={path("previous")} fill="none" stroke="var(--ui-text-muted)" strokeWidth="2" strokeDasharray="6 7" vectorEffect="non-scaling-stroke" />
        <path d={path("current")} fill="none" stroke={BRAND} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {data.map((row, index) => {
          const every = Math.max(1, Math.ceil(data.length / 5));
          if (index % every !== 0 && index !== data.length - 1) return null;
          return <text key={row.date} x={x(index)} y={height - 11} textAnchor="middle" fill="var(--ui-text-muted)" fontSize="11">{row.label}</text>;
        })}
        {active != null && selected && (
          <g>
            <line x1={x(active)} x2={x(active)} y1={top} y2={top + innerHeight} stroke={WARNING} strokeOpacity=".55" />
            <circle cx={x(active)} cy={y(selected.current)} r="5" fill="var(--ui-card-bg)" stroke={BRAND} strokeWidth="3" />
          </g>
        )}
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
        {[0.25, 0.5, 0.75, 1].map((tick) => <line key={tick} x1={pad} x2={width - pad} y1={y(max * tick)} y2={y(max * tick)} stroke="var(--ui-divider)" />)}
        <path d={path("activePayingCustomers")} fill="none" stroke={SKY} strokeWidth="2" strokeDasharray="5 6" />
        <path d={path("activeCreators")} fill="none" stroke={BRAND} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((row, index) => <circle key={row.date} cx={x(index)} cy={y(row.activeCreators)} r={data.length === 1 ? 6 : 2.5} fill={BRAND} />)}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--ui-text-muted)" }}>
        <span className="inline-flex items-center gap-2"><i className="h-1 w-5 rounded-full" style={{ background: BRAND }} />MAPC</span>
        <span className="inline-flex items-center gap-2"><i className="h-0.5 w-5 border-t border-dashed" style={{ borderColor: SKY }} />ลูกค้าจ่ายจริง</span>
      </div>
    </div>
  );
}

function Level({ label, value, tip }: { label: string; value: string; tip: "Impact" | "Confidence" | "Effort" }) {
  const color = value === "สูง" ? SUCCESS : value === "กลาง" ? WARNING : "var(--ui-text-muted)";
  return (
    <div>
      <dt className="flex items-center text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{label}<TermTip term={tip} /></dt>
      <dd className="mt-1 text-sm font-semibold" style={{ color }}>{value}</dd>
    </div>
  );
}

function OpportunityCard({ item }: { item: RevenueGrowthOpportunity }) {
  const accent = item.lane === "ทำก่อน" ? BRAND : item.lane === "ทดลองขาย" ? WARNING : SKY;
  return (
    <article className="flex min-h-[330px] flex-col rounded-xl p-5 sm:p-6" style={surfaceStyle}>
      <div className="flex items-center justify-between gap-4">
        <span className="rounded-md px-2.5 py-1 text-xs font-semibold" style={{ color: accent, background: `${accent}18` }}>{item.lane}</span>
        <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--ui-text-muted)" }}>0{item.rank}</span>
      </div>
      <h3 className="mt-5 flex items-center text-xl font-semibold" style={{ color: "var(--ui-text-primary)", fontFamily: "Kanit, sans-serif" }}>
        {item.title}
        {item.id === "broll-control" && <TermTip term="B-roll" />}
        {item.id === "face-lock" && <TermTip term="Face Lock" />}
      </h3>
      <p className="mt-2 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>{item.recommendation}</p>
      <div className="mt-5 rounded-lg p-3 text-xs leading-5" style={{ background: "var(--ui-card-bg-2)", color: "var(--ui-text-secondary)" }}>
        <span className="font-semibold" style={{ color: "var(--ui-text-primary)" }}>ข้อมูลที่ใช้</span><br />{item.evidence}
      </div>
      <p className="mt-4 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}><b style={{ color: accent }}>ทางทำเงิน:</b> {item.revenueMove}</p>
      <div className="mt-auto pt-5">
        <dl className="grid grid-cols-3 gap-4 border-t pt-4" style={{ borderColor: "var(--ui-divider)" }}>
          <Level label="ผลต่อรายได้" value={item.impact} tip="Impact" />
          <Level label="ความมั่นใจ" value={item.confidence} tip="Confidence" />
          <Level label="แรงพัฒนา" value={item.effort} tip="Effort" />
        </dl>
        <div className="mt-4 text-xs" style={{ color: "var(--ui-text-muted)" }}>วัดผล: <b style={{ color: "var(--ui-text-secondary)" }}>{item.metric}</b>{item.metric.includes("Trial→Paid") && <TermTip term="Trial→Paid" />}</div>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="mx-auto grid max-w-[1380px] gap-5 py-3">
      <div className="dash-skeleton h-24 rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-3"><div className="dash-skeleton h-64 rounded-xl lg:col-span-2" /><div className="dash-skeleton h-64 rounded-xl" /></div>
      <div className="dash-skeleton h-96 rounded-xl" />
    </div>
  );
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
  if (error && !data) return (
    <Panel className="mx-auto mt-20 max-w-lg p-8 text-center">
      <p style={{ color: "var(--ui-text-primary)" }}>{error}</p>
      <button type="button" onClick={() => setReload((value) => value + 1)} className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: BRAND }}><RefreshCw className="h-4 w-4" />ลองใหม่</button>
    </Panel>
  );
  if (!data) return null;

  const mixRows = [
    { label: "Studio", value: data.cash.mix.studio, color: BRAND },
    { label: "Bundle", value: data.cash.mix.bundle, color: SKY },
    { label: "เครดิต", value: data.cash.mix.credit, color: WARNING },
    { label: "บันทึกมือ", value: data.cash.mix.manual, color: "#D946EF" },
    { label: "อื่น ๆ", value: data.cash.mix.other, color: "var(--ui-text-muted)" },
  ].filter((row) => row.value > 0);
  const mixMax = Math.max(1, ...mixRows.map((row) => row.value));
  const recurringShare = data.base.activeMonthlyValue > 0 ? (data.base.recurringMonthly / data.base.activeMonthlyValue) * 100 : 0;

  return (
    <main className="min-h-full" style={{ color: "var(--ui-text-primary)" }}>
      <div className={cn("mx-auto space-y-5", meeting ? "max-w-[1600px]" : "max-w-[1380px]")}>
        <header className="flex flex-col gap-5 py-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}><CircleDollarSign className="h-4 w-4" />Revenue &amp; Growth</div>
            <h1 className="text-3xl font-semibold leading-tight sm:text-4xl" style={{ fontFamily: "Kanit, sans-serif" }}>รายได้และการเติบโต</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--ui-text-secondary)" }}>เงินเข้า → คนจ่าย → คนกลับมาสร้าง → งานรอบถัดไป</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl p-1" style={{ ...surfaceStyle, background: "var(--ui-card-bg-2)" }} aria-label="เลือกช่วงเวลา">
              {([7, 30, 90] as const).map((option) => (
                <button key={option} type="button" onClick={() => setDays(option)} className="min-h-9 rounded-lg px-4 text-sm font-semibold transition" style={days === option ? { background: BRAND, color: "white" } : { color: "var(--ui-text-secondary)" }}>{option} วัน</button>
              ))}
            </div>
            <button type="button" onClick={() => setMeeting((value) => !value)} aria-pressed={meeting} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition hover:brightness-110" style={{ ...surfaceStyle, color: "var(--ui-text-secondary)" }}>
              {meeting ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}{meeting ? "ออกจากมุมประชุม" : "มุมประชุม"}
            </button>
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]" aria-labelledby="north-star-title">
          <Panel className="relative overflow-hidden p-6 sm:p-7">
            <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full opacity-10 blur-3xl" style={{ background: BRAND }} />
            <div className="relative">
              <div className="flex items-center text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}><Focus className="mr-2 h-4 w-4" />North Star · MAPC<TermTip term="MAPC" /></div>
              <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <h2 id="north-star-title" className="text-2xl font-semibold sm:text-3xl" style={{ fontFamily: "Kanit, sans-serif" }}>คนจ่ายที่กลับมาสร้างจริง</h2>
                  <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
                    <strong className="text-6xl font-semibold tabular-nums" style={{ color: BRAND, fontFamily: "Kanit, sans-serif" }}>{number(data.northStar.activeCreators)}</strong>
                    <span className="pb-2 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>จากลูกค้าจ่ายจริง {number(data.northStar.activePayingCustomers)} คน<br /><b style={{ color: "var(--ui-text-primary)" }}>กลับมา {number(data.northStar.creatorRatePct)}%</b> ใน 30 วัน</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-5 text-sm">
                  {[{ label: "วิดีโอ", value: data.northStar.outcomes.videoCreators }, { label: "สคริปต์", value: data.northStar.outcomes.scriptCreators }, { label: "ภาพ", value: data.northStar.outcomes.imageCreators }].map((item) => (
                    <div key={item.label}><div className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{item.label}</div><b className="mt-1 block text-xl">{number(item.value)}</b></div>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel className="p-6 sm:p-7">
            <div className="flex items-center text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}><Target className="mr-2 h-4 w-4" />เป้ารอบนี้<TermTip term="เป้ารายเดือน" /></div>
            <div className="mt-5 text-3xl font-semibold" style={{ fontFamily: "Kanit, sans-serif" }}>{money(data.goal.monthlyRevenueTarget)}<span className="ml-2 text-sm font-normal" style={{ color: "var(--ui-text-muted)" }}>/ เดือน</span></div>
            <div className="mt-6 h-2 overflow-hidden rounded-full" style={{ background: "var(--ui-card-bg-2)" }}><div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${data.goal.progressPct}%`, background: BRAND }} /></div>
            <div className="mt-3 flex justify-between gap-4 text-xs" style={{ color: "var(--ui-text-muted)" }}><span>ทำได้ {money(data.goal.last30DaysGross)} · {number(data.goal.progressPct)}%</span><span>เหลือ {money(data.goal.gap)}</span></div>
          </Panel>
        </section>

        <Panel className="p-6 sm:p-7" aria-labelledby="cash-title">
          <div className="grid gap-8 xl:grid-cols-[.3fr_.7fr] xl:gap-12">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[.14em]" style={{ color: "var(--ui-text-muted)" }}>Business outcome</div>
              <h2 id="cash-title" className="mt-3 flex items-center text-lg font-semibold">รายได้รวม {days} วัน<TermTip term="รายได้รวม" /></h2>
              <div className="mt-4 text-5xl font-semibold tabular-nums" style={{ fontFamily: "Kanit, sans-serif" }}>{money(data.cash.currentGross)}</div>
              <div className="mt-2 inline-flex items-center gap-2 text-sm font-semibold" style={{ color: data.cash.changePct == null ? "var(--ui-text-muted)" : data.cash.changePct >= 0 ? SUCCESS : DANGER }}>
                {data.cash.changePct != null && (data.cash.changePct >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />)}{changeLabel(data.cash.changePct)} จากช่วงก่อน
              </div>
              <dl className="mt-7 space-y-3 border-t pt-5 text-sm" style={{ borderColor: "var(--ui-divider)" }}>
                <div className="flex justify-between"><dt style={{ color: "var(--ui-text-muted)" }}>เงินเข้าตลอดกาล</dt><dd className="font-semibold tabular-nums">{money(data.cash.lifetimeGross)}</dd></div>
                <div className="flex justify-between"><dt style={{ color: "var(--ui-text-muted)" }}>รายการรับเงิน</dt><dd>{number(data.cash.transactions)} รายการ</dd></div>
                <div className="flex justify-between"><dt style={{ color: "var(--ui-text-muted)" }}>ลูกค้าใหม่ / เดิม</dt><dd>{number(data.cash.newPayers)} / {number(data.cash.repeatPayers)}</dd></div>
                {data.cash.refunds > 0 && <div className="flex justify-between" style={{ color: DANGER }}><dt>คืนเงิน</dt><dd>-{money(data.cash.refunds)}</dd></div>}
              </dl>
            </div>
            <RevenueTrend data={data.cash.trend} />
          </div>
        </Panel>

        <section className="grid gap-5 lg:grid-cols-2" aria-label="ที่มารายได้และฐานรายเดือน">
          <Panel className="p-6 sm:p-7">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.14em]" style={{ color: "var(--ui-text-muted)" }}><BarChart3 className="h-4 w-4" />เงินมาจากไหน</div>
            <div className="mt-6 space-y-5">{mixRows.map((row) => (
              <div key={row.label}><div className="mb-2 flex items-center justify-between text-sm"><span>{row.label}</span><b className="tabular-nums">{money(row.value)}</b></div><div className="h-1.5 rounded-full" style={{ background: "var(--ui-card-bg-2)" }}><div className="h-full rounded-full" style={{ width: `${(row.value / mixMax) * 100}%`, background: row.color }} /></div></div>
            ))}</div>
            {Math.abs(data.cash.mix.reconciliation) > 0.5 && <div className="mt-6 flex items-start justify-between gap-3 rounded-lg p-3 text-sm" style={{ background: `${DANGER}12` }}><span style={{ color: "var(--ui-text-secondary)" }}>ยอดรอตรวจ<TermTip term="ยอดรอตรวจ" /></span><b style={{ color: DANGER }}>{money(data.cash.mix.reconciliation)}</b></div>}
          </Panel>

          <Panel className="p-6 sm:p-7">
            <div className="text-xs font-semibold uppercase tracking-[.14em]" style={{ color: "var(--ui-text-muted)" }}>ฐานรายได้ปัจจุบัน</div>
            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-4"><div className="text-4xl font-semibold" style={{ fontFamily: "Kanit, sans-serif" }}>{money(data.base.activeMonthlyValue)}<span className="ml-2 text-sm font-normal" style={{ color: "var(--ui-text-muted)" }}>/ เดือน</span></div><span className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ลูกค้าจ่าย {number(data.base.activePayingCustomers)} คน</span></div>
            <div className="mt-7 flex h-3 overflow-hidden rounded-full" style={{ background: "var(--ui-card-bg-2)" }} aria-label={`ฐานต่ออายุ ${Math.round(recurringShare)} เปอร์เซ็นต์ จ่ายล่วงหน้า ${Math.round(100 - recurringShare)} เปอร์เซ็นต์`}><div style={{ width: `${recurringShare}%`, background: BRAND }} /><div style={{ width: `${100 - recurringShare}%`, background: WARNING }} /></div>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 text-sm">
              <div><dt style={{ color: "var(--ui-text-muted)" }}>ฐานต่ออายุ<TermTip term="ฐานต่ออายุ" /></dt><dd className="mt-1 text-lg font-semibold" style={{ color: BRAND_LIGHT }}>{money(data.base.recurringMonthly)}</dd></div>
              <div><dt style={{ color: "var(--ui-text-muted)" }}>จ่ายล่วงหน้า<TermTip term="จ่ายล่วงหน้า" /></dt><dd className="mt-1 text-lg font-semibold" style={{ color: WARNING }}>{money(data.base.prepaidMonthlyEquivalent)}</dd></div>
              <div><dt style={{ color: "var(--ui-text-muted)" }}>ARR<TermTip term="ARR" /></dt><dd className="mt-1 font-semibold">{money(data.base.arr)}</dd></div>
              <div><dt style={{ color: "var(--ui-text-muted)" }}>เงินรอส่งมอบ<TermTip term="เงินรอส่งมอบ" /></dt><dd className="mt-1 font-semibold">{money(data.base.deferredRevenue)}</dd></div>
            </dl>
          </Panel>
        </section>

        <section className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
          <Panel className="p-6 sm:p-7" aria-labelledby="signal-title">
            <div className="grid gap-7 md:grid-cols-[.42fr_.58fr] md:items-center">
              <div><div className="text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}>สัญญาณนำ</div><h2 id="signal-title" className="mt-3 text-2xl font-semibold" style={{ fontFamily: "Kanit, sans-serif" }}>MAPC กำลังไปทางไหน</h2><p className="mt-2 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>รายได้บอกผลที่ผ่านมา ส่วน MAPC บอกว่าคนจ่ายยังกลับมาได้รับคุณค่าหรือไม่</p><div className="mt-5 flex gap-8"><div><span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>รายเดือน</span><div className="mt-1 text-2xl font-semibold">{number(data.northStar.monthlyCreators)}</div></div><div><span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>รายปี</span><div className="mt-1 text-2xl font-semibold">{number(data.northStar.annualCreators)}</div></div></div></div>
              <NorthStarTrend data={northStarHistory} />
            </div>
          </Panel>

          <Panel className="p-6 sm:p-7" aria-labelledby="insights-title">
            <div className="text-xs font-semibold uppercase tracking-[.14em]" style={{ color: "var(--ui-text-muted)" }}>อ่านตัวเลขให้เป็นการตัดสินใจ</div>
            <h2 id="insights-title" className="mt-3 text-2xl font-semibold" style={{ fontFamily: "Kanit, sans-serif" }}>3 เรื่องที่ทีมต้องรู้</h2>
            <div className="mt-5 divide-y" style={{ borderColor: "var(--ui-divider)" }}>{data.insights.map((insight, index) => (
              <article key={insight.title} className="grid gap-1 py-4 sm:grid-cols-[32px_1fr]">
                <span className="text-xs tabular-nums" style={{ color: "var(--ui-text-muted)" }}>0{index + 1}</span>
                <div><h3 className="font-semibold" style={{ color: insight.tone === "positive" ? SUCCESS : insight.tone === "attention" ? WARNING : "var(--ui-text-primary)" }}>{insight.title}</h3><p className="mt-1 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>{insight.detail}</p></div>
              </article>
            ))}</div>
          </Panel>
        </section>

        <section className="py-4 sm:py-7" aria-labelledby="growth-title">
          <div className="grid gap-5 lg:grid-cols-[.75fr_1.25fr] lg:items-end">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}><Rocket className="h-4 w-4" />Growth opportunities</div>
              <h2 id="growth-title" className="mt-3 text-2xl font-semibold sm:text-3xl" style={{ fontFamily: "Kanit, sans-serif" }}>ถ้าจะโตแบบก้าวกระโดด ทำอะไรต่อ</h2>
              <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>{data.growthPlan.principle}</p>
            </div>
            <div className="rounded-xl p-5" style={{ background: `${BRAND}12`, border: `1px solid ${BRAND}40` }}>
              <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${BRAND}20`, color: BRAND_LIGHT }}><Lightbulb className="h-4 w-4" /></span><div><div className="text-xs font-semibold uppercase tracking-[.12em]" style={{ color: BRAND_LIGHT }}>คำตัดสินรอบนี้</div><p className="mt-1 font-semibold leading-6">{data.growthPlan.verdict}{data.growthPlan.verdict.includes("Pre-sell") && <TermTip term="Pre-sell" />}</p></div></div>
            </div>
          </div>
          <div className="mt-6 grid gap-5 lg:grid-cols-2">{data.growthPlan.opportunities.map((item) => <OpportunityCard key={item.id} item={item} />)}</div>
        </section>

        <section className="py-4 sm:py-7" aria-labelledby="team-title">
          <div className="max-w-2xl"><div className="text-xs font-semibold uppercase tracking-[.14em]" style={{ color: BRAND_LIGHT }}>One team · One North Star</div><h2 id="team-title" className="mt-3 text-2xl font-semibold sm:text-3xl" style={{ fontFamily: "Kanit, sans-serif" }}>รอบนี้แต่ละทีมทำอะไร</h2><p className="mt-2 text-sm" style={{ color: "var(--ui-text-secondary)" }}>ทุกงานต้องตอบได้ว่า ช่วยให้คนจ่ายกลับมาสร้าง หรือช่วยพารายได้เข้าอย่างไร</p></div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{data.teamActions.map((item, index) => (
            <Panel key={item.team} className="min-h-52 p-5">
              <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[.12em]" style={{ color: BRAND_LIGHT }}>{item.team}</span><span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>0{index + 1}</span></div>
              <h3 className="mt-5 text-lg font-semibold">{item.focus}</h3>
              <p className="mt-2 text-sm leading-6" style={{ color: "var(--ui-text-secondary)" }}>{item.action}{item.team === "Media" && <TermTip term="UTM" />}</p>
              <div className="mt-5 text-xs" style={{ color: "var(--ui-text-muted)" }}>วัด: <b style={{ color: "var(--ui-text-secondary)" }}>{item.measure}</b></div>
            </Panel>
          ))}</div>
        </section>

        {!meeting && (
          <section className="grid gap-5 border-t py-6 text-sm sm:grid-cols-3" style={{ borderColor: "var(--ui-divider)", color: "var(--ui-text-secondary)" }} aria-label="ฐานลูกค้าและวิธีนับ">
            <div><div className="flex items-center gap-2 font-semibold" style={{ color: "var(--ui-text-primary)" }}><Users className="h-4 w-4" />ฐานลูกค้า</div><p className="mt-2 leading-6">จ่ายจริง {number(data.base.activePayingCustomers)} · Trial {number(data.base.trials)} · Free {number(data.base.free)} · เคยจ่าย {number(data.base.lapsed)}</p></div>
            <div><div className="font-semibold" style={{ color: "var(--ui-text-primary)" }}>สินค้า</div><p className="mt-2 leading-6">Studio {number(data.base.directPayers)} คน · Bundle {number(data.base.bundlePayers)} คน · ซื้อเครดิต {number(data.base.creditBuyers)} คน ({money(data.base.creditRevenue)})</p></div>
            <div><div className="font-semibold" style={{ color: "var(--ui-text-primary)" }}>วิธีนับ</div><p className="mt-2 leading-6">ยอดรวมยึดเงินเข้าจริง จำแนกสินค้าจาก Ledger และไม่แสดงค่าธรรมเนียมรับชำระ อัปเดต {new Date(data.range.until).toLocaleString("th-TH")}</p></div>
          </section>
        )}
        {loading && <div className="fixed bottom-5 right-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs shadow-xl" style={{ ...surfaceStyle, color: "var(--ui-text-secondary)" }}><Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: BRAND }} />กำลังอัปเดต</div>}
      </div>
    </main>
  );
}
