import Link from "next/link";
import {
  Sparkles, ArrowRight, Bot, Mic, Music, Film, Captions, Share2, Flame,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getFoundingCoupon } from "@/lib/founding";
import { PricingToggle } from "@/components/marketing/pricing-toggle";

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

const BRAND = "linear-gradient(120deg,#8b5cf6,#22d3ee)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;
const GLASS =
  "rounded-[22px] border border-white/10 bg-white/[0.045] shadow-[0_10px_40px_rgba(0,0,0,0.4)] backdrop-blur-md";

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

const WHAT = [
  { icon: Captions, title: "ซับไทยอัตโนมัติ", desc: "ยาว หรือ keyword ไวรัล" },
  { icon: Film, title: "B-roll 3–5 วิ", desc: "เปลี่ยนภาพให้อัตโนมัติ" },
  { icon: Bot, title: "มี/ไม่มี Avatar ก็ได้", desc: "พูดทั้งคลิป · เฉพาะเปิด-ปิด · หรือไม่มีเลย" },
];

const FEATURES = [
  { icon: Bot, title: "AI Avatar", desc: "สร้าง + ตัดต่อคลิป Avatar อัตโนมัติ" },
  { icon: Mic, title: "โคลนเสียงตัวเอง", desc: "ให้ Avatar พูดด้วยเสียงคุณ" },
  { icon: Music, title: "เพลง + เสียง Effect", desc: "ใส่ดนตรีประกอบ เลือกได้" },
  { icon: Film, title: "B-roll ภาพ/วิดีโอ", desc: "ภาพประกอบเปลี่ยนตามเนื้อหา" },
  { icon: Captions, title: "ซับไทย 2 สไตล์", desc: "เต็มประโยค หรือ keyword สั้น" },
  { icon: Share2, title: "พร้อมโพสต์", desc: "แนวตั้ง ลง TikTok/Reels ได้เลย" },
];

const STEPS = [
  { n: "01", title: "วางสคริปต์", desc: "paste สคริปต์ที่มีเข้าระบบ" },
  { n: "02", title: "เลือกสไตล์", desc: "Avatar · ซับ · เพลง · B-roll" },
  { n: "03", title: "กดสร้าง", desc: "ระบบตัดต่อให้ พร้อมโพสต์" },
];

const FAQS = [
  { q: "รายปีจ่ายครั้งเดียวจริงไหม ตัดเงินอัตโนมัติหรือเปล่า?", a: "จ่ายครั้งเดียว ใช้ได้ 1 ปี ไม่มีตัดเงินอัตโนมัติ ครบปีค่อยต่อเองถ้าพอใจ" },
  { q: "ไม่ถนัดเทคโนโลยี ใช้ได้ไหม?", a: "เริ่มจากสคริปต์ที่มี → กดไม่กี่ขั้น ระบบตัดต่อให้" },
  { q: "จ่ายเงินยังไง?", a: "PromptPay หรือบัตรเครดิต/เดบิต" },
  { q: "ไม่พอใจได้เงินคืนไหม?", a: "คืนเงินภายใน 7 วัน" },
];

