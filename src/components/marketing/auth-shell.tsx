import Link from "next/link";

// Shared split-screen shell for /login and /register, matched to the v3 sale page
// (flat violet #8b5cf6 on #0b0a10, Bai Jamjuree headings, real team clips as proof).
// Server component so it can show live founding seats.

type FoundingStatus = { active: boolean; remaining: number; total: number } | null;

const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;
const BG = "#0b0a10";

const POINTS = [
  "ซับไทยตรงเสียง แก้ข้อความได้ทุกการ์ด",
  "เสียงพากย์ ภาพประกอบที่เปลี่ยนตามเนื้อหา และเพลง ครบในคลิปเดียว",
  "อัปคลิปที่คุณพูดเอง หรือใช้พิธีกร AI",
  "สั่งทำและสั่งแก้คลิปจากแชท AI ที่คุณใช้อยู่ เช่น Claude",
];

// Real exports from the team's accounts — the same clips as the sale page's outputs.
const PROOF = ["avatar", "brownie", "locked", "digital", "pixza"].map((k) => `/sale/${k}-final.jpg`);

// Clerk widget theming. Its own header is hidden: the shell renders a Thai title above it.
export const CLERK_APPEARANCE = {
  elements: {
    rootBox: "!w-full max-w-md",
    card: "bg-transparent shadow-none border-0 p-0",
    cardBox: "!w-full !max-w-full !shadow-none !border !border-[#25212e] !bg-[#121018]",
    header: "!hidden",
    socialButtonsBlockButton:
      "w-full flex items-center justify-center gap-3 rounded-xl border border-[#363042] bg-transparent px-4 py-3 text-sm font-medium text-white transition-colors hover:border-[#8b5cf6]",
    socialButtonsBlockButtonText: "text-white font-medium",
    dividerLine: "bg-[#25212e]",
    dividerText: "text-[#6f6a7d] text-xs",
    formFieldLabel: "text-[13px] font-medium text-[#a39db3]",
    formFieldInput:
      "h-11 rounded-xl !border-[#363042] !bg-[#0b0a10] !text-white placeholder:text-[#6f6a7d] focus:border-[#8b5cf6] focus:ring-[#8b5cf6]/25 focus:ring-2 transition-colors",
    formButtonPrimary:
      "w-full h-12 rounded-xl text-[15px] font-semibold !text-white transition-colors !bg-[#8b5cf6] hover:!bg-[#7c4dee] !shadow-none",
    footer: "bg-transparent",
    footerActionLink: "text-[#c4b5fd] hover:text-white font-medium",
    footerActionText: "text-[#a39db3]",
    identityPreviewText: "text-white",
    identityPreviewEditButton: "text-[#c4b5fd]",
    formResendCodeLink: "text-[#c4b5fd]",
    alertText: "text-red-400",
    formFieldErrorText: "text-red-400 text-xs",
    otpCodeFieldInput: "!border-[#363042] !bg-[#0b0a10] !text-white",
  },
  variables: {
    colorPrimary: "#8b5cf6",
    colorBackground: BG,
    colorText: "#ffffff",
    colorTextSecondary: "#a39db3",
    colorInputBackground: "#121018",
    colorInputText: "#ffffff",
    borderRadius: "0.75rem",
    fontFamily: "inherit",
  },
  layout: { socialButtonsPlacement: "top" as const },
};

