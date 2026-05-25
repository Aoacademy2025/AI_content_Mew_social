"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, ArrowRight, Sparkles, Zap, Shield, Star } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success("เข้าสู่ระบบสำเร็จ!");
        router.push("/dashboard");
      }
    } catch {
      toast.error("เกิดข้อผิดพลาด กรุณาลองใหม่");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-[#060608]">
      {/* Left panel — branding */}
      <div className="hidden lg:flex lg:w-[52%] relative flex-col justify-between px-12 pt-8 pb-12 overflow-hidden">
        {/* Background layers */}
        <div className="absolute inset-0 bg-[#060608]" />
        <div className="absolute inset-0" style={{
          background: "radial-gradient(ellipse 80% 60% at 30% 50%, rgba(124,58,237,0.18) 0%, transparent 70%)",
        }} />
        <div className="absolute inset-0" style={{
          background: "radial-gradient(ellipse 60% 40% at 80% 20%, rgba(6,182,212,0.1) 0%, transparent 60%)",
        }} />
        {/* Grid pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.8) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }} />

        {/* Logo */}
        <div className="relative z-10">
          <Link href="/" className="flex items-center gap-3 w-fit">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <span className="text-white font-bold text-lg tracking-tight">Hero AI Creator Studio</span>
          </Link>
        </div>

        {/* Center content */}
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

          {/* Feature list */}
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

          {/* Testimonial */}
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
              <div className="h-8 w-8 rounded-full bg-linear-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-xs font-bold text-white">K</div>
              <div>
                <div className="text-xs font-medium text-white">คุณกิตติ</div>
                <div className="text-xs text-zinc-500">Content Creator · 50K Followers</div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom */}
        <div className="relative z-10">
          <p className="text-xs text-zinc-600">© 2025 Hero AI Creator Studio. All rights reserved.</p>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 flex-col px-6 lg:px-16 xl:px-24 relative">
        {/* Mobile logo — top */}
        <div className="lg:hidden pt-4 pb-0">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="text-white font-bold tracking-tight">Hero AI Creator Studio</span>
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-100">
          {/* Header */}
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-white tracking-tight">ยินดีต้อนรับกลับ</h2>
            <p className="mt-2 text-zinc-500 text-sm">เข้าสู่ระบบเพื่อเริ่มสร้างคอนเทนต์</p>
          </div>

          {/* Google button */}
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-white/10 hover:border-white/20 active:scale-[0.98]"
          >
            <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            เข้าสู่ระบบด้วย Google
          </button>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/8" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-[#060608] px-3 text-xs text-zinc-600 uppercase tracking-wider">หรือเข้าสู่ระบบด้วยอีเมล</span>
            </div>
          </div>

          {/* Email/password form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                อีเมล
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="your@email.com"
                required
                disabled={loading}
                className="h-11 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:ring-violet-500/20 focus:ring-2 transition-all"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  รหัสผ่าน
                </Label>
                <Link href="/forgot-password" className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
                  ลืมรหัสผ่าน?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  required
                  disabled={loading}
                  className="h-11 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:ring-violet-500/20 focus:ring-2 transition-all pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="group relative w-full h-11 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 overflow-hidden"
              style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
            >
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ background: "linear-gradient(135deg, #6d28d9, #1d4ed8)" }} />
              <span className="relative flex items-center justify-center gap-2">
                {loading ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    กำลังเข้าสู่ระบบ...
                  </>
                ) : (
                  <>
                    เข้าสู่ระบบ
                    <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
                  </>
                )}
              </span>
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-zinc-500">
            ยังไม่มีบัญชี?{" "}
            <Link href="/register" className="font-medium text-violet-400 hover:text-violet-300 transition-colors">
              สมัครฟรีวันนี้
            </Link>
          </p>
        </div>
        </div>
      </div>
    </div>
  );
}
