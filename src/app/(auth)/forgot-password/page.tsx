"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error);
      } else {
        setSent(true);
        toast.success("ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว");
      }
    } catch {
      toast.error("เกิดข้อผิดพลาด กรุณาลองใหม่");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#080810] px-4">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-6 py-4 backdrop-blur-md border-b border-white/5 z-50"
        style={{ background: "rgba(8,8,16,0.8)" }}>
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-500 to-cyan-500">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight text-white">Hero AI Creator Studio</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-zinc-400 hover:text-white transition-colors">เข้าสู่ระบบ</Link>
          <Link href="/register"
            className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-all hover:opacity-90 text-white"
            style={{ background: "linear-gradient(135deg, #7c3aed, #06b6d4)" }}>
            เริ่มฟรี
          </Link>
        </div>
      </nav>

      {/* Animated background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 h-125 w-125 rounded-full bg-violet-600/10 blur-[120px]" />
        <div className="absolute top-1/3 right-1/4 h-75 w-75 rounded-full bg-purple-500/8 blur-[80px]" />
      </div>

      <div className="flex flex-1 items-center justify-center py-12">
        <Card className="relative z-10 w-full max-w-md border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl text-white">ลืมรหัสผ่าน</CardTitle>
            <CardDescription className="text-zinc-400">
              กรอกอีเมลเพื่อรับลิงก์รีเซ็ตรหัสผ่าน
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="space-y-4 text-center">
                <p className="text-zinc-300">
                  หากอีเมลนี้มีอยู่ในระบบ เราได้ส่งลิงก์รีเซ็ตรหัสผ่านไปแล้ว
                  กรุณาตรวจสอบอีเมลของคุณ
                </p>
                <Link href="/login">
                  <Button variant="outline" className="w-full border-white/10 text-white hover:bg-white/10">
                    กลับไปหน้าเข้าสู่ระบบ
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">อีเมล</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      placeholder="your@email.com"
                      required
                      disabled={loading}
                      className="border-white/10 bg-white/5 text-white placeholder:text-zinc-500 focus:border-purple-500 focus:ring-purple-500"
                    />
                  </div>
                  <Button type="submit" className="w-full bg-linear-to-r from-purple-600 to-blue-600 text-white" disabled={loading}>
                    {loading ? "กำลังส่ง..." : "ส่งลิงก์รีเซ็ตรหัสผ่าน"}
                  </Button>
                </form>
                <p className="mt-4 text-center text-sm text-zinc-400">
                  จำรหัสผ่านได้แล้ว?{" "}
                  <Link href="/login" className="font-medium text-purple-400 hover:text-purple-300 transition-colors">
                    เข้าสู่ระบบ
                  </Link>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
