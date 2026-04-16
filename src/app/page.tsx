import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles, Palette, FileText, Video, ArrowRight } from "lucide-react";

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-linear-to-br from-zinc-950 via-purple-950/20 to-zinc-950">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -left-1/4 top-0 h-[500px] w-[500px] animate-pulse rounded-full bg-purple-500/10 blur-3xl" />
        <div className="absolute -right-1/4 top-1/3 h-[600px] w-[600px] animate-pulse rounded-full bg-blue-500/10 blur-3xl delay-1000" />
        <div className="absolute bottom-0 left-1/2 h-[400px] w-[400px] animate-pulse rounded-full bg-indigo-500/10 blur-3xl delay-500" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 py-20">
        {/* Hero Section */}
        <div className="mb-20 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-purple-500/20 bg-purple-500/10 px-4 py-2 backdrop-blur-sm">
            <Sparkles className="h-4 w-4 text-purple-400" />
            <span className="text-sm text-purple-300">
              AI-Powered Content Creation
            </span>
          </div>

          <h1 className="mb-6 bg-linear-to-r from-white via-purple-200 to-blue-200 bg-clip-text text-6xl font-bold text-transparent md:text-7xl">
            Intelligent Media Studio
          </h1>

          <p className="mx-auto mb-10 max-w-2xl text-xl text-zinc-400 md:text-2xl">
            แพลตฟอร์มสร้างคอนเทนต์โซเชียลมีเดียด้วย AI
            <br />
            <span className="text-purple-400">สร้าง • แชร์ • เติบโต</span>
          </p>

          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Link href="/register">
              <Button
                size="lg"
                className="group bg-linear-to-r from-purple-600 to-blue-600 text-white shadow-lg shadow-purple-500/50 transition-all hover:scale-105 hover:shadow-xl hover:shadow-purple-500/60"
              >
                เริ่มใช้งานฟรี
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Button>
            </Link>
            <Link href="/login">
              <Button
                size="lg"
                variant="outline"
                className="border-purple-500/30 bg-white/5 text-white backdrop-blur-sm transition-all hover:bg-white/10"
              >
                เข้าสู่ระบบ
              </Button>
            </Link>
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid gap-6 md:grid-cols-3">
          {[
            {
              icon: Palette,
              title: "จัดการสไตล์",
              description:
                "สร้างและจัดการสไตล์การเขียนแบบต่างๆ สำหรับคอนเทนต์ของคุณ",
              color: "from-purple-500 to-pink-500",
            },
            {
              icon: FileText,
              title: "สร้างคอนเทนต์",
              description:
                "แปลงข้อความหรือบทความเป็นโพสต์โซเชียลมีเดียด้วย AI",
              color: "from-blue-500 to-cyan-500",
            },
            {
              icon: Video,
              title: "สร้างวิดีโอ Avatar",
              description:
                "สร้างวิดีโออวาตาร์พูดได้จากสคริปต์และเสียงที่กำหนดเอง",
              color: "from-indigo-500 to-purple-500",
            },
          ].map((feature, i) => (
            <Card
              key={i}
              className="group relative overflow-hidden border-white/10 bg-white/5 backdrop-blur-xl transition-all hover:scale-105 hover:border-white/20 hover:bg-white/10"
            >
              <div className="absolute inset-0 bg-linear-to-br opacity-0 transition-opacity group-hover:opacity-10" />
              <CardHeader>
                <div
                  className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-linear-to-br ${feature.color} shadow-lg`}
                >
                  <feature.icon className="h-6 w-6 text-white" />
                </div>
                <CardTitle className="text-xl text-white">
                  {feature.title}
                </CardTitle>
                <CardDescription className="text-zinc-400">
                  {feature.description}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>

        {/* Stats Section */}
        <div className="mt-20 grid gap-8 md:grid-cols-3">
          {[
            { label: "Active Users", value: "10K+" },
            { label: "Content Created", value: "50K+" },
            { label: "AI Models", value: "15+" },
          ].map((stat, i) => (
            <div key={i} className="text-center">
              <div className="mb-2 bg-linear-to-r from-purple-400 to-blue-400 bg-clip-text text-4xl font-bold text-transparent">
                {stat.value}
              </div>
              <div className="text-sm text-zinc-500">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
