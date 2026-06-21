import Link from "next/link";
import {
  Sparkles, ArrowRight, Bot, Mic, Music, Film, Captions, SlidersHorizontal, Flame, Plus,
  CameraOff, Scissors, Languages, Wand2, FileText, Wallet, MousePointerClick, KeyRound,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getFoundingCoupon } from "@/lib/founding";
import { PricingToggle } from "@/components/marketing/pricing-toggle";
import { YouTubeLite } from "@/components/marketing/youtube-lite";
import { Reveal, ContainerScroll, SpotlightCard } from "@/components/marketing/motion-fx";
import { SaleBackground } from "@/components/marketing/marketing-fx";

export const metadata = {
  title: "HERO AI — เปลี่ยนสคริปต์เป็นคลิป อัตโนมัติ",
  description:
    "ระบบตัดต่อวิดีโอ Faceless + AI Avatar พร้อมซับไทยอัตโนมัติ — มีแค่สคริปต์ 1 ชุดก็ได้คลิปพร้อมโพสต์",
  openGraph: {
    title: "HERO AI — เปลี่ยนสคริปต์เป็นคลิป อัตโนมัติ",
    description: "Faceless + AI Avatar + ซับไทยอัตโนมัติ มีแค่สคริปต์ก็ได้คลิปพร้อมโพสต์",
    url: "https://studio.heroaiengine.com",
    type: "website",
  },
};

// Marketing page: tolerate a 60s-stale price/founding count to cut DB load.
export const revalidate = 60;

// Single-accent design system (violet-only, ref-inspired premium look).
const ACCENT = "linear-gradient(120deg,#8b5cf6,#a78bfa)"; // one hue family
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;
const DISPLAY = { fontFamily: "'Anton', sans-serif" } as const; // giant wordmark
const GLASS =
  "rounded-[22px] border border-white/10 bg-white/[0.04] shadow-[0_10px_40px_rgba(0,0,0,0.4)] backdrop-blur-md";
const GLOW = "0 0 34px rgba(139,92,246,.5)";
const EYEBROW =
  "text-center text-[13px] font-semibold uppercase tracking-[.14em] text-violet-300";

async function getPlanPrices() {
  try {
    const rows = await prisma.siteConfig.findMany({
      where: { key: { in: ["plan_pro_price", "plan_business_price"] } },
    });
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      proPrice: parseInt(m.plan_pro_price ?? "599", 10),
      businessPrice: parseInt(m.plan_business_price ?? "990", 10),
    };
  } catch {
    return { proPrice: 599, businessPrice: 990 };
  }
}

// Read-only founding status (no DB writes, no FoundingReservation dependency).
async function getFounding() {
  try {
    const c = await getFoundingCoupon();
    if (!c || c.maxUses <= 0) return null;
    const remaining = Math.max(0, c.maxUses - c.usedCount);
    return { active: remaining > 0, remaining, total: c.maxUses, percentOff: c.percentOff };
  } catch {
    return null;
  }
}

// One consolidated capability grid (merged from the old "what" + "features").
const FEATURES = [
  { icon: Bot, title: "AI Avatar พิธีกร", desc: "พูดทั้งคลิป · เปิด-ปิด · หรือไม่มีเลย (Faceless)" },
  { icon: Captions, title: "ซับไทยตรงเสียงเป๊ะ", desc: "sync ระดับวินาทีจากเสียงจริง ไม่ใช่ AI เดา — เต็มประโยค/คำเด้งไวรัล + สไตล์ซับ 20+ แบบ" },
  { icon: Film, title: "B-roll เปลี่ยนทุก 3–5 วิ", desc: "ภาพ/วิดีโอประกอบ เปลี่ยนตามเนื้อหาอัตโนมัติ" },
  { icon: Mic, title: "เสียงพากย์ AI + เสียงโคลน", desc: "เสียง AI ไทยธรรมชาติ หรือใช้เสียงที่คุณโคลนไว้บน ElevenLabs" },
  { icon: Music, title: "เพลง + Sound FX + ลบพื้นหลัง", desc: "คลังเพลงตามอารมณ์ + อัปโหลดเอง + chromakey ฉากหลัง avatar" },
  { icon: SlidersHorizontal, title: "ตัดต่อในเว็บ + พร้อมโพสต์", desc: "ระบบตัดให้ เข้าไปแก้เอง พรีวิวก่อนโหลด ลง TikTok/Reels แนวตั้งได้เลย" },
];

