import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CirclePlay,
  FileText,
  Flame,
  Images,
  Layers3,
  Plus,
  Sparkles,
  SwatchBook,
  WandSparkles,
} from "lucide-react";
import { PricingToggle } from "@/components/marketing/pricing-toggle";
import { ShowcaseClip } from "@/components/marketing/showcase-clip";
import { SaleBackground } from "@/components/marketing/marketing-fx";
import { ContainerScroll, Reveal, SpotlightCard } from "@/components/marketing/motion-fx";
import { StudioWorkbench } from "@/components/marketing/studio-workbench";
import { ProductFeatureVisual } from "@/components/marketing/product-feature-visual";
import { MobileStickyCta } from "@/components/marketing/mobile-sticky-cta";
import { getFoundingCoupon } from "@/lib/founding";
import { getPlanConfig } from "@/lib/plan-config";

export const metadata = {
  title: "HERO AI Creator Studio — จากไอเดีย ถึงคลิปพร้อมโพสต์",
  description:
    "ทีมคอนเทนต์ AI ในระบบเดียว ช่วยคิด Hook เขียนสคริปต์ สร้างภาพแบรนด์ พากย์เสียง ใส่ B-roll ซับไทย และตัดต่อคลิปพร้อมโพสต์",
  openGraph: {
    title: "HERO AI Creator Studio — จากไอเดีย ถึงคลิปพร้อมโพสต์",
    description: "Hero Script, Brand Visual, AI Studio และ Video Editor สำหรับครีเอเตอร์ไทย ใน workflow เดียว",
    url: "https://studio.heroaiengine.com",
    type: "website",
  },
};

export const revalidate = 60;

const ACCENT = "linear-gradient(135deg,#9D7BFF 0%,#7857F6 55%,#6844EF 100%)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;
const BODY = { fontFamily: "'IBM Plex Sans Thai', sans-serif" } as const;

async function getFounding() {
  try {
    const coupon = await getFoundingCoupon();
    if (!coupon || coupon.maxUses <= 0) return null;
    const remaining = Math.max(0, coupon.maxUses - coupon.usedCount);
    return {
      active: remaining > 0,
      remaining,
      total: coupon.maxUses,
      percentOff: coupon.percentOff,
    };
  } catch {
    return null;
  }
}

const MANAGED = process.env.MANAGED_GEMINI === "1";
const MINUTE_QUOTA = process.env.MINUTE_QUOTA === "1";

const PRODUCT_PILLARS = [
  {
    id: "script",
    eyebrow: "01 · HERO SCRIPT",
    title: "เริ่มได้ตั้งแต่ยังมีแค่หัวข้อ",
    desc: "แตกมุม เลือก Hook และเขียนสคริปต์ภาษาไทยให้ครบใน flow เดียว พร้อมส่งบริบทต่อไปยังหน้าตัดต่อทันที",
    icon: FileText,
    chips: ["Hook หลายมุม", "สคริปต์ไทยธรรมชาติ", "จำ Brand Profile"],
    signal: "TOPIC → HOOK → SCRIPT",
  },
  {
    id: "visual",
    eyebrow: "02 · BRAND VISUAL",
    title: "ทุกซีนพูดภาษาภาพของแบรนด์เดียวกัน",
    desc: "เลือก Visual Format ครั้งเดียว ระบบคุมทิศทางภาพทั้งคลิป สร้างใหม่เฉพาะซีน หรือเปลี่ยน Stock เป็นภาพ AI ได้โดยไม่ต้องเริ่มงานใหม่",
    icon: SwatchBook,
    chips: ["5 Visual Formats", "ภาพต่อเนื่องทั้งเรื่อง", "Reroll รายซีน"],
    signal: "BRAND → SCENE → CONSISTENCY",
  },
  {
    id: "editor",
    eyebrow: "03 · VIDEO EDITOR",
    title: "ระบบลงแรงให้ก่อน คุณคุมจังหวะสุดท้าย",
    desc: "ซับไทยตรงเสียง B-roll, AI Avatar, Headline Hook, เพลง และ Timeline อยู่ใน Editor เดียว ปรับต่อได้แม้เรนเดอร์แล้ว",
    icon: WandSparkles,
    chips: ["ซับตรงเสียง", "AutoMix + B-roll", "กลับมาแก้หลัง Export"],
    signal: "ASSEMBLE → REFINE → EXPORT",
  },
  {
    id: "studio",
    eyebrow: "04 · AI STUDIO",
    title: "ภาพและเสียงพร้อมใช้ ไม่ต้องสลับหลายแอป",
    desc: "สร้าง Hero AI Image และ Hero Voice จากพื้นที่เดียว แล้วหยิบกลับมาใช้ในโปรเจกต์ได้ทันที ลดงานส่งไฟล์และบริบทที่หล่นหายระหว่างทาง",
    icon: Images,
    chips: ["Hero AI Image", "Hero Voice", "พร้อมใช้ในโปรเจกต์"],
    signal: "IMAGE + VOICE → PROJECT",
  },
] as const;