function Logo({ size }: { size: number }) {
  return (
    <Link href="/" className="flex w-fit items-center gap-2.5" aria-label="HERO AI Creator Studio หน้าแรก">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.svg" alt="" width={size} height={size} className="rounded-[8px]" />
      <span className="text-[19px] font-bold" style={HEAD}>
        HERO AI <small className="text-[13px] font-normal text-[#a39db3]" style={{ fontFamily: "inherit" }}>Creator Studio</small>
      </span>
    </Link>
  );
}

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
    <div className="flex min-h-screen text-[#f4f2f8]" style={{ background: BG, fontFamily: "'IBM Plex Sans Thai', sans-serif" }}>
      {/* LEFT — the promise and real clips (lg+) */}
      <div className="relative hidden w-[52%] flex-col justify-between overflow-hidden border-r border-[#25212e] px-12 pb-10 pt-9 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(60% 50% at 30% 55%, rgba(139,92,246,.16), transparent 70%)" }}
        />

        <div className="relative z-10"><Logo size={28} /></div>

        <div className="relative z-10 max-w-[560px]">
          <h1 className="text-[52px] font-bold leading-[1.25] xl:text-[60px]" style={HEAD}>
            <span className="inline-block whitespace-nowrap">สคริปต์เดียว</span>{" "}
            <span className="inline-block whitespace-nowrap">ได้คลิปสั้นพร้อมซับไทย</span>
          </h1>
          <p className="mt-4 max-w-[46ch] text-[17px] leading-[1.7] text-[#c9c3d6]">
            {isRegister
              ? "สมัครแล้วได้ PRO ฟรี 7 วันทันที ทำคลิปบนเว็บก็ได้ หรือสั่งจากแชท AI ที่คุณใช้อยู่ก็ได้"
              : "เข้าสู่ระบบเพื่อทำคลิปต่อ คลิปที่สั่งผ่านแชท AI ก็อยู่ในบัญชีนี้ เปิดแก้ต่อบนเว็บได้เลย"}
          </p>

          <ul className="mt-8 grid gap-3 text-[15px] text-[#d6d0e2]">
            {POINTS.map((text) => (
              <li key={text} className="relative pl-7">
                <span
                  aria-hidden
                  className="absolute left-[3px] top-[.6em] h-[6px] w-[11px] -rotate-45 border-b-2 border-l-2 border-[#c4b5fd]"
                />
                {text}
              </li>
            ))}
          </ul>

          <figure className="mt-10">
            <div className="flex gap-3">
              {PROOF.map((src) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={src} src={src} alt="" className="aspect-[9/16] w-[78px] rounded-xl border-[3px] border-[#1f1b28] object-cover" />
              ))}
            </div>
            <figcaption className="mt-4 inline-flex items-center gap-2.5 rounded-full border border-[#363042] py-1.5 pl-2.5 pr-4 text-[13.5px] text-[#d6d0e2]">
              <i aria-hidden className="h-2 w-2 rounded-full bg-[#34d399] shadow-[0_0_0_4px_rgba(52,211,153,.15)]" />
              <span>ลูกค้าสั่งทำคลิปผ่านแชทสำเร็จ <b className="font-semibold text-white">205 คลิป</b> ช่วง 14–28 ต.ค. 2569</span>
            </figcaption>
          </figure>
        </div>

        <div className="relative z-10 flex flex-wrap items-center gap-4 text-[13px] text-[#6f6a7d]">
          <span>© 2026 HERO AI Creator Studio</span>
          {founding?.active && (
            <span className="text-[#c4b5fd]">
              ราคาผู้ก่อตั้ง (จ่ายรายปี) เหลือ <b className="font-semibold text-white">{founding.remaining}</b> จาก {founding.total} ที่
            </span>
          )}
        </div>
      </div>

      {/* RIGHT — form */}
      <div className="relative flex flex-1 flex-col">
        <div className="px-6 pt-6 lg:hidden"><Logo size={26} /></div>

        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-md">
            <h2 className="text-[28px] font-bold leading-tight" style={HEAD}>
              {isRegister ? "สร้างบัญชี HERO" : "เข้าสู่ระบบ HERO"}
            </h2>
            <p className="mb-7 mt-2 text-[15px] text-[#a39db3]">
              {isRegister ? "ทดลอง PRO ฟรี 7 วัน ทำคลิปแรกได้ภายในวันนี้" : "ยินดีต้อนรับกลับ ทำคลิปต่อได้เลย"}
            </p>
            {children}
            <p className="mt-6 text-center text-[13.5px] leading-relaxed text-[#a39db3]">
              {isRegister ? (
                <><b className="font-semibold text-white">ไม่ต้องใช้บัตร</b> ครบ 7 วันระบบกลับเป็นแผน Free ให้เอง ไม่มีการตัดเงิน</>
              ) : (
                <>ยังไม่มีบัญชี? <Link href="/register" className="font-medium text-[#c4b5fd] hover:text-white">สมัครฟรี ได้ PRO 7 วัน</Link> ไม่ต้องใช้บัตร</>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
