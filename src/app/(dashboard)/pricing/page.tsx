"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Captions,
  Check,
  ChevronDown,
  Clapperboard,
  CreditCard,
  Crown,
  Film,
  Flame,
  Gift,
  HelpCircle,
  Loader2,
  Music4,
  ShieldCheck,
  Sparkles,
  Wallet,
  Zap,
  Building2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PremiumBackdrop } from "@/components/layout/premium-page";
import { CouponBox } from "@/components/settings/coupon-box";
import { computeDisplayPrice } from "@/lib/pricing-display";

type PlanKey = "FREE" | "PRO" | "BUSINESS";
type BillingPeriod = "monthly" | "annual";
type PaymentMethod = "card" | "promptpay";

interface PlanDef {
  key: PlanKey;
  name: string;
  tagline: string;
  icon: React.ElementType;
  color: string;
  highlight?: boolean;
  badge?: string;
}

const PLAN_DEFS: PlanDef[] = [
  {
    key: "FREE",
    name: "Free",
    tagline: "เริ่มลองระบบได้ทันที ไม่ต้องผูกบัตร",
    icon: Zap,
    color: "#94a3b8",
  },
  {
    key: "PRO",
    name: "Pro",
    tagline: "สำหรับ creator ที่ต้องการทำคลิปเร็วขึ้นแบบเห็นผลจริง",
    icon: Crown,
    color: "#f59e0b",
    highlight: true,
    badge: "ยอดนิยม",
  },
  {
    key: "BUSINESS",
    name: "Business",
    tagline: "สำหรับทีมงานที่ต้องการปริมาณมากขึ้นและซัพพอร์ตที่เร็วกว่า",
    icon: Building2,
    color: "#a855f7",
  },
];

const FEATURE_CARDS = [
  {
    title: "AI Avatar",
    desc: "ทำคลิปได้ทั้งแบบมี Avatar เต็มคลิป หรือเฉพาะเปิด-ปิด",
    icon: Bot,
    accent: "from-violet-500/30 to-fuchsia-500/20",
  },
  {
    title: "ซับไทยอัตโนมัติ",
    desc: "ได้ทั้งซับประโยคยาวและสไตล์ keyword สำหรับคลิปไวรัล",
    icon: Captions,
    accent: "from-cyan-500/30 to-sky-500/20",
  },
  {
    title: "B-roll อัตโนมัติ",
    desc: "สลับภาพประกอบทุก 3-5 วินาทีตามเนื้อหา ลดเวลาตัดเอง",
    icon: Film,
    accent: "from-amber-500/30 to-orange-500/20",
  },
  {
    title: "เพลงและจังหวะคลิป",
    desc: "ใส่เพลงประกอบและโทนวิดีโอให้พร้อมโพสต์ทันที",
    icon: Music4,
    accent: "from-emerald-500/30 to-teal-500/20",
  },
];

const STEPS = [
  {
    step: "01",
    title: "วางสคริปต์",
    desc: "มีแค่สคริปต์หนึ่งชุดก็เริ่มงานได้เลย",
  },
  {
    step: "02",
    title: "เลือกสไตล์",
    desc: "กำหนด Avatar ซับ เพลง และแนวภาพประกอบ",
  },
  {
    step: "03",
    title: "กดสร้างคลิป",
    desc: "ระบบเรนเดอร์ให้พร้อมใช้งานและพร้อมโพสต์",
  },
];

const FAQS = [
  {
    q: "รายปีแบบ PromptPay ตัดเงินอัตโนมัติไหม?",
    a: "ไม่ตัดอัตโนมัติ เป็นการชำระครั้งเดียว ใช้งานได้ 1 ปี แล้วค่อยต่ออายุเองเมื่อพร้อม",
  },
  {
    q: "ถ้าเลือกจ่ายรายเดือนหรือรายปีด้วยบัตร ยกเลิกได้ไหม?",
    a: "ได้ สามารถจัดการ subscription ผ่าน billing portal และใช้งานต่อได้จนจบรอบที่ชำระไว้",
  },
  {
    q: "ใช้คูปองส่วนลดได้ไหม?",
    a: "ได้ ถ้ามีโค้ดส่วนลดสามารถกรอกในส่วน pricing ก่อน checkout ได้ทันที",
  },
  {
    q: "เหมาะกับใครที่สุด?",
    a: "เหมาะกับ creator สาย faceless, เพจความรู้, เพจขายของ และทีมที่ต้องการผลิต short-form content ให้ไวขึ้น",
  },
];