const VISUAL_FORMATS = [
  { src: "/brand-visual-formats/cinematic-realism.webp", name: "Cinematic Realism", note: "สมจริง · มีมิติ" },
  { src: "/brand-visual-formats/simple-editorial-story.webp", name: "Editorial Story", note: "เรียบ · เล่าเรื่องชัด" },
  { src: "/brand-visual-formats/dramatic-comic.webp", name: "Dramatic Comic", note: "พลังสูง · สะดุดตา" },
  { src: "/brand-visual-formats/clear-infographic.webp", name: "Clear Infographic", note: "ความรู้ · เข้าใจง่าย" },
  { src: "/brand-visual-formats/retro-story.webp", name: "Retro Story", note: "อบอุ่น · มีคาแรกเตอร์" },
] as const;

const SHOWCASE = [
  { src: "/showcase/showcase-1.mp4", poster: "/showcase/showcase-1.jpg", tag: "เล่าเรื่องสร้างเพจ", detail: "AI Avatar · ซับคำเด้ง" },
  { src: "/showcase/showcase-3.mp4", poster: "/showcase/showcase-3.jpg", tag: "แรงบันดาลใจ", detail: "Faceless · B-roll ซีเนมาติก" },
  { src: "/showcase/showcase-2.mp4", poster: "/showcase/showcase-2.jpg", tag: "ไลฟ์สไตล์", detail: "Faceless · ซับตรงเสียง" },
] as const;

const STEPS = [
  { n: "01", title: "ใส่หัวข้อหรือสคริปต์", desc: "เริ่มจากประโยคเดียว หรือใช้สคริปต์ที่มีอยู่แล้วก็ได้" },
  { n: "02", title: "เลือกตัวตนของคลิป", desc: "ตั้งภาพ เสียง Avatar ซับ และจังหวะให้ตรงแบรนด์" },
  { n: "03", title: "สร้าง ปรับ แล้วโพสต์", desc: "ระบบประกอบให้ก่อน คุณแก้รายซีนและส่งออกเมื่อพร้อม" },
] as const;

