"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check, Zap, Crown, Building2, Loader2, AlertCircle, Sparkles,
  ArrowRight, ShieldCheck, CreditCard, Gift, HelpCircle, Flame,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PremiumBackdrop } from "@/components/layout/premium-page";
import Link from "next/link";
import { CouponBox } from "@/components/settings/coupon-box";

// ── Plan visual definitions ──────────────────────────────────────────────
type PlanKey = "FREE" | "PRO" | "BUSINESS";

interface PlanDef {
  key: PlanKey;
  name: string;
  tagline: string;
  icon: React.ElementType;
  color: string;        // hsl(...) string
  highlight?: boolean;
  badge?: string;
}

const PLAN_DEFS: PlanDef[] = [
  {
    key: "FREE", name: "Free",
    tagline: "เริ่มต้นใช้งานฟรี — ไม่ต้องใช้บัตรเครดิต",
    icon: Zap, color: "hsl(240 5% 55%)",
  },
  {
    key: "PRO", name: "Pro",
    tagline: "สำหรับ Creator ที่ต้องการเครื่องมือเต็มรูปแบบ",
    icon: Crown, color: "hsl(38 92% 55%)",
    highlight: true, badge: "ยอดนิยม",
  },
  {
    key: "BUSINESS", name: "Business",
    tagline: "สำหรับทีมงานและองค์กรธุรกิจ — Priority Support",
    icon: Building2, color: "hsl(280 80% 65%)",
  },
];