function PricingContent() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState<string | null>(null);
  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [faqOpen, setFaqOpen] = useState<number>(0);
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
  const [founding, setFounding] = useState<{ active: boolean; remaining: number; total: number; percentOff: number } | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>("FREE");
  const [planConfig, setPlanConfig] = useState<{
    free?: { price: number; features: string[] };
    pro: { price: number; features: string[] };
    business: { price: number; features: string[] };
  } | null>(null);

  const paymentResult = searchParams.get("payment");

  useEffect(() => {
    fetch("/api/plans").then((r) => r.json()).then(setPlanConfig).catch(() => {});
    fetch("/api/user/me").then((r) => r.json()).then((d) => {
      if (d.plan) setCurrentPlan(d.plan);
    }).catch(() => {});
    fetch("/api/founding/status").then((r) => r.json()).then(setFounding).catch(() => {});
  }, []);

  function getPlanData(def: PlanDef) {
    if (def.key === "FREE") {
      return { price: planConfig?.free?.price ?? 0, features: planConfig?.free?.features ?? [] };
    }
    if (def.key === "PRO") {
      return { price: planConfig?.pro.price ?? 599, features: planConfig?.pro.features ?? [] };
    }
    return { price: planConfig?.business.price ?? 990, features: planConfig?.business.features ?? [] };
  }

  function getDisplayPrice(baseMonthlyPrice: number) {
    return computeDisplayPrice({
      monthlyPrice: baseMonthlyPrice,
      period,
      coupon: appliedCoupon,
      founding,
    });
  }

  async function handleUpgrade(planKey: "PRO" | "BUSINESS") {
    setLoading(planKey);
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planKey, period, method, couponCode: appliedCoupon?.code }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "เกิดข้อผิดพลาด");
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("ไม่สามารถเชื่อมต่อ payment ได้");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.18),transparent_55%)]" />
      <div className="absolute -left-28 top-24 -z-10 h-72 w-72 rounded-full bg-violet-500/18 blur-3xl" />
      <div className="absolute -right-20 top-52 -z-10 h-72 w-72 rounded-full bg-cyan-500/16 blur-3xl" />

      <div className="sticky top-0 z-20 mb-8 border-b border-white/8 bg-[rgba(5,10,21,0.72)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 py-3 text-center md:px-6">
          {founding?.active && !appliedCoupon ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-[11px] font-bold tracking-[0.14em] text-amber-200 uppercase">
                <Flame className="h-3.5 w-3.5" strokeWidth={2.5} />
                Founding
              </span>
              <p className="text-sm text-white/80">
                ราคา Founding ลด {founding.percentOff}% ล็อกตลอดชีพ — เหลืออีก{" "}
                <span className="font-black text-white">{founding.remaining}</span>/{founding.total} ที่นั่ง
              </p>
            </>
          ) : (
            <>
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-cyan-200 uppercase">
                Founding Offer
              </span>
              <p className="text-sm text-white/70">รายปีมีทั้งแบบบัตรต่ออัตโนมัติ และ PromptPay จ่ายครั้งเดียว</p>
            </>
          )}
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-cyan-400 to-violet-500 px-4 py-2 text-xs font-bold text-slate-950 transition-transform hover:-translate-y-0.5"
          >
            ดูราคา
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </a>
        </div>
      </div>

      <section className="mx-auto max-w-7xl px-4 pb-12 md:px-6">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-400/10 px-4 py-2 text-xs font-semibold tracking-wide text-violet-100">
              <Sparkles className="h-3.5 w-3.5 text-cyan-300" strokeWidth={2.5} />
              สำหรับสาย Faceless และทีมทำคอนเทนต์
            </div>

            <div className="space-y-4">
              <h1 className="max-w-4xl text-4xl font-black tracking-tight text-white sm:text-5xl lg:text-6xl">
                มีแค่ <span className="bg-linear-to-r from-cyan-300 via-sky-200 to-violet-300 bg-clip-text text-transparent">สคริปต์ 1 ชุด</span>
                <br />
                ก็ได้คลิปพร้อมโพสต์แบบอัตโนมัติ
              </h1>
              <p className="max-w-2xl text-base leading-7 text-white/62 sm:text-lg">
                HERO AI ช่วยรวม Avatar, ซับไทย, B-roll, เพลง และ flow ตัดต่อไว้ในที่เดียว
                เพื่อให้จากงานที่เคยใช้เวลาหลายชั่วโมง เหลือเพียงไม่กี่ขั้นตอนก่อนพร้อมลงคลิป
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <a
                href="#pricing"
                className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-cyan-400 to-violet-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-[0_12px_40px_rgba(34,211,238,0.24)] transition-transform hover:-translate-y-0.5"
              >
                เลือกแพ็กเกจ
                <ArrowRight className="h-4 w-4" strokeWidth={2.75} />
              </a>
              <Link
                href="/video-creator"
                className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/4 px-6 py-3 text-sm font-semibold text-white/84 transition-colors hover:bg-white/8"
              >
                <Clapperboard className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
                ไปหน้าสร้างวิดีโอ
              </Link>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { label: "Avatar + Faceless", sub: "เลือก flow ที่เหมาะกับคลิป" },
                { label: "PromptPay หรือบัตร", sub: "ชำระได้ตามรูปแบบที่ต้องการ" },
                { label: "ใช้คูปองได้", sub: "รองรับส่วนลดก่อน checkout" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                >
                  <p className="text-sm font-semibold text-white">{item.label}</p>
                  <p className="mt-1 text-xs leading-5 text-white/52">{item.sub}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-4 rounded-[2rem] bg-linear-to-br from-violet-500/25 via-cyan-500/12 to-transparent blur-2xl" />
            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#09111f]/90 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.35)]">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/72">Demo Flow</p>
                  <p className="mt-1 text-lg font-bold text-white">จากสคริปต์สู่คลิปพร้อมโพสต์</p>
                </div>
                <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                  พร้อมขายแล้ว
                </div>
              </div>

              <div className="space-y-3">
                {[
                  "วางสคริปต์",
                  "เลือก Avatar / Subtitle / เพลง",
                  "ระบบจัดลำดับและเรนเดอร์อัตโนมัติ",
                  "ดาวน์โหลดหรือไปต่อใน editor",
                ].map((item, index) => (
                  <div
                    key={item}
                    className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br from-violet-500 to-cyan-400 text-sm font-black text-slate-950">
                      {index + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-white">{item}</p>
                    </div>
                    <Check className="h-4 w-4 text-cyan-300" strokeWidth={3} />
                  </div>
                ))}
              </div>

              <div className="mt-5 rounded-2xl border border-cyan-400/14 bg-cyan-400/8 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100/80">Payment Options</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <p className="text-sm font-semibold text-white">บัตร</p>
                    <p className="mt-1 text-xs leading-5 text-white/54">เหมาะกับ monthly และ annual แบบต่ออัตโนมัติ</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <p className="text-sm font-semibold text-white">PromptPay</p>
                    <p className="mt-1 text-xs leading-5 text-white/54">รายปีแบบจ่ายครั้งเดียว ไม่ตัดเงินอัตโนมัติ</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-6 md:px-6">
        <div className="grid gap-4 md:grid-cols-4">
          {FEATURE_CARDS.map(({ title, desc, icon: Icon, accent }) => (
            <div
              key={title}
              className="relative overflow-hidden rounded-[1.75rem] border border-white/8 bg-white/[0.04] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              <div className={cn("absolute inset-x-0 top-0 h-24 bg-linear-to-br opacity-60 blur-2xl", accent)} />
              <div className="relative space-y-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-black/20">
                  <Icon className="h-5 w-5 text-cyan-300" strokeWidth={2.3} />
                </div>
                <div>
                  <p className="text-base font-bold text-white">{title}</p>
                  <p className="mt-2 text-sm leading-6 text-white/56">{desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-14 md:px-6">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/72">How It Works</p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            เปลี่ยนงานตัดต่อหลายขั้น ให้เหลือ flow เดียว
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map((item) => (
            <div
              key={item.step}
              className="rounded-[1.75rem] border border-white/8 bg-white/[0.035] p-6 text-center"
            >
              <p className="bg-linear-to-r from-cyan-300 to-violet-300 bg-clip-text text-5xl font-black text-transparent">
                {item.step}
              </p>
              <p className="mt-4 text-lg font-bold text-white">{item.title}</p>
              <p className="mt-2 text-sm leading-6 text-white/56">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-7xl scroll-mt-28 px-4 py-10 md:px-6">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/72">Pricing</p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            เลือกรูปแบบจ่ายที่ตรงกับวิธีทำงานของคุณ
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-white/58 sm:text-base">
            รายเดือนเหมาะกับคนอยากเริ่มไว รายปีคุ้มกว่า และถ้าต้องการจ่ายครั้งเดียวสามารถเลือก PromptPay ได้
          </p>
        </div>

        <div className="mx-auto mb-8 flex max-w-xl justify-center">
          <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
            <button
              onClick={() => {
                setPeriod("monthly");
                setMethod("card");
              }}
              className={cn(
                "rounded-full px-5 py-2 text-sm font-semibold transition",
                period === "monthly" ? "bg-white/10 text-white" : "text-white/50",
              )}
            >
              รายเดือน
            </button>
            <button
              onClick={() => setPeriod("annual")}
              className={cn(
                "rounded-full px-5 py-2 text-sm font-semibold transition",
                period === "annual" ? "text-white" : "text-white/50",
              )}
              style={period === "annual" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}
            >
              รายปี · ประหยัด 2 เดือน
            </button>
          </div>
        </div>

        {period === "annual" && (
          <div className="mx-auto mb-4 flex max-w-xl justify-center">
            <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
              <button
                onClick={() => setMethod("card")}
                className={cn(
                  "rounded-full px-5 py-2 text-sm font-semibold transition",
                  method === "card" ? "text-white" : "text-white/50",
                )}
                style={method === "card" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}
              >
                💳 บัตร · ต่ออัตโนมัติ
              </button>
              <button
                onClick={() => setMethod("promptpay")}
                className={cn(
                  "rounded-full px-5 py-2 text-sm font-semibold transition",
                  method === "promptpay" ? "text-white" : "text-white/50",
                )}
                style={method === "promptpay" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}
              >
                📱 PromptPay · จ่ายครั้งเดียว
              </button>
            </div>
          </div>
        )}

        <p className="mb-8 text-center text-xs text-white/48">
          {period === "monthly"
            ? "รายเดือนเป็น subscription แบบต่ออัตโนมัติ ยกเลิกได้ทุกเมื่อ"
            : method === "promptpay"
              ? "PromptPay เป็นรายปีแบบชำระครั้งเดียว ไม่มีการตัดเงินอัตโนมัติ"
              : "รายปีแบบบัตรจะต่ออัตโนมัติทุกปี และยกเลิกได้จาก billing portal"}
        </p>

        {paymentResult === "success" && (
          <div className="mx-auto mb-6 flex max-w-2xl items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-400/15">
              <Check className="h-4 w-4 text-emerald-300" strokeWidth={3} />
            </div>
            <div>
              <p className="text-sm font-semibold text-emerald-200">ชำระเงินสำเร็จ</p>
              <p className="text-xs text-emerald-200/72">ระบบอัปเกรดแพ็กเกจให้เรียบร้อยแล้ว</p>
            </div>
          </div>
        )}

        {paymentResult === "cancelled" && (
          <div className="mx-auto mb-6 flex max-w-2xl items-center gap-3 rounded-2xl border border-red-400/25 bg-red-400/10 p-4">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-300" />
            <p className="text-sm text-red-200">ยกเลิกการชำระเงินแล้ว คุณสามารถกลับมาเลือกแพ็กเกจใหม่ได้ทุกเมื่อ</p>
          </div>
        )}

        <div className="mx-auto mb-8 max-w-xl">
          <CouponBox onDiscountApplied={(coupon) => setAppliedCoupon({ code: coupon.code, percentOff: coupon.percentOff })} />
          {appliedCoupon && (
            <div className="mt-3 flex items-center justify-center gap-2 text-xs text-emerald-300">
              <span>ใช้โค้ด {appliedCoupon.code} ลด {appliedCoupon.percentOff}% แล้ว</span>
              <button className="underline opacity-80 hover:opacity-100" onClick={() => setAppliedCoupon(null)}>
                ลบ
              </button>
            </div>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          {PLAN_DEFS.map((def) => {
            const Icon = def.icon;
            const { price, features } = getPlanData(def);
            const isCurrent = currentPlan === def.key;
            const isPaid = def.key !== "FREE";
            const isLoading = loading === def.key;
            const display = price > 0 ? getDisplayPrice(price) : null;

            return (
              <div key={def.key} className="relative">
                {def.highlight && (
                  <div
                    aria-hidden
                    className="absolute -inset-2 rounded-[2rem] bg-linear-to-br from-amber-400/20 via-violet-500/15 to-cyan-400/20 blur-2xl"
                  />
                )}

                <div
                  className={cn(
                    "relative flex h-full flex-col rounded-[2rem] border bg-[#08101d]/88 p-7 shadow-[0_18px_60px_rgba(0,0,0,0.28)]",
                    def.highlight ? "border-amber-300/30" : "border-white/8",
                    isCurrent && "ring-2 ring-cyan-300/50",
                  )}
                >
                  {def.badge && (
                    <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
                      <div className="rounded-full bg-linear-to-r from-amber-300 to-orange-400 px-4 py-1.5 text-xs font-bold text-slate-950">
                        {def.badge}
                      </div>
                    </div>
                  )}

                  <div className="mb-6 flex items-start justify-between gap-4">
                    <div>
                      <div
                        className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10"
                        style={{ background: `${def.color}18` }}
                      >
                        <Icon className="h-5 w-5" style={{ color: def.color }} strokeWidth={2.4} />
                      </div>
                      <p className="text-2xl font-black tracking-tight text-white">{def.name}</p>
                      <p className="mt-2 text-sm leading-6 text-white/56">{def.tagline}</p>
                    </div>
                    {isCurrent && (
                      <div className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-100">
                        Active
                      </div>
                    )}
                  </div>

                  <div className="mb-6 border-b border-white/8 pb-6">
                    {price === 0 ? (
                      <div className="flex items-end gap-2">
                        <span className="text-5xl font-black tracking-tight text-white">ฟรี</span>
                        <span className="pb-1 text-sm text-white/48">ตลอดไป</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-end gap-2">
                          <span className="pb-2 text-xl text-white/46">฿</span>
                          <span className="text-5xl font-black tracking-tight text-white">
                            {display?.final.toLocaleString()}
                          </span>
                          <span className="pb-2 text-sm text-white/48">
                            {period === "annual" ? "/ปี" : "/30 วัน"}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          {display && display.pct > 0 && (
                            <>
                              <span className="text-white/36 line-through">฿{display.base.toLocaleString()}</span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-1 font-bold",
                                  display.isFounding ? "bg-amber-400/14 text-amber-300" : "bg-emerald-400/12 text-emerald-300",
                                )}
                              >
                                {display.isFounding ? `Founding · ลด ${display.pct}% ตลอดชีพ` : `ลด ${display.pct}%`}
                              </span>
                            </>
                          )}
                          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/55">
                            {period === "annual"
                              ? method === "promptpay"
                                ? "จ่ายครั้งเดียว"
                                : "ต่ออัตโนมัติ"
                              : "ต่ออัตโนมัติรายเดือน"}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  <ul className="mb-7 flex-1 space-y-3">
                    {features.map((feat) => {
                      const text = typeof feat === "object" ? (feat as { text: string }).text : feat;
                      return (
                        <li key={text} className="flex items-start gap-3">
                          <div
                            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10"
                            style={{ background: `${def.color}18` }}
                          >
                            <Check className="h-3 w-3" style={{ color: def.color }} strokeWidth={3.2} />
                          </div>
                          <span className="text-sm leading-6 text-white/68">{text}</span>
                        </li>
                      );
                    })}
                  </ul>

                  {isPaid ? (
                    <button
                      onClick={() => handleUpgrade(def.key as "PRO" | "BUSINESS")}
                      disabled={isCurrent || isLoading}
                      className={cn(
                        "inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition-all",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        !isCurrent && !isLoading && "hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:scale-[0.99]",
                      )}
                      style={{
                        background: isCurrent
                          ? "rgba(255,255,255,0.05)"
                          : `linear-gradient(135deg, ${def.color}, ${def.color}cc)`,
                        color: isCurrent ? "rgba(255,255,255,0.52)" : "#fff",
                        border: `1px solid ${isCurrent ? "rgba(255,255,255,0.1)" : def.color}`,
                        boxShadow: isCurrent ? "none" : `0 14px 34px ${def.color}40`,
                      }}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : isCurrent ? (
                        <>
                          <ShieldCheck className="h-4 w-4" strokeWidth={2.5} />
                          แผนปัจจุบันของคุณ
                        </>
                      ) : (
                        <>
                          อัปเกรดเป็น {def.name}
                          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
                        </>
                      )}
                    </button>
                  ) : isCurrent ? (
                    <div className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm font-bold text-cyan-100">
                      <ShieldCheck className="h-4 w-4" strokeWidth={2.5} />
                      แผนปัจจุบันของคุณ
                    </div>
                  ) : (
                    <Link
                      href="/dashboard"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm font-semibold text-white/80 transition-colors hover:bg-white/7"
                    >
                      เริ่มใช้ฟรี
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: CreditCard,
              label: "Stripe Checkout",
              desc: "รองรับบัตรเครดิตและเดบิตแบบปลอดภัย",
            },
            {
              icon: Wallet,
              label: "PromptPay Annual",
              desc: "ทางเลือกสำหรับคนที่ต้องการจ่ายปีเดียวแบบไม่ต่ออัตโนมัติ",
            },
            {
              icon: Gift,
              label: "คูปองส่วนลด",
              desc: "กรอกโค้ดก่อน checkout เพื่อเห็นราคาหลังลดทันที",
            },
          ].map(({ icon: Icon, label, desc }) => (
            <div key={label} className="rounded-[1.5rem] border border-white/8 bg-white/[0.04] p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/16 bg-cyan-300/10">
                  <Icon className="h-4 w-4 text-cyan-300" strokeWidth={2.1} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-white/54">{desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-14 md:px-6">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/72">FAQ</p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
            คำถามที่ถูกถามบ่อยก่อนตัดสินใจ
          </h2>
        </div>

        <div className="space-y-3">
          {FAQS.map((item, index) => {
            const open = faqOpen === index;
            return (
              <button
                key={item.q}
                type="button"
                onClick={() => setFaqOpen(open ? -1 : index)}
                className="w-full rounded-[1.5rem] border border-white/8 bg-white/[0.035] p-5 text-left transition-colors hover:bg-white/[0.05]"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-300/14 bg-violet-300/10">
                    <HelpCircle className="h-4 w-4 text-violet-200" strokeWidth={2.1} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-bold text-white sm:text-base">{item.q}</p>
                      <ChevronDown
                        className={cn("h-4 w-4 shrink-0 text-white/48 transition-transform", open && "rotate-180")}
                        strokeWidth={2.5}
                      />
                    </div>
                    {open && <p className="mt-3 text-sm leading-6 text-white/58">{item.a}</p>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 md:px-6">
        <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-linear-to-br from-[#0a1324] via-[#0a1020] to-[#11192f] p-8 text-center shadow-[0_20px_80px_rgba(0,0,0,0.32)] sm:p-10">
          <div className="mx-auto max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/16 bg-cyan-300/10 px-4 py-2 text-xs font-semibold tracking-[0.18em] text-cyan-100 uppercase">
              Ready To Start
            </div>
            <h2 className="mt-5 text-3xl font-black tracking-tight text-white sm:text-4xl">
              เริ่มทำคอนเทนต์ให้ไวขึ้น ตั้งแต่คลิปถัดไปของคุณ
            </h2>
            <p className="mt-4 text-sm leading-6 text-white/58 sm:text-base">
              ถ้าพร้อมจะเปลี่ยน workflow จากการตัดมือ มาเป็นระบบที่ช่วยประกอบคลิปให้อัตโนมัติมากขึ้น
              ให้เลือกแพ็กที่เหมาะ แล้วเริ่มได้ทันทีจากหน้า pricing นี้
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a
                href="#pricing"
                className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-cyan-400 to-violet-500 px-6 py-3 text-sm font-bold text-slate-950 transition-transform hover:-translate-y-0.5"
              >
                เลือกแพ็กเกจตอนนี้
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
              </a>
              <Link
                href="/settings?tab=billing"
                className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/4 px-6 py-3 text-sm font-semibold text-white/80 transition-colors hover:bg-white/8"
              >
                จัดการบิลปัจจุบัน
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function PricingPage() {
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <PremiumBackdrop />
      <div className="relative z-10 pb-12">
        <Suspense fallback={null}>
          <PricingContent />
        </Suspense>
      </div>
    </div>
  );
}