const FAQS = [
  {
    q: "ต้องมีสคริปต์ก่อนหรือเปล่า?",
    a: "ไม่ต้อง เริ่มจากหัวข้อหรือไอเดียสั้นๆ ใน Hero Script ได้ ระบบช่วยคิด Hook และร่างสคริปต์ให้ หรือจะนำสคริปต์เดิมมาใช้ก็ได้",
  },
  {
    q: "ทำคลิปโดยไม่ออกกล้องได้ไหม?",
    a: "ได้ คุณทำแบบ Faceless เต็มรูปแบบ ใช้ AI Avatar เป็นพิธีกร หรือผสมทั้งสองแบบในคลิปเดียวกันได้",
  },
  {
    q: "สร้างเสร็จแล้ว ยังกลับมาแก้ได้ไหม?",
    a: "ได้ คุณกลับเข้า Editor เพื่อแก้ข้อความ ซับ ภาพ B-roll เพลง จังหวะ และสร้างภาพใหม่เฉพาะซีนได้ โดยไม่ต้องเริ่มโปรเจกต์ใหม่",
  },
  {
    q: "ต้องตั้ง API key เองไหม?",
    a: MANAGED
      ? "AI หลักระบบดูแลให้ ไม่ต้องใส่ Gemini key เอง ส่วนบริการเสริมอย่าง AI Avatar หรือเสียงโคลน สามารถเชื่อมบัญชีของคุณเพิ่มภายหลังได้"
      : "เริ่มด้วย Gemini key ฟรีของคุณได้ ส่วน AI Avatar หรือเสียงโคลนเชื่อมเพิ่มภายหลังได้ มีคู่มือพาตั้งค่าทีละขั้น",
  },
  {
    q: "ทดลองใช้ฟรี 7 วัน ได้โควต้าเท่าไร?",
    a: MINUTE_QUOTA
      ? "ทดลองฟีเจอร์ Pro ได้ 7 วัน โดยมีโควต้าเรนเดอร์รวม 15 นาที ไม่ต้องใช้บัตร หลังหมดทดลองระบบจะกลับเป็นแผน Free โดยอัตโนมัติ"
      : "ทดลองฟีเจอร์ Pro ได้ 7 วันโดยไม่ต้องใช้บัตร หลังหมดทดลองระบบจะกลับเป็นแผน Free โดยอัตโนมัติ",
  },
  {
    q: "แพ็กรายปีตัดเงินอัตโนมัติไหม?",
    a: "ขึ้นอยู่กับวิธีชำระ: PromptPay รายปีเป็นการจ่ายครั้งเดียวและไม่ต่ออัตโนมัติ ส่วนบัตรรายปีเป็นสมาชิกแบบต่ออัตโนมัติและยกเลิกได้จาก Settings → Billing",
  },
] as const;

