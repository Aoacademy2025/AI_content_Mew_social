"use client";

import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { Sparkles, Zap, Shield, Star } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-[#060608]">
      {/* Left panel — branding */}
      <div className="hidden lg:flex lg:w-[52%] relative flex-col justify-between px-12 pt-8 pb-12 overflow-hidden">
        <div className="absolute inset-0 bg-[#060608]" />
        <div className="absolute inset-0" style={{
          background: "radial-gradient(ellipse 80% 60% at 30% 50%, rgba(124,58,237,0.18) 0%, transparent 70%)",
        }} />
        <div className="absolute inset-0" style={{
          background: "radial-gradient(ellipse 60% 40% at 80% 20%, rgba(6,182,212,0.1) 0%, transparent 60%)",
        }} />
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.8) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }} />

        <div className="relative z-10">
          <Link href="/" className="flex items-center gap-3 w-fit">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <span className="text-white font-bold text-lg tracking-tight">Hero AI Creator Studio</span>
          </Link>
        </div>

        <div className="relative z-10 space-y-10">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5">
              <Star className="h-3.5 w-3.5 text-violet-400 fill-violet-400" />
              <span className="text-xs font-medium text-violet-300">AI Video Creation Platform</span>
            </div>
            <h1 className="text-5xl font-bold text-white leading-[1.1] tracking-tight">
              สร้างคอนเทนต์<br />
              <span style={{ background: "linear-gradient(135deg, #a78bfa, #22d3ee)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                ระดับมืออาชีพ
              </span>
            </h1>
            <p className="text-zinc-400 text-lg leading-relaxed max-w-sm">
              AI ช่วยสร้างวิดีโอ เพิ่ม Avatar พากย์เสียง และตัดต่ออัตโนมัติ ในไม่กี่นาที
            </p>
          </div>

          <div className="space-y-4">
            {[
              { icon: Zap, text: "สร้างวิดีโอ AI อัตโนมัติ พร้อมซับไตเติ้ล" },
              { icon: Shield, text: "Avatar 3D และเสียงพากย์ ElevenLabs" },
              { icon: Star, text: "ปรับแต่งสไตล์ฟอนต์และเอฟเฟกต์ได้ครบ" },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 border border-white/10">
                  <Icon className="h-4 w-4 text-violet-400" />
                </div>
                <span className="text-sm text-zinc-300">{text}</span>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/3 p-5 backdrop-blur-sm">
            <div className="flex gap-0.5 mb-3">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
              ))}
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed">
              "Hero AI ช่วยให้เราผลิตคอนเทนต์ได้เร็วขึ้น 10 เท่า คุณภาพระดับ Production พร้อมใช้ทันที"
            </p>
            <div className="mt-4 flex items-center gap-3">
              <div className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>K</div>
              <div>
                <div className="text-xs font-medium text-white">คุณกิตติ</div>
                <div className="text-xs text-zinc-500">Content Creator · 50K Followers</div>
              </div>
            </div>
          </div>
        </div>

        <div className="relative z-10">
          <p className="text-xs text-zinc-600">© 2025 Hero AI Creator Studio. All rights reserved.</p>
        </div>
      </div>

      {/* Right panel — Clerk SignIn */}
      <div className="flex flex-1 flex-col relative">
        {/* Mobile logo */}
        <div className="lg:hidden pt-6 px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="text-white font-bold tracking-tight">Hero AI Creator Studio</span>
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center py-12 px-6">
          <SignIn
            forceRedirectUrl="/dashboard"
            appearance={{
              elements: {
                rootBox: "w-full max-w-md",
                card: "bg-transparent shadow-none border-0 p-0",
                headerTitle: "text-3xl font-bold text-white tracking-tight",
                headerSubtitle: "text-zinc-500 text-sm mt-1",
                socialButtonsBlockButton:
                  "w-full flex items-center justify-center gap-3 rounded-xl border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-white transition-all hover:bg-white/10 hover:border-white/20",
                socialButtonsBlockButtonText: "text-white font-medium",
                dividerLine: "bg-white/8",
                dividerText: "text-zinc-600 text-xs uppercase tracking-wider bg-[#060608]",
                formFieldLabel: "text-xs font-medium text-zinc-400 uppercase tracking-wider",
                formFieldInput:
                  "h-11 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:ring-violet-500/20 focus:ring-2 transition-all",
                formButtonPrimary:
                  "w-full h-11 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99]",
                footerActionLink: "text-violet-400 hover:text-violet-300 font-medium",
                footerActionText: "text-zinc-500",
                identityPreviewText: "text-white",
                identityPreviewEditButton: "text-violet-400",
                formResendCodeLink: "text-violet-400",
                alertText: "text-red-400",
                formFieldErrorText: "text-red-400 text-xs",
                otpCodeFieldInput: "border-white/20 bg-white/5 text-white",
              },
              variables: {
                colorPrimary: "#7c3aed",
                colorBackground: "#060608",
                colorText: "#ffffff",
                colorTextSecondary: "#71717a",
                colorInputBackground: "rgba(255,255,255,0.05)",
                colorInputText: "#ffffff",
                borderRadius: "0.75rem",
                fontFamily: "inherit",
              },
              layout: {
                socialButtonsPlacement: "top",
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
