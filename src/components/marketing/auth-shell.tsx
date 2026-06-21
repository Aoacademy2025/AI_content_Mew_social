import Link from "next/link";
import { Captions, Film, Bot, SlidersHorizontal, Flame } from "lucide-react";

// Shared split-screen shell for /login and /register — CI-matched to the sale
// page (single-accent violet). Server component so it can show live founding seats.

type FoundingStatus = { active: boolean; remaining: number; total: number } | null;

const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;
const GLOW = "0 0 34px rgba(139,92,246,.5)";

const BULLETS = [
  { icon: Captions, text: "ซับไทยตรงเสียงเป๊ะ — ไม่ใช่ AI เดา" },
  { icon: Film, text: "B-roll เปลี่ยนทุก 3–5 วิ อัตโนมัติ" },
  { icon: Bot, text: "AI Avatar พิธีกร — หรือทำ Faceless" },
  { icon: SlidersHorizontal, text: "ตัดต่อในเว็บ + พร้อมโพสต์แนวตั้ง" },
];

// Real outputs (same self-hosted posters as the sale-page Showcase) — real proof, not fabricated.
const PROOF = ["/showcase/showcase-1.jpg", "/showcase/showcase-3.jpg", "/showcase/showcase-2.jpg"];

// Clerk widget theming — violet, transparent card to sit on our background.
export const CLERK_APPEARANCE = {
  elements: {
    rootBox: "w-full max-w-md",
    card: "bg-transparent shadow-none border-0 p-0",
    headerTitle: "text-3xl font-bold text-white tracking-tight",
    headerSubtitle: "text-zinc-500 text-sm mt-1",
    socialButtonsBlockButton:
      "w-full flex items-center justify-center gap-3 rounded-xl border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-white transition-all hover:bg-white/10 hover:border-white/20",
    socialButtonsBlockButtonText: "text-white font-medium",
    dividerLine: "bg-white/8",
    dividerText: "text-zinc-600 text-xs uppercase tracking-wider bg-[#06060b]",
    formFieldLabel: "text-xs font-medium text-zinc-400 uppercase tracking-wider",
    formFieldInput:
      "h-11 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:ring-violet-500/20 focus:ring-2 transition-all",
    formButtonPrimary:
      "w-full h-11 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99] !bg-[linear-gradient(120deg,#8b5cf6,#a78bfa)] shadow-[0_0_24px_rgba(139,92,246,.45)]",
    footerActionLink: "text-violet-300 hover:text-violet-200 font-medium",
    footerActionText: "text-zinc-500",
    identityPreviewText: "text-white",
    identityPreviewEditButton: "text-violet-300",
    formResendCodeLink: "text-violet-300",
    alertText: "text-red-400",
    formFieldErrorText: "text-red-400 text-xs",
    otpCodeFieldInput: "border-white/20 bg-white/5 text-white",
  },
  variables: {
    colorPrimary: "#8b5cf6",
    colorBackground: "#06060b",
    colorText: "#ffffff",
    colorTextSecondary: "#9ca0be",
    colorInputBackground: "rgba(255,255,255,0.05)",
    colorInputText: "#ffffff",
    borderRadius: "0.75rem",
    fontFamily: "inherit",
  },
  layout: { socialButtonsPlacement: "top" as const },
};