export default async function Home() {
  const [plans, founding] = await Promise.all([getPlanConfig(), getFounding()]);
  const filled = founding ? Math.round(((founding.total - founding.remaining) / founding.total) * 100) : 0;

  return (
    <div
      className="sale-v2 relative min-h-screen overflow-x-hidden bg-[#08070c] text-[#f7f4ff] selection:bg-violet-400/30 selection:text-white"
      style={BODY}
    >
      <SaleBackground />

      {founding?.active && (
        <div className="founder-glow sticky top-0 z-50 border-b border-violet-300/15 bg-[#0d0a14]/92 backdrop-blur-xl">
          <div className="mx-auto flex min-h-10 max-w-[1200px] items-center justify-center gap-2.5 px-4 py-1.5 text-[12px] sm:text-[13px]">
            <Flame className="h-3.5 w-3.5 shrink-0 text-amber-300" strokeWidth={2.4} aria-hidden />
            <span className="font-semibold text-white">Founding Access</span>
            <span className="hidden text-white/48 sm:inline">·</span>
            <span className="hidden text-white/62 sm:inline">สิทธิ์ราคาผู้ก่อตั้ง {founding.total} คนแรก</span>
            <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-white/10 md:block">
              <span className="founder-bar-shimmer relative block h-full rounded-full bg-violet-400" style={{ width: `${filled}%` }} />
            </span>
            <b className="text-violet-200">เหลือ {founding.remaining}/{founding.total}</b>
            <Link href="/register" className="ml-1 inline-flex min-h-11 items-center gap-1 font-semibold text-white underline decoration-violet-400 underline-offset-4 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
              รับสิทธิ์ <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        </div>
      )}

      <nav className="relative z-20 mx-auto flex max-w-[1200px] items-center justify-between px-5 py-5 lg:px-7">
        <Link href="/" className="flex min-h-11 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300" aria-label="HERO AI Creator Studio หน้าแรก">
          <Image src="/logo.svg" alt="" width={38} height={38} className="rounded-[11px] shadow-[0_0_28px_-5px_rgba(139,92,246,.8)]" />
          <span className="text-[13px] font-bold tracking-[.04em] text-white" style={HEAD}>
            HERO AI <span className="hidden font-medium text-white/44 sm:inline">CREATOR STUDIO</span>
          </span>
        </Link>
        <div className="hidden items-center gap-7 text-[13px] text-white/56 md:flex">
          <Link href="#product" className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white">ระบบ</Link>
          <Link href="#outputs" className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white">ผลงาน</Link>
          <Link href="#pricing" className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white">ราคา</Link>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/login" className="hidden min-h-11 items-center text-[13px] font-medium text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white sm:inline-flex">เข้าสู่ระบบ</Link>
          <Link href="/register" className="sale-v2-cta inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08070c] sm:px-4" style={{ background: ACCENT }}>
            สร้างคลิปฟรี <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </nav>

      <main className="relative z-10">
        <header className="px-5 pb-20 pt-8 sm:pb-24 sm:pt-20 lg:px-7 lg:pb-32 lg:pt-24">
          <div className="mx-auto grid max-w-[1200px] items-center gap-14 lg:grid-cols-[.83fr_1.17fr] lg:gap-12">
            <Reveal y={16}>
              <div className="max-w-[560px]">
                <div className="mb-7 inline-flex items-center gap-2 border-l-2 border-violet-400 pl-3 text-[11px] font-semibold uppercase tracking-[.16em] text-violet-200/80">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> AI Content Workflow · Built for Thai Creators
                </div>
                <h1 className="text-[43px] font-bold leading-[1.04] tracking-[-.035em] text-white sm:text-[58px] lg:text-[64px]" style={HEAD}>
                  จากไอเดีย<br />หนึ่งบรรทัด<br />ถึงคลิป
                  <span className="sale-v2-gradient-text">พร้อมโพสต์</span>
                </h1>
                <p className="mt-7 max-w-[52ch] text-[16px] leading-7 text-[#b6afc3] sm:text-[17px]">
                  ทีมคอนเทนต์ AI ของคุณในระบบเดียว—ช่วยคิด Hook เขียนสคริปต์ สร้างภาพให้ตรงแบรนด์ พากย์เสียง ใส่ B-roll ซับไทย และตัดต่อจนจบ
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Link href="/register" className="sale-v2-cta inline-flex min-h-13 items-center gap-2 rounded-[14px] px-6 text-[15px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08070c]" style={{ ...HEAD, background: ACCENT }}>
                    สร้างคลิปแรกฟรี <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                  <Link href="#outputs" className="inline-flex min-h-13 items-center gap-2 rounded-[14px] border border-white/12 bg-white/[0.025] px-5 text-[15px] font-medium text-white/78 transition-colors hover:border-white/25 hover:bg-white/[0.055] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
                    <CirclePlay className="h-4 w-4 text-violet-300" aria-hidden /> ดูผลงานจริง
                  </Link>
                </div>
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-white/48">
                  {[MINUTE_QUOTA ? "PRO ฟรี 7 วัน · 15 นาที" : "PRO ฟรี 7 วัน", "ไม่ใช้บัตร", MANAGED ? "AI หลักระบบดูแลให้" : "มีคู่มือตั้งค่าทีละขั้น"].map((item) => (
                    <span key={item} className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-300/80" strokeWidth={2.5} aria-hidden /> {item}</span>
                  ))}
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.12} y={24}>
              <ContainerScroll className="sale-v2-workbench-frame">
                <StudioWorkbench />
              </ContainerScroll>
            </Reveal>
          </div>

          <div className="sale-v2-flowband relative mx-auto mt-20 max-w-[1200px] overflow-hidden border-y border-white/[0.075] py-5 sm:mt-24">
            <span className="sale-v2-flowpulse absolute inset-y-0 left-0 w-40" aria-hidden />
            <div className="relative grid grid-cols-2 gap-y-5 text-center sm:grid-cols-4">
              {["Hero Script", "Brand Visual", "Video Editor", "AI Studio"].map((item, index) => (
                <div key={item} className="group flex items-center justify-center gap-2.5 text-[11px] font-semibold uppercase tracking-[.12em] text-white/52 sm:border-r sm:border-white/[0.07] sm:last:border-r-0">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-violet-300/25 bg-violet-400/[0.08] font-mono text-[8px] text-violet-200">0{index + 1}</span>
                  <span className="transition-colors group-hover:text-white">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </header>

        <section className="border-y border-white/[0.06] bg-[#0b0910]/72 px-5 py-20 sm:py-32 lg:px-7">
          <Reveal>
            <div className="mx-auto grid max-w-[1200px] gap-7 lg:grid-cols-[.48fr_1fr] lg:items-end">
              <p className="sale-v2-eyebrow">ไม่ใช่แค่ AI ตัดคลิป</p>
              <h2 className="max-w-[820px] text-3xl font-semibold leading-[1.22] tracking-[-.025em] text-white sm:text-[46px]" style={HEAD}>แต่คือ workflow ที่ส่งต่อความคิดและตัวตนของแบรนด์ไปถึงทุกซีน</h2>
            </div>
          </Reveal>
        </section>

        <section id="product" className="relative scroll-mt-10 overflow-hidden px-5 py-20 sm:py-32 lg:px-7">
          <div aria-hidden className="absolute left-1/2 top-44 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-violet-700/[0.07] blur-[130px]" />
          <div className="relative mx-auto max-w-[1200px]">
            <Reveal>
              <div className="grid gap-8 border-b border-white/10 pb-12 md:grid-cols-[.72fr_1fr] md:items-end">
                <div>
                  <p className="sale-v2-eyebrow">ONE CONNECTED SYSTEM</p>
                  <h2 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-[-.025em] text-white sm:text-[48px]" style={HEAD}>เห็นงานไหลต่อกัน<br className="hidden md:block" /> ไม่ใช่แค่เห็นรายการฟีเจอร์</h2>
                </div>
                <p className="max-w-[560px] text-[16px] leading-8 text-[#b9b1c5] md:justify-self-end">ไอเดีย สคริปต์ ภาพ เสียง และจังหวะตัดต่ออยู่ในบริบทเดียวกัน คุณจึงเห็นทั้งกระบวนการ ไม่ต้องเดาว่าแต่ละระบบเชื่อมกันอย่างไร</p>
              </div>
            </Reveal>

            <div className="mt-16 space-y-20 sm:mt-24 sm:space-y-32">
              {PRODUCT_PILLARS.map(({ id, eyebrow, title, desc, icon: Icon, chips, signal }, index) => (
                <article key={id} className={`grid items-center gap-10 lg:gap-16 ${index % 2 ? "lg:grid-cols-[1.22fr_.78fr]" : "lg:grid-cols-[.78fr_1.22fr]"}`}>
                  <Reveal y={22} className={index % 2 ? "lg:order-2 lg:pl-4" : undefined}>
                    <div className="relative max-w-[470px]">
                      <span aria-hidden className="absolute -top-12 right-0 select-none font-mono text-[84px] font-semibold leading-none text-violet-300/[0.055] sm:text-[112px]">0{index + 1}</span>
                      <div className="relative flex items-center gap-3">
                        <span className="flex h-11 w-11 items-center justify-center rounded-[13px] border border-violet-300/20 bg-violet-400/[0.09] text-violet-100 shadow-[0_0_30px_-14px_rgba(139,92,246,.8)]">
                          <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
                        </span>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-violet-200/80">{eyebrow}</p>
                          <p className="mt-1 font-mono text-[9px] tracking-[.1em] text-white/28">{signal}</p>
                        </div>
                      </div>
                      <h3 className="relative mt-7 text-[29px] font-semibold leading-[1.24] tracking-[-.025em] text-white sm:text-[37px]" style={HEAD}>{title}</h3>
                      <p className="mt-5 text-[16px] leading-8 text-[#b9b1c5]">{desc}</p>
                      <div className="mt-7 flex flex-wrap gap-2">
                        {chips.map((chip) => <span key={chip} className="rounded-full border border-white/10 bg-white/[0.035] px-3.5 py-2 text-[12px] text-white/66 transition-colors hover:border-violet-300/25 hover:text-white">{chip}</span>)}
                      </div>
                    </div>
                  </Reveal>
                  <Reveal delay={0.08} y={28} className={index % 2 ? "lg:order-1" : undefined}>
                    <SpotlightCard className="sale-v2-scene-shell rounded-[26px] border border-white/10 bg-[#0e0c14] p-2 shadow-[0_34px_90px_-44px_rgba(139,92,246,.72)]">
                      <ProductFeatureVisual id={id} />
                    </SpotlightCard>
                  </Reveal>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden border-y border-white/[0.06] bg-[#0d0b12] px-5 py-20 sm:py-32 lg:px-7">
          <div className="mx-auto max-w-[1200px]">
            <Reveal>
              <div className="grid gap-8 md:grid-cols-[.72fr_1fr] md:items-end">
                <div>
                  <p className="sale-v2-eyebrow">BRAND VISUAL</p>
                  <h2 className="mt-4 max-w-[620px] text-3xl font-semibold leading-[1.18] tracking-[-.025em] text-white sm:text-[46px]" style={HEAD}>เรื่องเดียวกัน<br />เล่าได้ในภาษาภาพของคุณ</h2>
                </div>
                <p className="max-w-[560px] text-[15px] leading-7 text-[#aaa3b6] md:justify-self-end">เลือก Visual Format ให้เข้ากับแบรนด์และเนื้อหา ระบบจะรักษาทิศทางภาพตลอดทั้งคลิป พร้อมให้เปลี่ยนหรือสร้างใหม่เป็นรายซีน</p>
              </div>
            </Reveal>
            <div className="sale-v2-format-grid mt-12 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4">
              {VISUAL_FORMATS.map(({ src, name, note }, index) => (
                <Reveal key={src} delay={index * 0.06} className={index === 4 ? "col-span-2 sm:col-span-1" : undefined}>
                  <figure className="group">
                    <div className={`relative overflow-hidden rounded-[18px] border border-white/10 bg-[#16131c] ${index === 4 ? "mx-auto aspect-[9/13] max-w-[240px] sm:aspect-[9/16] sm:max-w-none" : "aspect-[9/16]"}`}>
                      <Image src={src} alt={`ตัวอย่าง Brand Visual รูปแบบ ${name}`} fill sizes="(max-width: 640px) 50vw, 20vw" className="object-cover transition duration-700 group-hover:scale-[1.025]" />
                      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/10" aria-hidden />
                      <span className="absolute left-3 top-3 font-mono text-[9px] text-white/52">0{index + 1}</span>
                      <figcaption className="absolute inset-x-3 bottom-3">
                        <p className="text-[12px] font-semibold text-white sm:text-[13px]" style={HEAD}>{name}</p>
                        <p className="mt-0.5 text-[10px] text-white/55">{note}</p>
                      </figcaption>
                    </div>
                  </figure>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="outputs" className="scroll-mt-10 px-5 py-20 sm:py-32 lg:px-7">
          <div className="mx-auto max-w-[1100px]">
            <Reveal>
              <div className="text-center">
                <p className="sale-v2-eyebrow justify-center">MADE WITH HERO AI</p>
                <h2 className="mx-auto mt-4 max-w-[680px] text-3xl font-semibold leading-[1.18] tracking-[-.025em] text-white sm:text-[46px]" style={HEAD}>ดูคลิปที่ออกจากระบบจริง</h2>
                <p className="mx-auto mt-4 max-w-[580px] text-[15px] leading-7 text-[#aaa3b6]">สามแนวคอนเทนต์ สามวิธีเล่าเรื่อง—สร้างและตัดต่อด้วย HERO AI Creator Studio</p>
              </div>
            </Reveal>
            <div className="mx-auto mt-12 grid max-w-[860px] gap-7 sm:grid-cols-3">
              {SHOWCASE.map(({ src, poster, tag, detail }, index) => (
                <Reveal key={src} delay={index * 0.08}>
                  <ShowcaseClip src={src} poster={poster} title={`${tag} · ${detail}`} />
                  <div className="mt-4 border-l border-violet-300/35 pl-3">
                    <p className="text-[14px] font-semibold text-white" style={HEAD}>{tag}</p>
                    <p className="mt-0.5 text-[11px] text-white/42">{detail}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-white/[0.06] bg-[#0b0910]/75 px-5 py-20 sm:py-32 lg:px-7">
          <div className="mx-auto max-w-[1200px]">
            <Reveal>
              <div className="grid gap-7 md:grid-cols-[.58fr_1fr] md:items-end">
                <div>
                  <p className="sale-v2-eyebrow">FROM IDEA TO OUTPUT</p>
                  <h2 className="mt-4 text-3xl font-semibold tracking-[-.025em] text-white sm:text-[46px]" style={HEAD}>เริ่มง่าย จบงานได้จริง</h2>
                </div>
                <p className="max-w-[550px] text-[15px] leading-7 text-[#aaa3b6] md:justify-self-end">ระบบจัดการงานซ้ำๆ ให้ แต่ยังเปิดพื้นที่ให้คุณตัดสินใจในจุดที่ทำให้คอนเทนต์เป็นของคุณ</p>
              </div>
            </Reveal>
            <div className="mt-14 grid gap-px overflow-hidden rounded-[22px] border border-white/[0.08] bg-white/[0.08] md:grid-cols-3">
              {STEPS.map(({ n, title, desc }, index) => (
                <Reveal key={n} delay={index * 0.08} className="h-full">
                  <article className="relative h-full bg-[#0d0b12] p-7 sm:p-8">
                    <span className="font-mono text-[11px] tracking-[.15em] text-violet-300/70">STEP {n}</span>
                    <h3 className="mt-12 text-[21px] font-semibold text-white" style={HEAD}>{title}</h3>
                    <p className="mt-2 text-[14px] leading-6 text-white/50">{desc}</p>
                    {index < STEPS.length - 1 && <ChevronRight className="absolute right-5 top-7 hidden h-4 w-4 text-white/18 md:block" aria-hidden />}
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-8 px-5 py-20 sm:py-32 lg:px-7">
          <div className="mx-auto max-w-[1200px] text-center">
            <Reveal>
              <p className="sale-v2-eyebrow justify-center">PRICING</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-.025em] text-white sm:text-[46px]" style={HEAD}>เริ่มฟรี แล้วค่อยโตตามงาน</h2>
              <p className="mx-auto mt-4 max-w-[590px] text-[15px] leading-7 text-[#aaa3b6]">ทดลอง workflow จริงก่อนตัดสินใจ ทุกแพ็กแสดงข้อมูลล่าสุดจากระบบ</p>
            </Reveal>
            <PricingToggle plans={plans} founding={founding} minuteQuotaEnabled={MINUTE_QUOTA} />
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-5 py-20 sm:py-32 lg:px-7">
          <div className="mx-auto grid max-w-[1040px] gap-12 md:grid-cols-[.52fr_1fr]">
            <Reveal>
              <div className="md:sticky md:top-10">
                <p className="sale-v2-eyebrow">FAQ</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-[-.025em] text-white sm:text-[42px]" style={HEAD}>คำถามก่อนเริ่ม</h2>
                <p className="mt-4 max-w-[330px] text-[14px] leading-6 text-white/46">สิ่งที่ครีเอเตอร์มักอยากรู้ ก่อนทำคลิปแรกกับ HERO AI</p>
              </div>
            </Reveal>
            <div className="border-t border-white/10">
              {FAQS.map(({ q, a }, index) => (
                <Reveal key={q} delay={index * 0.04}>
                  <details className="group border-b border-white/[0.08]">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-6 text-left text-[16px] font-semibold text-white/88 transition-colors hover:text-white focus-visible:outline-none focus-visible:text-violet-200 [&::-webkit-details-marker]:hidden" style={HEAD}>
                      {q}<Plus className="h-4 w-4 shrink-0 text-violet-300 transition-transform duration-200 group-open:rotate-45" strokeWidth={2} aria-hidden />
                    </summary>
                    <p className="max-w-[650px] pb-6 pr-8 text-[14px] leading-7 text-[#aaa3b6]">{a}</p>
                  </details>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/[0.07] bg-[#0b0910] px-5 pb-28 pt-20 text-center sm:pb-14 sm:pt-28 lg:px-7">
        <Reveal>
          <div className="mx-auto max-w-[860px]">
            <div className="mx-auto mb-7 flex h-12 w-12 items-center justify-center rounded-[15px] border border-violet-300/18 bg-violet-400/[0.08] text-violet-200"><Layers3 className="h-5 w-5" strokeWidth={1.8} aria-hidden /></div>
            <p className="sale-v2-eyebrow justify-center">YOUR NEXT CONTENT STARTS HERE</p>
            <h2 className="mt-5 text-[36px] font-semibold leading-[1.12] tracking-[-.03em] text-white sm:text-[54px]" style={HEAD}>ไอเดียต่อไปของคุณ<br />ไม่ควรจบอยู่ในโน้ต</h2>
            {founding?.active ? (
              <p className="mx-auto mt-5 max-w-[560px] text-[15px] text-[#aaa3b6]">สิทธิ์ราคาผู้ก่อตั้งเหลือ {founding.remaining}/{founding.total} ที่</p>
            ) : (
              <p className="mx-auto mt-5 max-w-[560px] text-[15px] text-[#aaa3b6]">เริ่มจากหัวข้อเดียว แล้วให้ HERO AI พาไปจนถึงคลิปพร้อมโพสต์</p>
            )}
            <Link href="/register" className="sale-v2-cta mt-8 inline-flex min-h-14 items-center gap-2 rounded-[15px] px-8 text-[16px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0910]" style={{ ...HEAD, background: ACCENT }}>
              สร้างคลิปแรกฟรี <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <p className="mt-4 text-[12.5px] text-white/38">PRO ฟรี 7 วัน · ไม่ใช้บัตร · เริ่มได้ทันที</p>
            <a href="https://affiliate.heroaiengine.com/affiliate-program" className="mt-6 inline-flex min-h-11 items-center text-[12px] text-white/36 underline-offset-4 transition-colors hover:text-white/70 hover:underline focus-visible:outline-none focus-visible:text-white sm:mt-8">Affiliate — แนะนำ HERO AI รับค่าคอม 25% ทุกเดือน</a>
          </div>
        </Reveal>
        <div className="mx-auto mt-20 flex max-w-[1200px] flex-col items-center justify-between gap-4 border-t border-white/[0.07] pt-7 text-[11px] text-white/28 sm:flex-row">
          <div className="flex items-center gap-2">
            <Image src="/logo.svg" alt="" width={24} height={24} className="rounded-[7px] opacity-75" />
            <span className="font-semibold tracking-[.08em] text-white/42" style={HEAD}>HERO AI CREATOR STUDIO</span>
          </div>
          <p>© 2026 HERO AI Creator Studio</p>
        </div>
      </footer>

      <MobileStickyCta />
      <Script src="https://affiliate.heroaiengine.com/scripts/affiliate-tracking.js" strategy="afterInteractive" />
    </div>
  );
}
