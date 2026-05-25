import Link from "next/link";
import {
  Sparkles, ArrowRight, Check, X, Zap, Crown, Building2,
  Video, Mic, Wand2, Scissors, Music, Type, ImageOff, ChevronRight,
} from "lucide-react";
import { prisma } from "@/lib/prisma";

async function getPlanConfig() {
  const DEFAULTS = {
    pro_price: "599",
    pro_features: "100 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 6 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 7 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Support ทาง Email — ทีมงานตอบสนองภายใน 48 ชั่วโมง",
    business_price: "990",
    business_features: "300 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 10 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 14 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Priority Support — ทีมงานตอบสนองภายใน 24 ชั่วโมง|เหมาะสำหรับทีมงานและองค์กรธุรกิจ",
  };
  try {
    const rows = await prisma.siteConfig.findMany({
      where: { key: { in: ["plan_pro_price", "plan_pro_features", "plan_business_price", "plan_business_features"] } },
    });
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      pro: {
        price: parseInt(m.plan_pro_price ?? DEFAULTS.pro_price, 10),
        features: (m.plan_pro_features ?? DEFAULTS.pro_features).split("|").map((f: string) => f.trim()).filter(Boolean),
      },
      business: {
        price: parseInt(m.plan_business_price ?? DEFAULTS.business_price, 10),
        features: (m.plan_business_features ?? DEFAULTS.business_features).split("|").map((f: string) => f.trim()).filter(Boolean),
      },
    };
  } catch {
    return {
      pro: { price: 599, features: DEFAULTS.pro_features.split("|").map((f: string) => f.trim()) },
      business: { price: 990, features: DEFAULTS.business_features.split("|").map((f: string) => f.trim()) },
    };
  }
}

const FEATURES = [
  {
    icon: Video,
    title: "Avatar Video Creator",
    desc: "สร้างวิดีโอ Avatar พูดได้จากสคริปต์ รองรับ HeyGen และ AI Avatar ทุกรูปแบบ",
    color: "from-violet-500 to-purple-600",
    glow: "hsl(262 83% 57% / 0.15)",
  },
  {
    icon: Wand2,
    title: "AI Content Generator",
    desc: "แปลงบทความหรือ URL เป็นโพสต์โซเชียลมีเดียพร้อมใช้งาน ด้วย Gemini AI",
    color: "from-cyan-500 to-blue-600",
    glow: "hsl(190 100% 50% / 0.15)",
  },
  {
    icon: Mic,
    title: "Text-to-Speech",
    desc: "เสียงพากย์คุณภาพสูงด้วย ElevenLabs, Gemini TTS และ HeyGen Voice",
    color: "from-pink-500 to-rose-600",
    glow: "hsl(330 80% 60% / 0.15)",
  },
  {
    icon: Scissors,
    title: "Video Editor",
    desc: "ตัดต่อวิดีโอ ปรับ Subtitle ใส่ Avatar ครบในที่เดียว ไม่ต้องใช้โปรแกรมอื่น",
    color: "from-amber-500 to-orange-600",
    glow: "hsl(38 92% 50% / 0.15)",
  },
  {
    icon: ImageOff,
    title: "Background Removal",
    desc: "ลบพื้นหลังอัตโนมัติด้วย AI ความแม่นยำสูง ใช้งานได้ทันทีในไม่กี่วินาที",
    color: "from-emerald-500 to-green-600",
    glow: "hsl(152 76% 40% / 0.15)",
  },
  {
    icon: Music,
    title: "Music & Subtitle",
    desc: "เพิ่มเพลงประกอบ และปรับแต่ง Subtitle Style ได้หลากหลายรูปแบบ",
    color: "from-indigo-500 to-violet-600",
    glow: "hsl(239 84% 67% / 0.15)",
  },
];

const STEPS = [
  { step: "01", title: "เพิ่มคอนเทนต์", desc: "วางลิงก์ บทความ หรือพิมพ์ข้อความที่ต้องการ" },
  { step: "02", title: "ให้ AI สร้าง", desc: "AI จัดการสคริปต์ เสียง Avatar และภาพให้อัตโนมัติ" },
  { step: "03", title: "Export & แชร์", desc: "ดาวน์โหลดวิดีโอพร้อมโพสต์โซเชียลมีเดียได้เลย" },
];