export function AuthShell({
  mode,
  founding,
  children,
}: {
  mode: "login" | "register";
  founding: FoundingStatus;
  children: React.ReactNode;
}) {
  const isRegister = mode === "register";
  return (
    <div className="flex min-h-screen bg-[#06060b] text-white" style={{ fontFamily: "'IBM Plex Sans Thai', sans-serif" }}>
      {/* LEFT — branding (lg+) */}
      <div className="relative hidden w-[52%] flex-col justify-between overflow-hidden px-12 pb-12 pt-9 lg:flex">
        <div aria-hidden className="absolute inset-0">
          <div className="absolute left-[18%] top-[32%] h-[42vw] w-[42vw] -translate-x-1/2 rounded-full opacity-40 blur-[120px]" style={{ background: "radial-gradient(circle,#6d28d9,transparent 60%)" }} />
          <div className="absolute right-[-6%] top-[-6%] h-[28vw] w-[28vw] rounded-full opacity-25 blur-[120px]" style={{ background: "radial-gradient(circle,#8b5cf6,transparent 60%)" }} />
          <div
            className="absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage: "linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg,#ffffff 1px, transparent 1px)",
              backgroundSize: "60px 60px",
              maskImage: "radial-gradient(ellipse 70% 60% at 40% 45%, #000 30%, transparent 80%)",
              WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 40% 45%, #000 30%, transparent 80%)",
            }}
          />
        </div>

        <div className="relative z-10">
          <Link href="/" className="flex w-fit items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="HERO AI Creator Studio" className="h-10 w-10 rounded-[12px]" style={{ boxShadow: GLOW }} />
            <span className="text-lg font-bold tracking-wide" style={HEAD}>HERO AI <span className="font-semibold text-white/55">Creator Studio</span></span>
          </Link>
        </div>

        <div className="relative z-10 space-y-8">
          <div className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 text-[13px] text-violet-200">
              {isRegister ? "เริ่มต้นฟรี · ไม่ใช้บัตร" : "ยินดีต้อนรับกลับ 👋"}
            </span>
            <h1 className="text-5xl font-bold leading-[1.08]" style={{ ...HEAD, letterSpacing: "-.01em" }}>
              มีแค่ <span className="bg-gradient-to-r from-violet-300 to-violet-400 bg-clip-text text-transparent">สคริปต์ 1 ชุด</span>
              <br />ได้คลิปพร้อมโพสต์
            </h1>
            <p className="max-w-sm text-[15px] leading-relaxed text-[#a7adcc]">
              {isRegister
                ? "สมัครแล้วได้ PRO ฟรี 7 วันทันที — สร้างคลิปแรกได้เลย ไม่ต้องออกกล้อง ไม่ต้องตัดต่อเอง"
                : "เข้าสู่ระบบเพื่อสร้างคลิปต่อ — เสียงพากย์ + ซับไทย + B-roll อัตโนมัติ"}
            </p>
          </div>

          <div className="space-y-3.5">
            {BULLETS.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-violet-400/20 bg-violet-500/10">
                  <Icon className="h-4 w-4 text-violet-300" strokeWidth={2.2} aria-hidden />
                </div>
                <span className="text-sm text-[#d5d9ee]">{text}</span>
              </div>
            ))}
          </div>

          {/* real proof — same showcase clips as the sale page */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
            <p className="mb-3 text-[13px] font-semibold text-white/80" style={HEAD}>ผลงานจริงที่สร้างจากระบบ</p>
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                {PROOF.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt="ผลงานจริงจากระบบ" className="h-24 w-[54px] rounded-lg border border-violet-400/15 object-cover" />
                ))}
              </div>
              <div className="flex flex-col gap-1.5 text-[12px] text-[#a7adcc]">
                <span>✓ จากสคริปต์ชุดเดียว</span>
                <span>✓ ซับไทยตรงเสียง</span>
                <span>✓ ลง TikTok / Reels ได้เลย</span>
              </div>
            </div>
          </div>
        </div>

        <div className="relative z-10 flex flex-wrap items-center gap-3 text-xs text-zinc-600">
          <span>© 2026 HERO AI Creator Studio</span>
          {founding?.active && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-amber-300">
              <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden /> ราคาผู้ก่อตั้งเหลือ {founding.remaining}/{founding.total}
            </span>
          )}
        </div>
      </div>

      {/* RIGHT — form */}
      <div className="relative flex flex-1 flex-col">
        <div className="px-6 pt-6 lg:hidden">
          <Link href="/" className="flex w-fit items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="HERO AI Creator Studio" className="h-9 w-9 rounded-[11px]" style={{ boxShadow: GLOW }} />
            <span className="font-bold tracking-wide" style={HEAD}>HERO AI <span className="font-semibold text-white/55">Creator Studio</span></span>
          </Link>
          <p className="mt-3 text-[13px] text-violet-200">
            ✨ มีแค่สคริปต์ 1 ชุด ได้คลิปพร้อมโพสต์ — {isRegister ? "PRO ฟรี 7 วัน ไม่ใช้บัตร" : "ยินดีต้อนรับกลับ"}
          </p>
        </div>

        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-md">
            {children}
            <p className="mt-6 text-center text-[13px] text-[#9ca0be]">
              {isRegister
                ? "สมัคร = ได้ PRO ฟรี 7 วัน · ไม่ใช้บัตร · ยกเลิกเมื่อไหร่ก็ได้"
                : "ยังไม่มีบัญชี? สมัครฟรี ได้ PRO 7 วัน — ไม่ใช้บัตร"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