const STEPS = [
  { n: "01", title: "วางสคริปต์", desc: "paste สคริปต์ที่มีเข้าระบบ" },
  { n: "02", title: "เลือกสไตล์", desc: "Avatar · ซับ · เพลง · B-roll" },
  { n: "03", title: "กดสร้าง", desc: "ระบบตัดต่อให้ พร้อมโพสต์" },
];

// Objection handling — real blockers a Thai faceless creator feels, + how we solve.
const OBJECTIONS = [
  { icon: CameraOff, pain: "ไม่อยากออกกล้อง โชว์หน้า", fix: "ทำคลิป Faceless ได้ 100% หรือใช้ AI Avatar เป็นพิธีกรแทน — ไม่ต้องโชว์หน้าเลย" },
  { icon: Scissors, pain: "ตัดต่อไม่เป็น ไม่มีเวลานั่งตัด", fix: "วางสคริปต์ → ระบบตัด ใส่ซับ ภาพ เพลงให้อัตโนมัติ พร้อมโพสต์" },
  { icon: Languages, pain: "AI ฝรั่งเสียงไทยแข็ง ซับเพี้ยน", fix: "ทำเพื่อภาษาไทยโดยเฉพาะ — เสียงไทยเป็นธรรมชาติ + ซับตรงเสียง ตัดคำถูก" },
  { icon: Wand2, pain: "กลัวคลิปออกมาดูเป็น AI ไม่เนียน", fix: "B-roll เปลี่ยนทุก 3–5 วิ ตามเนื้อหา + ซับจังหวะไวรัล ดูเหมือนตัดมือ" },
  { icon: FileText, pain: "คิดสคริปต์ได้ แต่ทำคลิปไม่เป็น", fix: "มีแค่สคริปต์ก็พอ ที่เหลือระบบจัดการ ไม่ต้องเป็นมือโปร" },
  { icon: Wallet, pain: "จ้างตัดต่อแพง โพสต์ไม่ทัน", fix: "ทำเองวันละหลายคลิป เริ่ม ฿499/เดือน ไม่ต้องจ้างทีม" },
  { icon: MousePointerClick, pain: "ไม่เก่งเทคโนโลยี ใช้ยากไหม", fix: "เริ่มจากวางสคริปต์ กดไม่กี่ขั้น ระบบทำให้หมด ไม่ต้องเรียนรู้อะไรซับซ้อน" },
  { icon: KeyRound, pain: "ต้องตั้ง API key เองยากไหม", fix: "ใช้คีย์ฟรีของคุณเอง (Gemini + Pexels/Pixabay) ตั้ง 5 นาที มีคู่มือพาทีละขั้น" },
];

const FAQS = [
  { q: "ต้องใช้ API key ของตัวเองไหม?", a: "เริ่มด้วย Gemini key (ฟรี) ของคุณก็สร้างคลิปได้เลย — ส่วน AI Avatar / โคลนเสียง ค่อยใส่คีย์ HeyGen / ElevenLabs ของคุณเอง มีคู่มือพาตั้งทีละขั้น" },
  { q: "รายปีจ่ายครั้งเดียวจริงไหม ตัดเงินอัตโนมัติหรือเปล่า?", a: "จ่ายครั้งเดียว ใช้ได้ 1 ปี ไม่มีตัดเงินอัตโนมัติ ครบปีค่อยต่อเองถ้าพอใจ" },
  { q: "จ่ายเงินยังไง?", a: "PromptPay หรือบัตรเครดิต/เดบิต" },
];

// Overall product demo (hero) — landscape
const OVERVIEW_VIDEO = { id: "bnLnNHBAwBo", title: "HERO AI Creator Studio — ดูระบบทำงานจริง" };

// Per-system explainers — landscape, mapped to the headline features
const SYSTEM_VIDEOS = [
  { id: "7_HqwzV9sgI", label: "ระบบ Avatar", desc: "พิธีกร AI พูด/ตัดต่อให้อัตโนมัติ" },
  { id: "COFaBjzgFuk", label: "ระบบซับไทย", desc: "ซับตรงเสียง ไม่ต้องพิมพ์เอง" },
  { id: "Jd84cTVpd8M", label: "ระบบ B-roll", desc: "ภาพประกอบเปลี่ยนตามเนื้อหา" },
];