function PricingContent() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState<string | null>(null);
  const [period, setPeriod] = useState<"monthly" | "annual">("annual");
  const [method, setMethod] = useState<"card" | "promptpay">("card");
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
    fetch("/api/plans").then(r => r.json()).then(setPlanConfig).catch(() => {});
    fetch("/api/user/me").then(r => r.json()).then(d => { if (d.plan) setCurrentPlan(d.plan); }).catch(() => {});
    fetch("/api/founding/status").then(r => r.json()).then(setFounding).catch(() => {});
  }, []);

  function getPlanData(def: PlanDef) {
    if (def.key === "FREE") return { price: planConfig?.free?.price ?? 0, features: planConfig?.free?.features ?? [] };
    if (def.key === "PRO")  return { price: planConfig?.pro.price ?? 599, features: planConfig?.pro.features ?? [] };
    return { price: planConfig?.business.price ?? 990, features: planConfig?.business.features ?? [] };
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
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      window.location.href = data.url;
    } catch {
      toast.error("ไม่สามารถเชื่อมต่อ payment ได้");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-8 py-2 px-0">

      {/* ── Hero header ──────────────────────────────────────────────── */}
      <header className="text-center space-y-4 max-w-3xl mx-auto pt-4">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border"
          style={{
            background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.08), hsl(var(--accent-secondary) / 0.08))",
            borderColor: "hsl(var(--accent-primary) / 0.2)",
          }}>
          <Sparkles className="h-3.5 w-3.5" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.5} />
          <span className="text-xs font-semibold tracking-wide" style={{ color: "hsl(var(--accent-primary))" }}>
            เลือกแพ็กเกจที่เหมาะกับคุณ
          </span>
        </div>
        <h1 className="text-2xl sm:text-4xl md:text-5xl font-black tracking-tight leading-tight text-white">
          สร้างคอนเทนต์อย่าง <span className="bg-linear-to-r from-cyan-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">มืออาชีพ</span><br className="md:hidden" /> ด้วย AI
        </h1>
        <p className="text-base md:text-lg max-w-xl mx-auto text-white/60">
          เลือกได้: รายปีจ่ายครั้งเดียว หรือ รายเดือนต่ออัตโนมัติ · ยกเลิกได้ทุกเมื่อ
        </p>
      </header>

      {/* ── Billing period toggle ───────────────────────────────────── */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
          <button onClick={() => { setPeriod("monthly"); setMethod("card"); }} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "monthly" ? "bg-white/10 text-white" : "text-white/50")}>รายเดือน</button>
          <button onClick={() => setPeriod("annual")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "annual" ? "text-white" : "text-white/50")} style={period === "annual" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>รายปี · ประหยัด 2 เดือน</button>
        </div>
      </div>

      {/* ── Payment method toggle (annual only) ─────────────────────── */}
      {period === "annual" && (
        <div className="flex justify-center">
          <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
            <button onClick={() => setMethod("card")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", method === "card" ? "text-white" : "text-white/50")} style={method === "card" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>💳 บัตร · ต่ออัตโนมัติ</button>
            <button onClick={() => setMethod("promptpay")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", method === "promptpay" ? "text-white" : "text-white/50")} style={method === "promptpay" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>📱 PromptPay · จ่ายครั้งเดียว</button>
          </div>
        </div>
      )}

      {/* ── Selection reassurance caption ───────────────────────────── */}
      <p className="text-center text-xs -mt-3" style={{ color: "var(--ui-text-muted)" }}>
        {period === "monthly"
          ? "ต่ออัตโนมัติทุกเดือน · ยกเลิกได้ทุกเมื่อ"
          : method === "promptpay"
            ? "จ่ายครั้งเดียว ไม่ตัดเงินอัตโนมัติ"
            : "ต่ออัตโนมัติทุกปี · ยกเลิกได้ทุกเมื่อ"}
      </p>

      {/* ── Founding-100 banner ─────────────────────────────────────── */}
      {founding?.active && period === "annual" && !appliedCoupon && (
        <div className="flex items-center justify-center gap-3 rounded-xl p-4 max-w-2xl mx-auto"
          style={{
            background: "linear-gradient(90deg, hsl(38 92% 50% / 0.14), hsl(280 80% 60% / 0.10))",
            border: "1px solid hsl(38 92% 55% / 0.35)",
            boxShadow: "0 8px 24px hsl(38 92% 50% / 0.12)",
          }}>
          <Flame className="h-5 w-5 shrink-0 text-amber-400" strokeWidth={2.5} />
          <p className="text-sm font-semibold text-amber-200">
            ราคา Founding · ลด {founding.percentOff}% ล็อกตลอดชีพ —
            เหลืออีก <span className="font-black text-white">{founding.remaining}</span> / {founding.total} ที่นั่ง
          </p>
        </div>
      )}

      {/* ── Payment result banner ────────────────────────────────────── */}
      {paymentResult === "success" && (
        <div className="flex items-center gap-3 rounded-xl p-4 max-w-2xl mx-auto"
          style={{
            background: "linear-gradient(90deg, hsl(142 60% 50% / 0.12), hsl(142 60% 50% / 0.04))",
            border: "1px solid hsl(142 60% 50% / 0.3)",
            boxShadow: "0 8px 24px hsl(142 60% 50% / 0.15)",
          }}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "hsl(142 60% 50% / 0.2)" }}>
            <Check className="h-4 w-4 text-emerald-400" strokeWidth={2.5} />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-300">ชำระเงินสำเร็จ!</p>
            <p className="text-xs text-emerald-400/70">แพ็กเกจของคุณถูกอัปเกรดเรียบร้อย</p>
          </div>
        </div>
      )}
      {paymentResult === "cancelled" && (
        <div className="flex items-center gap-3 rounded-xl p-4 max-w-2xl mx-auto"
          style={{ background: "hsl(0 75% 60% / 0.08)", border: "1px solid hsl(0 75% 60% / 0.25)" }}>
          <AlertCircle className="h-5 w-5 text-red-400 shrink-0" />
          <p className="text-sm text-red-300">ยกเลิกการชำระเงิน — คุณสามารถลองใหม่ได้</p>
        </div>
      )}

      {/* ── Coupon redemption ───────────────────────────────────────── */}
      <div className="max-w-xl mx-auto mb-8">
        <CouponBox onDiscountApplied={(c) => setAppliedCoupon({ code: c.code, percentOff: c.percentOff })} />
        {appliedCoupon && (
          <div className="mt-2 flex items-center justify-center gap-2 text-xs" style={{ color: "hsl(142 60% 60%)" }}>
            <span>ใช้โค้ด {appliedCoupon.code} · ลด {appliedCoupon.percentOff}%</span>
            <button onClick={() => setAppliedCoupon(null)} className="underline opacity-80 hover:opacity-100">ลบ</button>
          </div>
        )}
      </div>

      {/* ── Plan cards ──────────────────────────────────────────────── */}
      <div className="grid gap-5 grid-cols-1 md:grid-cols-3 max-w-6xl mx-auto">
        {PLAN_DEFS.map((def) => {
          const Icon = def.icon;
          const { price, features } = getPlanData(def);
          const isCurrent = currentPlan === def.key;
          const isPaid = def.key !== "FREE";
          const isLoading = loading === def.key;

          return (
            <div key={def.key} className="relative">
              {/* Highlight ring (outer glow) for featured plan */}
              {def.highlight && (
                <div
                  aria-hidden
                  className="absolute -inset-px rounded-2xl pointer-events-none"
                  style={{
                    background: `linear-gradient(135deg, ${def.color}, hsl(var(--accent-secondary)))`,
                    opacity: 0.6,
                    filter: "blur(20px)",
                    zIndex: -1,
                  }}
                />
              )}

              {/* Card */}
              <div
                className={cn(
                  "relative rounded-2xl p-8 flex flex-col h-full transition-all duration-300",
                  def.highlight ? "premium-card-featured" : "premium-card",
                  isCurrent && "ring-2 ring-offset-2 ring-offset-[hsl(240_10%_4%)]",
                )}
                style={{
                  ...(isCurrent && { boxShadow: `0 0 0 2px ${def.color}` }),
                  ...(def.highlight && { transform: "scale(1.02)" }),
                }}
              >
                {/* Badge */}
                {def.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <div
                      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide"
                      style={{
                        background: `linear-gradient(135deg, ${def.color}, hsl(var(--accent-secondary)))`,
                        color: "#fff",
                        boxShadow: `0 6px 16px ${def.color}66`,
                      }}
                    >
                      <Sparkles className="h-3 w-3" strokeWidth={2.5} />
                      {def.badge}
                    </div>
                  </div>
                )}

                {/* Header */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-xl"
                      style={{
                        background: `${def.color}15`,
                        border: `1px solid ${def.color}30`,
                        boxShadow: `0 4px 14px ${def.color}1f, inset 0 1px 0 rgba(255,255,255,0.06)`,
                      }}
                    >
                      <Icon className="h-5 w-5" style={{ color: def.color }} strokeWidth={2.25} />
                    </div>
                    {isCurrent && (
                      <span
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"
                        style={{
                          background: `${def.color}15`,
                          color: def.color,
                          border: `1px solid ${def.color}30`,
                        }}
                      >
                        <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
                        Active
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                      {def.name}
                    </h3>
                    <p className="text-sm leading-snug" style={{ color: "var(--ui-text-muted)" }}>
                      {def.tagline}
                    </p>
                  </div>
                </div>

                {/* Price */}
                <div className="my-7 pb-7 border-b border-white/6">
                  {price === 0 ? (
                    <div className="flex items-baseline gap-2">
                      <span className="text-5xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>ฟรี</span>
                      <span className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ตลอดไป</span>
                    </div>
                  ) : (() => {
                    const base = period === "annual" ? price * 10 : price;
                    // manual coupon wins; otherwise the founding price applies on annual while seats remain
                    const foundingPct = (!appliedCoupon && founding?.active && period === "annual") ? founding.percentOff : 0;
                    const pct = appliedCoupon?.percentOff ?? foundingPct;
                    const isFoundingPrice = !appliedCoupon && foundingPct > 0;
                    const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
                    return (
                      <div className="flex items-baseline gap-1 flex-wrap">
                        <span className="text-2xl font-semibold mt-2" style={{ color: "var(--ui-text-muted)" }}>฿</span>
                        <span className="text-5xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                          {final.toLocaleString()}
                        </span>
                        <span className="text-sm ml-1" style={{ color: "var(--ui-text-muted)" }}>{period === "annual" ? "/ปี" : "/30 วัน"}</span>
                        {pct > 0 && (
                          <span className="ml-2 text-sm line-through" style={{ color: "var(--ui-text-muted)" }}>฿{base.toLocaleString()}</span>
                        )}
                        {pct > 0 && (
                          <span className="ml-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
                            style={isFoundingPrice
                              ? { background: "hsl(38 92% 50% / 0.18)", color: "hsl(38 92% 62%)" }
                              : { background: "hsl(142 60% 50% / 0.15)", color: "hsl(142 60% 60%)" }}>
                            {isFoundingPrice ? `Founding · ลด ${pct}% ตลอดชีพ` : `ลด ${pct}%`}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Features */}
                <ul className="space-y-3 flex-1 mb-7 min-h-50">
                  {features.length === 0 ? null : (
                    features.map((feat) => {
                      const text = typeof feat === "object" ? (feat as any).text : feat;
                      return (
                        <li key={text} className="flex items-start gap-3">
                          <div
                            className="flex h-5 w-5 items-center justify-center rounded-full shrink-0 mt-0.5"
                            style={{
                              background: `${def.color}15`,
                              border: `1px solid ${def.color}30`,
                            }}
                          >
                            <Check className="h-3 w-3" style={{ color: def.color }} strokeWidth={3} />
                          </div>
                          <span className="text-sm leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
                            {text}
                          </span>
                        </li>
                      );
                    })
                  )}
                </ul>

                {/* CTA */}
                {isPaid ? (
                  <button
                    onClick={() => handleUpgrade(def.key as "PRO" | "BUSINESS")}
                    disabled={isCurrent || isLoading}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold tracking-tight",
                      "transition-[transform,box-shadow,filter] duration-200 ease-out",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      !isCurrent && !loading && "hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]",
                    )}
                    style={{
                      background: isCurrent
                        ? "rgba(255,255,255,0.05)"
                        : `linear-gradient(135deg, ${def.color}, ${def.color}aa)`,
                      border: `1px solid ${isCurrent ? "rgba(255,255,255,0.12)" : def.color}`,
                      color: isCurrent ? "rgba(255,255,255,0.5)" : "#fff",
                      boxShadow: isCurrent
                        ? "none"
                        : `0 10px 28px ${def.color}55, inset 0 1px 0 rgba(255,255,255,0.15)`,
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
                  <div
                    className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold"
                    style={{ background: `${def.color}15`, border: `1px solid ${def.color}40`, color: def.color }}
                  >
                    <ShieldCheck className="h-4 w-4" strokeWidth={2.5} />
                    แผนปัจจุบันของคุณ
                  </div>
                ) : (
                  <Link
                    href="/dashboard"
                    className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all hover:-translate-y-0.5"
                    style={{ background: "transparent", border: "1px solid hsl(0 0% 100% / 0.08)", color: "var(--ui-text-muted)" }}
                  >
                    เริ่มสร้างวิดีโอ
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Trust + payment info row ────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3 max-w-5xl mx-auto pt-4">
        {[
          { icon: CreditCard, label: "ชำระผ่าน Stripe", desc: "บัตรเครดิต / เดบิต ปลอดภัย" },
          { icon: ShieldCheck, label: "ไม่ตัดเงินอัตโนมัติ", desc: "ใช้ครบกำหนดแล้วต่ออายุเอง" },
          { icon: Gift, label: "ใช้คูปองได้", desc: "กรอกโค้ดด้านบนได้เลย" },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="pp-card p-5 flex items-start gap-3">
            <span aria-hidden className="pp-card-border" />
            <div
              className="relative flex h-9 w-9 items-center justify-center rounded-lg shrink-0"
              style={{
                background: "hsl(var(--accent-primary) / 0.08)",
                border: "1px solid hsl(var(--accent-primary) / 0.18)",
              }}
            >
              <Icon className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2} />
            </div>
            <div className="relative">
              <p className="text-sm font-bold text-white">{label}</p>
              <p className="text-xs mt-0.5 text-white/50">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── FAQ teaser ──────────────────────────────────────────────── */}
      <div className="pp-card p-6 max-w-3xl mx-auto flex items-center gap-4">
        <span aria-hidden className="pp-card-border" />
        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
          style={{
            background: "hsl(var(--accent-secondary) / 0.1)",
            border: "1px solid hsl(var(--accent-secondary) / 0.2)",
          }}>
          <HelpCircle className="h-5 w-5" style={{ color: "hsl(var(--accent-secondary))" }} strokeWidth={2} />
        </div>
        <div className="relative flex-1">
          <p className="text-sm font-bold text-white">มีคำถาม?</p>
          <p className="text-xs mt-0.5 text-white/50">
            ติดต่อทีมงานผ่าน Support — Pro/Business ตอบกลับภายใน 24 ชม.
          </p>
        </div>
      </div>

    </div>
  );
}

export default function PricingPage() {
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <PremiumBackdrop />
      <div className="relative z-10 px-4 md:px-6 pt-3 md:pt-4 pb-12">
        <Suspense fallback={null}>
          <PricingContent />
        </Suspense>
      </div>
    </div>
  );
}