const FREE_FEATURES = [
  { text: "2 คลิป/เดือน", ok: true },
  { text: "ความยาวสูงสุด 2 นาที/คลิป", ok: true },
  { text: "จัดเก็บวิดีโอ 3 วัน", ok: true },
  { text: "สร้าง AI Content", ok: true },
  { text: "Font พื้นฐาน", ok: true },
  { text: "HeyGen Avatar", ok: false },
  { text: "Background Removal", ok: false },
  { text: "Music & Subtitle styles", ok: false },
];

export default async function Home() {
  const planConfig = await getPlanConfig();

  return (
    <div className="min-h-screen bg-[#080810] text-white overflow-x-hidden">

      {/* ── Navbar ─────────────────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 backdrop-blur-md border-b border-white/5"
        style={{ background: "rgba(8,8,16,0.8)" }}>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight">Hero AI Creator Studio</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-zinc-400 hover:text-white transition-colors">เข้าสู่ระบบ</Link>
          <Link href="/register"
            className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
            เริ่มฟรี <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────────── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-20 text-center">
        {/* Background glows */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 h-[600px] w-[600px] rounded-full bg-violet-600/10 blur-[120px]" />
          <div className="absolute top-1/3 left-1/4 h-[400px] w-[400px] rounded-full bg-cyan-500/8 blur-[100px]" />
          <div className="absolute top-1/3 right-1/4 h-[400px] w-[400px] rounded-full bg-purple-500/8 blur-[100px]" />
        </div>

        <div className="relative z-10 max-w-4xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/10 px-4 py-1.5">
            <Sparkles className="h-3.5 w-3.5 text-violet-400" />
            <span className="text-xs font-medium text-violet-300">AI-Powered Content, Built for Creators.</span>
          </div>

          <h1 className="mb-6 text-5xl font-extrabold leading-tight tracking-tight md:text-7xl">
            <span className="bg-gradient-to-r from-white via-white to-zinc-400 bg-clip-text text-transparent">
              Hero AI
            </span>
            <br />
            <span className="bg-gradient-to-r from-violet-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
              Creator Studio
            </span>
          </h1>

          <p className="mx-auto mb-10 max-w-2xl text-lg text-zinc-400 leading-relaxed">
            แพลตฟอร์ม AI ที่ช่วยสร้างวิดีโอ Avatar คอนเทนต์โซเชียลมีเดีย และเสียงพากย์<br />
            <span className="text-zinc-300">ครบในที่เดียว — ไม่ต้องมีทีม ไม่ต้องมีประสบการณ์</span>
          </p>

          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/register"
              className="group flex items-center gap-2 rounded-full px-8 py-3.5 text-sm font-semibold text-white shadow-lg transition-all hover:scale-105 hover:shadow-violet-500/30"
              style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)", boxShadow: "0 0 40px hsl(262 83% 57% / 0.3)" }}>
              เริ่มใช้งานฟรี
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <Link href="/login"
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-8 py-3.5 text-sm font-medium text-zinc-300 backdrop-blur-sm transition-all hover:bg-white/10 hover:text-white">
              เข้าสู่ระบบ
            </Link>
          </div>

          <p className="mt-6 text-xs text-zinc-600">ไม่ต้องใส่บัตรเครดิต · เริ่มได้ทันที · ยกเลิกเมื่อไหรก็ได้</p>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────── */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-400">How it works</p>
            <h2 className="text-3xl font-bold md:text-4xl">สร้างวิดีโอใน 3 ขั้นตอน</h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={i} className="relative rounded-2xl border border-white/8 bg-white/3 p-6 backdrop-blur-sm">
                <div className="mb-4 flex items-center gap-3">
                  <span className="text-3xl font-black bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">{s.step}</span>
                  {i < 2 && <ChevronRight className="absolute -right-4 top-8 h-5 w-5 text-zinc-700 hidden md:block" />}
                </div>
                <h3 className="mb-2 text-base font-semibold text-white">{s.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────────── */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-16 text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-cyan-400">Features</p>
            <h2 className="text-3xl font-bold md:text-4xl">ทุกเครื่องมือที่ Creator ต้องการ</h2>
            <p className="mt-4 text-zinc-500">ครบในที่เดียว ไม่ต้องสลับแอปอีกต่อไป</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div key={i} className="group rounded-2xl border border-white/8 bg-white/3 p-6 backdrop-blur-sm transition-all hover:border-white/15 hover:bg-white/5"
                style={{ boxShadow: `inset 0 0 60px ${f.glow}` }}>
                <div className={`mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${f.color} shadow-lg`}>
                  <f.icon className="h-5 w-5 text-white" />
                </div>
                <h3 className="mb-2 text-base font-semibold text-white">{f.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────── */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-16 text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-400">Pricing</p>
            <h2 className="text-3xl font-bold md:text-4xl">เลือกแผนที่เหมาะกับคุณ</h2>
            <p className="mt-4 text-zinc-500">ชำระแล้วใช้ได้ทันที 30 วัน · ไม่มีการตัดเงินอัตโนมัติ</p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {/* Free */}
            <div className="flex flex-col gap-5 rounded-2xl border border-white/8 bg-white/3 p-7 backdrop-blur-sm">
              <div>
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-800">
                  <Zap className="h-4 w-4 text-zinc-400" />
                </div>
                <p className="font-semibold text-white">Free</p>
                <p className="mt-2 text-4xl font-black text-white">ฟรี</p>
              </div>
              <ul className="flex-1 space-y-3">
                {FREE_FEATURES.map(({ text, ok }) => (
                  <li key={text} className="flex items-center gap-2.5">
                    {ok ? <Check className="h-4 w-4 shrink-0 text-zinc-400" /> : <X className="h-4 w-4 shrink-0 text-zinc-700" />}
                    <span className={`text-sm ${ok ? "text-zinc-400" : "text-zinc-700 line-through"}`}>{text}</span>
                  </li>
                ))}
              </ul>
              <Link href="/register"
                className="block w-full rounded-xl border border-white/10 py-2.5 text-center text-sm font-medium text-zinc-400 transition-all hover:bg-white/5 hover:text-white">
                เริ่มใช้งานฟรี
              </Link>
            </div>

            {/* Pro */}
            <div className="relative flex flex-col gap-5 rounded-2xl p-7"
              style={{ background: "linear-gradient(145deg, hsl(190 100% 50% / 0.07), hsl(262 83% 57% / 0.07))", border: "1px solid hsl(190 100% 50% / 0.25)", boxShadow: "0 0 60px hsl(190 100% 50% / 0.08)" }}>
              <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                <span className="rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ background: "linear-gradient(135deg, #06b6d4, #7c3aed)", color: "white" }}>
                  แนะนำ
                </span>
              </div>
              <div>
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/20">
                  <Crown className="h-4 w-4 text-cyan-400" />
                </div>
                <p className="font-semibold text-white">Pro</p>
                <p className="mt-2 text-4xl font-black text-white">
                  ฿{planConfig.pro.price.toLocaleString()}
                  <span className="ml-1 text-base font-normal text-zinc-400">/เดือน</span>
                </p>
              </div>
              <ul className="flex-1 space-y-3">
                {planConfig.pro.features.map(f => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
                    <span className="text-sm text-zinc-300">{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/register"
                className="block w-full rounded-xl py-3 text-center text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #06b6d4, #7c3aed)", boxShadow: "0 4px 24px hsl(190 100% 50% / 0.25)" }}>
                อัปเกรดเป็น Pro
              </Link>
            </div>

            {/* Business */}
            <div className="flex flex-col gap-5 rounded-2xl p-7"
              style={{ background: "hsl(262 83% 57% / 0.05)", border: "1px solid hsl(262 83% 57% / 0.2)" }}>
              <div>
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/20">
                  <Building2 className="h-4 w-4 text-violet-400" />
                </div>
                <p className="font-semibold text-white">Business</p>
                <p className="mt-2 text-4xl font-black text-white">
                  ฿{planConfig.business.price.toLocaleString()}
                  <span className="ml-1 text-base font-normal text-zinc-400">/เดือน</span>
                </p>
              </div>
              <ul className="flex-1 space-y-3">
                {planConfig.business.features.map(f => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
                    <span className="text-sm text-zinc-300">{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/register"
                className="block w-full rounded-xl border border-violet-500/30 bg-violet-500/10 py-3 text-center text-sm font-semibold text-violet-300 transition-all hover:bg-violet-500/20">
                อัปเกรดเป็น Business
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="border-t border-white/5 px-6 py-10 text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-cyan-500">
            <Sparkles className="h-3 w-3 text-white" />
          </div>
          <span className="text-sm font-bold text-white">Hero AI Creator Studio</span>
        </div>
        <p className="text-xs text-zinc-600">© 2025 Hero AI Creator Studio. All rights reserved.</p>
      </footer>

    </div>
  );
}