// Real output samples — vertical Shorts (with vs. without avatar)
const SAMPLE_VIDEOS = [
  { id: "jAo8kE3NQsA", label: "มี Avatar" },
  { id: "mgscenGpyuw", label: "ไม่มี Avatar" },
];

export default async function Home() {
  const [plan, founding] = await Promise.all([getPlanPrices(), getFounding()]);
  const filled = founding ? Math.round(((founding.total - founding.remaining) / founding.total) * 100) : 0;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#06060b] text-[#f4f5ff]" style={{ fontFamily: "'IBM Plex Sans Thai', sans-serif", lineHeight: 1.65 }}>
      {/* animated atmosphere: drifting violet beams + panning grid */}
      <SaleBackground />

      {/* founding bar — server-rendered, only when active */}
      {founding?.active && (
        <div className="sticky top-0 z-50 border-b border-white/10 bg-[rgba(6,6,11,0.72)] py-2.5 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-center gap-3 px-5 text-sm">
            <span className="font-bold" style={HEAD}>HERO AI</span>
            <span className="inline-flex items-center gap-1.5 text-white/70">
              <Flame className="h-4 w-4 text-amber-400" strokeWidth={2.5} aria-hidden /> ราคาผู้ก่อตั้ง {founding.total} คนแรก
            </span>
            <span className="h-[7px] w-[120px] overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full" style={{ width: `${filled}%`, background: ACCENT }} />
            </span>
            <b className="text-violet-300">เหลือ {founding.remaining}/{founding.total}</b>
            <Link href="/register" className="rounded-full px-4 py-1.5 text-sm font-semibold text-white" style={{ background: ACCENT }}>
              รับสิทธิ์
            </Link>
          </div>
        </div>
      )}

      {/* nav — always present */}
      <nav className="relative z-40 mx-auto flex max-w-[1140px] items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: ACCENT, boxShadow: GLOW }}>
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-wide" style={HEAD}>HERO AI</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-white/60 transition-colors hover:text-white">เข้าสู่ระบบ</Link>
          <Link href="/register" className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold text-white" style={{ background: ACCENT }}>
            เริ่มฟรี <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </nav>

      <main>
      {/* hero */}
      <header className="relative px-5 pb-20 pt-16 text-center sm:pt-20">
        <div className="mx-auto max-w-[860px]">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 text-[13px] text-violet-200">
            ✨ สำหรับสาย Faceless &amp; คนทำคอนเทนต์
          </span>
          <h1 className="my-6 text-[40px] font-bold leading-[1.05] sm:text-6xl md:text-[68px]" style={{ ...HEAD, letterSpacing: "-.02em" }}>
            มีแค่ <span className="bg-gradient-to-r from-violet-300 to-violet-400 bg-clip-text text-transparent">สคริปต์ 1 ชุด</span>
            <br />ได้คลิปพร้อมโพสต์ — อัตโนมัติ
          </h1>
          <p className="mx-auto max-w-[640px] text-lg text-[#a7adcc]">
            ระบบตัดต่อวิดีโอ <b className="text-white">Faceless + AI Avatar</b> พร้อมซับไทยอัตโนมัติ — ไม่ต้องออกกล้อง ไม่ต้องตัดต่อเอง
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3.5">
            <Link href="/register" className="inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-base font-semibold text-white" style={{ ...HEAD, background: ACCENT, boxShadow: GLOW }}>
              เริ่มใช้ฟรี <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="inline-flex items-center gap-2 rounded-full border border-white/10 px-7 py-3.5 text-base font-semibold text-white/85 transition-colors hover:bg-white/5">
              เข้าสู่ระบบ
            </Link>
          </div>
          <p className="mt-4 text-sm text-[#9ca0be]">สมัครได้ <b className="text-white/90">PRO ฟรี 7 วัน</b> ทันที · ไม่ใช้บัตร · ยกเลิกเมื่อไหร่ก็ได้</p>
          {/* glowing product demo — hero focal piece w/ 3D scroll tilt */}
          <div className="relative mx-auto mt-16 max-w-[900px]">
            <div aria-hidden className="absolute -inset-x-6 -top-10 bottom-0 opacity-70 blur-2xl" style={{ background: "radial-gradient(55% 60% at 50% 0%, rgba(139,92,246,.45), transparent 70%)" }} />
            <ContainerScroll>
              <div className="relative rounded-[24px] border border-violet-400/25 bg-white/[0.02] p-2 shadow-[0_0_90px_-24px_rgba(139,92,246,.7)]">
                <YouTubeLite id={OVERVIEW_VIDEO.id} title={OVERVIEW_VIDEO.title} />
              </div>
            </ContainerScroll>
          </div>
        </div>
      </header>

      {/* one consolidated feature grid */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[1140px]">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ทำอะไรได้บ้าง</p>
            <h2 className="mx-auto mt-3 max-w-[680px] text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>ขั้นตอนซ้ำๆ ที่เคยกินเวลา ระบบทำให้หมด</h2>
          </Reveal>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, desc }, i) => (
              <Reveal key={title} delay={i * 0.07} className="h-full">
                <SpotlightCard className={`${GLASS} h-full p-7 transition-colors hover:border-violet-400/40`}>
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] border border-violet-400/20 bg-violet-500/10">
                    <Icon className="h-5 w-5 text-violet-300" strokeWidth={2.2} aria-hidden />
                  </div>
                  <h3 className="text-lg font-semibold" style={HEAD}>{title}</h3>
                  <p className="mt-1.5 text-sm text-[#a7adcc]">{desc}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* see each system in action */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[1140px]">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ดูระบบจริง</p>
            <h2 className="mt-3 text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>เห็นแต่ละระบบทำงานจริง</h2>
          </Reveal>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {SYSTEM_VIDEOS.map(({ id, label, desc }, i) => (
              <Reveal key={id} delay={i * 0.1}>
                <div className="rounded-[20px] border border-white/10 bg-white/[0.02] p-1.5 shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
                  <YouTubeLite id={id} title={label} overlayTitle={false} />
                </div>
                <h3 className="mt-4 text-lg font-semibold" style={HEAD}>{label}</h3>
                <p className="mt-0.5 text-sm text-[#a7adcc]">{desc}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[940px]">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ง่ายใน 3 ขั้น</p>
            <h2 className="mt-3 text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>เริ่มจาก &quot;มีสคริปต์&quot; เท่านั้น</h2>
          </Reveal>
          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {STEPS.map(({ n, title, desc }, i) => (
              <Reveal key={n} delay={i * 0.1} className="h-full">
                <div className={`${GLASS} h-full p-7 text-center`}>
                  <div className="text-[44px] font-bold leading-none text-violet-300/90" style={DISPLAY}>{n}</div>
                  <h3 className="mt-3 text-lg font-semibold" style={HEAD}>{title}</h3>
                  <p className="mt-1 text-sm text-[#a7adcc]">{desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* real output samples (vertical shorts) — fanned cards */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[1140px]">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ตัวอย่างผลงาน</p>
            <h2 className="mt-3 text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>คลิปที่ระบบสร้างจริง</h2>
            <p className="mx-auto mt-4 max-w-[560px] text-center text-[#a7adcc]">ผลลัพธ์จริงจากสคริปต์ชุดเดียว — เลือกได้ทั้งมีและไม่มี Avatar</p>
          </Reveal>
          <div className="mx-auto mt-14 flex max-w-[640px] flex-col items-center justify-center gap-8 sm:flex-row sm:gap-10">
            {SAMPLE_VIDEOS.map(({ id, label }, i) => (
              <Reveal
                key={id}
                delay={i * 0.12}
                className={`w-full max-w-[256px] transition-transform duration-300 sm:hover:rotate-0 ${i === 0 ? "sm:rotate-[-5deg]" : "sm:translate-y-6 sm:rotate-[5deg]"}`}
              >
                <div className="rounded-[24px] border border-violet-400/20 bg-white/[0.03] p-2 shadow-[0_24px_70px_-22px_rgba(139,92,246,.55)]">
                  <YouTubeLite id={id} title={label} vertical overlayTitle={false} />
                </div>
                <p className="mt-4 text-center text-sm font-semibold text-white" style={HEAD}>{label}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* objection handling — pain → how we solve it */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[1140px]">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ก่อนตัดสินใจ</p>
            <h2 className="mt-3 text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>กังวลแบบนี้อยู่ใช่ไหม?</h2>
          </Reveal>
          <div className="mx-auto mt-12 grid max-w-[920px] gap-4 md:grid-cols-2">
            {OBJECTIONS.map(({ icon: Icon, pain, fix }, i) => (
              <Reveal key={pain} delay={i * 0.06} className="h-full">
                <SpotlightCard className={`${GLASS} flex h-full flex-col p-6`}>
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] border border-violet-400/20 bg-violet-500/10">
                    <Icon className="h-5 w-5 text-violet-300" strokeWidth={2.2} aria-hidden />
                  </div>
                  <h3 className="text-[15px] font-semibold text-white" style={HEAD}>{pain}</h3>
                  <p className="mt-2 text-sm text-[#a7adcc]">{fix}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[1140px] text-center">
          <Reveal>
            <p className={EYEBROW} style={HEAD}>ราคา</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-[40px]" style={HEAD}>เลือกแพ็กที่ใช่</h2>
          </Reveal>
          <PricingToggle proPrice={plan.proPrice} businessPrice={plan.businessPrice} founding={founding} />
        </div>
      </section>

      {/* faq — accordion */}
      <section className="relative px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-[780px]">
          <Reveal>
            <h2 className="text-center text-3xl font-bold sm:text-[40px]" style={HEAD}>คำถามที่พบบ่อย</h2>
          </Reveal>
          <div className="mt-10 space-y-3">
            {FAQS.map(({ q, a }, i) => (
              <Reveal key={q} delay={i * 0.06}>
                <details className={`${GLASS} group overflow-hidden p-0`}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 font-semibold [&::-webkit-details-marker]:hidden" style={HEAD}>
                    {q}
                    <Plus className="h-5 w-5 shrink-0 text-violet-300 transition-transform duration-200 group-open:rotate-45" strokeWidth={2.5} aria-hidden />
                  </summary>
                  <p className="px-5 pb-5 text-sm text-[#a7adcc]">{a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      </main>

      {/* final CTA + giant wordmark signature */}
      <footer className="relative border-t border-white/10 px-5 pt-20 text-center">
        <Reveal className="mx-auto max-w-[820px]">
          <h2 className="text-3xl font-bold sm:text-[40px]" style={HEAD}>เริ่มทำคลิปแรกของคุณวันนี้</h2>
          {founding?.active ? (
            <p className="mx-auto mt-4 max-w-[560px] text-[#a7adcc]">🔥 ราคาผู้ก่อตั้ง เหลือ {founding.remaining}/{founding.total} ที่</p>
          ) : (
            <p className="mx-auto mt-4 max-w-[560px] text-[#a7adcc]">มีแค่สคริปต์ ก็ได้คลิปพร้อมโพสต์ — เริ่มฟรีได้เลย</p>
          )}
          <Link href="/register" className="mt-7 inline-flex items-center gap-2 rounded-full px-9 py-4 text-lg font-semibold text-white" style={{ ...HEAD, background: ACCENT, boxShadow: GLOW }}>
            เริ่มใช้ฟรี <ArrowRight className="h-5 w-5" />
          </Link>
          <p className="mt-4 text-sm text-[#9ca0be]">PRO ฟรี 7 วัน · ไม่ใช้บัตร · ตั้งคีย์ฟรี 5 นาที มีคู่มือพา</p>
        </Reveal>

        {/* signature: giant glowing wordmark */}
        <div aria-hidden className="relative mt-20 select-none overflow-hidden">
          <div className="absolute left-1/2 top-1/2 h-[40%] w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-[90px]" style={{ background: "radial-gradient(circle,#6d28d9,transparent 65%)" }} />
          <div
            className="relative text-center leading-[0.8]"
            style={{
              ...DISPLAY,
              fontSize: "clamp(72px, 21vw, 280px)",
              letterSpacing: ".01em",
              background: "linear-gradient(180deg, rgba(167,139,250,.55), rgba(139,92,246,.04))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            HERO AI
          </div>
        </div>
        <p className="pb-10 text-sm text-[#a7adcc]">© 2026 HERO AI</p>
      </footer>
    </div>
  );
}