export default async function Home() {
  const [plan, founding] = await Promise.all([getPlanPrices(), getFounding()]);
  const filled = founding ? Math.round(((founding.total - founding.remaining) / founding.total) * 100) : 0;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#07070f] text-[#f4f5ff]" style={{ fontFamily: "'IBM Plex Sans Thai', sans-serif", lineHeight: 1.65 }}>
      {/* aurora (static glows) */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-[8vw] -top-[12vw] h-[46vw] w-[46vw] rounded-full opacity-40 blur-[110px]" style={{ background: "radial-gradient(circle,#8b5cf6,transparent 60%)" }} />
        <div className="absolute -right-[8vw] -bottom-[14vw] h-[42vw] w-[42vw] rounded-full opacity-40 blur-[110px]" style={{ background: "radial-gradient(circle,#22d3ee,transparent 60%)" }} />
        <div className="absolute left-1/2 top-[38%] h-[30vw] w-[30vw] rounded-full opacity-20 blur-[110px]" style={{ background: "radial-gradient(circle,#d946ef,transparent 60%)" }} />
      </div>

      {/* founding bar — server-rendered, only when active */}
      {founding?.active && (
        <div className="sticky top-0 z-50 border-b border-white/10 bg-[rgba(7,7,15,0.72)] py-2.5 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-center gap-3 px-5 text-sm">
            <span className="font-bold" style={HEAD}>HERO AI</span>
            <span className="inline-flex items-center gap-1.5 text-white/70">
              <Flame className="h-4 w-4 text-amber-400" strokeWidth={2.5} aria-hidden /> ราคาผู้ก่อตั้ง {founding.total} คนแรก
            </span>
            <span className="h-[7px] w-[120px] overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full" style={{ width: `${filled}%`, background: BRAND }} />
            </span>
            <b className="text-cyan-300">เหลือ {founding.remaining}/{founding.total}</b>
            <Link href="/register" className="rounded-full px-4 py-1.5 text-sm font-semibold text-white" style={{ background: BRAND }}>
              รับสิทธิ์
            </Link>
          </div>
        </div>
      )}

      {/* nav — always present */}
      <nav className="relative z-40 mx-auto flex max-w-[1140px] items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: BRAND }}>
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold" style={HEAD}>HERO AI</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-white/60 transition-colors hover:text-white">เข้าสู่ระบบ</Link>
          <Link href="/register" className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg,#7c3aed,#06b6d4)" }}>
            เริ่มฟรี <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </nav>

      <main>
      {/* hero */}
      <header className="relative px-5 pb-14 pt-12 text-center">
        <div className="mx-auto max-w-[820px]">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/35 bg-cyan-400/10 px-4 py-1.5 text-[13px] text-cyan-200">
            ✨ สำหรับสาย Faceless &amp; คนทำคอนเทนต์
          </span>
          <h1 className="my-5 text-4xl font-bold leading-[1.08] sm:text-5xl md:text-6xl" style={{ ...HEAD, letterSpacing: "-.01em" }}>
            มีแค่ <span className="bg-gradient-to-r from-violet-300 via-cyan-300 to-fuchsia-300 bg-clip-text text-transparent">สคริปต์ 1 ชุด</span>
            <br />ได้คลิปพร้อมโพสต์ — อัตโนมัติ
          </h1>
          <p className="mx-auto max-w-[660px] text-lg text-[#a7adcc]">
            ระบบตัดต่อวิดีโอ <b className="text-white">Faceless + AI Avatar</b> พร้อมซับไทยอัตโนมัติ — ไม่ต้องออกกล้อง ไม่ต้องตัดต่อเอง
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3.5">
            <Link href="/register" className="inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-base font-semibold text-white" style={{ ...HEAD, background: BRAND, boxShadow: "0 0 34px rgba(139,92,246,.5)" }}>
              เริ่มใช้ฟรี <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="inline-flex items-center gap-2 rounded-full border border-white/10 px-7 py-3.5 text-base font-semibold text-white/85 transition-colors hover:bg-white/5">
              เข้าสู่ระบบ
            </Link>
          </div>
        </div>
      </header>

      {/* what it does */}
      <section className="relative px-5 py-16">
        <div className="mx-auto max-w-[1140px]">
          <p className="text-center text-[13px] font-semibold uppercase tracking-[.12em] text-cyan-300" style={HEAD}>ทำอะไรได้บ้าง</p>
          <h2 className="mt-2 text-center text-3xl font-bold sm:text-4xl" style={HEAD}>ขั้นตอนซ้ำๆ ที่เคยกินเวลา ระบบทำให้หมด</h2>
          <div className="mt-9 grid gap-4 sm:grid-cols-3">
            {WHAT.map(({ icon: Icon, title, desc }) => (
              <div key={title} className={`${GLASS} p-6`}>
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: BRAND }}>
                  <Icon className="h-5 w-5 text-white" strokeWidth={2.2} aria-hidden />
                </div>
                <h3 className="text-lg font-semibold" style={HEAD}>{title}</h3>
                <p className="mt-1 text-sm text-[#a7adcc]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* feature grid */}
      <section className="relative px-5 py-16">
        <div className="mx-auto max-w-[1140px]">
          <h2 className="text-center text-3xl font-bold sm:text-4xl" style={HEAD}>ครบทุกอย่างในที่เดียว</h2>
          <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div key={title} className={`${GLASS} p-6`}>
                <div className="mb-3.5 flex h-12 w-12 items-center justify-center rounded-[14px] border border-white/10 bg-black/20">
                  <Icon className="h-5 w-5 text-cyan-300" strokeWidth={2.2} aria-hidden />
                </div>
                <h3 className="text-lg font-semibold" style={HEAD}>{title}</h3>
                <p className="mt-1.5 text-sm text-[#a7adcc]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="relative px-5 py-16">
        <div className="mx-auto max-w-[920px]">
          <p className="text-center text-[13px] font-semibold uppercase tracking-[.12em] text-cyan-300" style={HEAD}>ง่ายใน 3 ขั้น</p>
          <h2 className="mt-2 text-center text-3xl font-bold sm:text-4xl" style={HEAD}>เริ่มจาก &quot;มีสคริปต์&quot; เท่านั้น</h2>
          <div className="mt-9 grid gap-4 sm:grid-cols-3">
            {STEPS.map(({ n, title, desc }) => (
              <div key={n} className={`${GLASS} p-6 text-center`}>
                <div className="bg-gradient-to-r from-violet-300 to-cyan-300 bg-clip-text text-[40px] font-bold leading-none text-transparent" style={HEAD}>{n}</div>
                <h3 className="mt-2.5 text-lg font-semibold" style={HEAD}>{title}</h3>
                <p className="mt-1 text-sm text-[#a7adcc]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" className="relative px-5 py-16">
        <div className="mx-auto max-w-[1140px] text-center">
          <p className="text-[13px] font-semibold uppercase tracking-[.12em] text-cyan-300" style={HEAD}>ราคา</p>
          <h2 className="mt-2 text-3xl font-bold sm:text-4xl" style={HEAD}>เลือกแพ็กที่ใช่</h2>
          <PricingToggle proPrice={plan.proPrice} businessPrice={plan.businessPrice} founding={founding} />
        </div>
      </section>

      {/* faq */}
      <section className="relative px-5 py-16">
        <div className="mx-auto max-w-[780px]">
          <h2 className="text-center text-3xl font-bold sm:text-4xl" style={HEAD}>คำถามที่พบบ่อย</h2>
          <div className="mt-8 space-y-3">
            {FAQS.map(({ q, a }) => (
              <div key={q} className={`${GLASS} p-5`}>
                <p className="font-semibold" style={HEAD}>{q}</p>
                <p className="mt-1.5 text-sm text-[#a7adcc]">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      </main>

      {/* final CTA */}
      <footer className="relative border-t border-white/10 px-5 py-20 text-center">
        <div className="mx-auto max-w-[820px]">
          <h2 className="text-3xl font-bold sm:text-4xl" style={HEAD}>เริ่มทำคลิปแรกของคุณวันนี้</h2>
          {founding?.active ? (
            <p className="mx-auto mt-3.5 max-w-[560px] text-[#a7adcc]">🔥 ราคาผู้ก่อตั้ง เหลือ {founding.remaining}/{founding.total} ที่</p>
          ) : (
            <p className="mx-auto mt-3.5 max-w-[560px] text-[#a7adcc]">มีแค่สคริปต์ ก็ได้คลิปพร้อมโพสต์ — เริ่มฟรีได้เลย</p>
          )}
          <Link href="/register" className="mt-6 inline-flex items-center gap-2 rounded-full px-9 py-4 text-lg font-semibold text-white" style={{ ...HEAD, background: BRAND, boxShadow: "0 0 34px rgba(139,92,246,.5)" }}>
            เริ่มใช้ฟรี <ArrowRight className="h-5 w-5" />
          </Link>
          <p className="mt-5 text-sm text-[#a7adcc]">© 2026 HERO AI</p>
        </div>
      </footer>
    </div>
  );
}
