"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { SupportModal } from "@/components/ui/support-modal";
import {
  User, Key, ExternalLink, Ticket, Crown, Loader2, MessageCircle,
  CreditCard, Check, Clock, ArrowRight, Sparkles, ShieldCheck, XCircle, Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CouponBox } from "@/components/settings/coupon-box";
import { ManageSubscriptionButton } from "@/components/settings/manage-subscription-button";
import { ReactivateBanner } from "@/components/settings/reactivate-banner";
import { McpAccessSettings } from "@/components/settings/mcp-access-settings";
import { QuotaStatus } from "@/components/quota-status";
import { CreditsBillingSection } from "@/components/settings/credits-billing-section";

// CouponBox moved to @/components/settings/coupon-box (shared with the pricing page)

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";

// .ve-card / .ve-card-hover now live in globals.css (Editor v2 house utilities).

// ── Billing Tab ──────────────────────────────────────────────────────────
interface PaymentRecord {
  id: string;
  plan: string;
  amount: number;
  currency: string;
  status: string;
  periodDays: number;
  createdAt: string;
  paidAt: string | null;
}

type PaymentPopupState = "confirming" | "confirmed" | "delayed" | "failed" | "cancelled";

interface PaymentConfirmationResponse {
  confirmed?: boolean;
  status?: "PROCESSING" | "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "VOIDED";
  plan?: "PRO" | "BUSINESS";
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  PAID:     { label: "ชำระแล้ว",  color: "text-emerald-400", bg: "hsl(142 60% 50% / 0.15)", icon: Check },
  PENDING:  { label: "รอชำระ",    color: "text-amber-400",   bg: "hsl(38 92% 55% / 0.15)",  icon: Clock },
  FAILED:   { label: "ยกเลิก/หมดอายุ", color: "text-zinc-400", bg: "hsl(0 0% 50% / 0.12)", icon: XCircle },
  REFUNDED: { label: "คืนเงิน",   color: "text-zinc-400",    bg: "hsl(0 0% 50% / 0.12)",    icon: ArrowRight },
};

function BillingTab() {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  function loadPayments() {
    setLoading(true);
    fetch("/api/payments/history")
      .then(r => r.json())
      .then(d => Array.isArray(d) ? setPayments(d) : null)
      .catch(() => setPayments([])) // MON-11: fail-soft on network/JSON error — was an unhandled rejection
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadPayments(); }, []);

  async function resumePayment(id: string) {
    setActionLoading(id);
    try {
      const res = await fetch("/api/payments/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "ไม่สามารถดำเนินการต่อได้"); loadPayments(); return; }
      window.location.href = data.url;
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setActionLoading(null);
    }
  }

  async function cancelPayment(id: string) {
    setActionLoading(id);
    try {
      const res = await fetch("/api/payments/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "ยกเลิกไม่สำเร็จ"); return; }
      toast.success("ยกเลิกการชำระเงินแล้ว");
      loadPayments();
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Pricing CTA — premium gradient */}
      <a href="/pricing"
        className="group relative block overflow-hidden rounded-xl p-5 transition-all hover:-translate-y-0.5"
        style={{
          background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.12), hsl(var(--accent-secondary) / 0.08))",
          border: "1px solid hsl(var(--accent-primary) / 0.25)",
          boxShadow: "0 8px 24px hsl(var(--accent-primary) / 0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
        {/* Ambient glow */}
        <div className="absolute -top-8 -right-8 h-40 w-40 rounded-full blur-3xl pointer-events-none opacity-50"
          style={{ background: "hsl(var(--accent-primary) / 0.2)" }} />
        <div className="relative flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
            style={{
              background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))",
              boxShadow: "0 8px 20px hsl(var(--accent-primary) / 0.35), inset 0 1px 0 rgba(255,255,255,0.15)",
            }}>
            <Sparkles className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1">
            <p className="text-base font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              ดูแพ็กเกจทั้งหมด
            </p>
            <p className="text-sm mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
              อัปเกรด Pro หรือ Business เพื่อปลดล็อกฟีเจอร์เต็มรูปแบบ
            </p>
          </div>
          <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1"
            style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.5} />
        </div>
      </a>

      <ReactivateBanner />
      <ManageSubscriptionButton />

      {/* Credits section — visible only when NEXT_PUBLIC_CREDITS_LIVE === "1" */}
      {process.env.NEXT_PUBLIC_CREDITS_LIVE === "1" && <CreditsBillingSection />}

      {/* Payment history */}
      <div className="space-y-3">
        <p className="eyebrow">ประวัติการชำระเงิน</p>

        {loading ? null : payments.length === 0 ? (
          <div className="ve-card rounded-xl p-12 text-center">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl mb-3"
              style={{ background: "hsl(0 0% 100% / 0.04)", border: "1px solid hsl(0 0% 100% / 0.06)" }}>
              <CreditCard className="h-5 w-5" style={{ color: "var(--ui-text-muted)" }} strokeWidth={1.75} />
            </div>
            <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีประวัติการชำระเงิน</p>
          </div>
        ) : (
          <div className="space-y-2">
            {payments.map(p => {
              const status = STATUS_CONFIG[p.status] ?? STATUS_CONFIG.REFUNDED;
              const StatusIcon = status.icon;
              const isPending = p.status === "PENDING";
              const isActioning = actionLoading === p.id;
              return (
                <div key={p.id} className="ve-card ve-card-hover rounded-2xl p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
                      style={{
                        background: status.bg,
                        border: `1px solid ${status.bg.replace("0.15", "0.25")}`,
                      }}>
                      <StatusIcon className={cn("h-4 w-4", status.color)} strokeWidth={2.25} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                        {p.plan} Plan
                        <span className="ml-2 text-xs font-normal" style={{ color: "var(--ui-text-muted)" }}>· {p.periodDays} วัน</span>
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                        {new Date(p.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                        ฿{(p.amount / 100).toLocaleString()}
                      </p>
                      <p className={cn("text-xs font-semibold mt-0.5", status.color)}>{status.label}</p>
                    </div>
                  </div>
                  {isPending && (
                    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                      <button
                        onClick={() => resumePayment(p.id)}
                        disabled={isActioning}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{
                          background: VIOLET_GRAD,
                          color: "#fff",
                          boxShadow: "0 4px 12px hsl(258 90% 66% / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
                        }}
                      >
                        {isActioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" strokeWidth={2.5} />}
                        ชำระต่อ
                      </button>
                      <button
                        onClick={() => cancelPayment(p.id)}
                        disabled={isActioning}
                        className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 disabled:opacity-50"
                        style={{
                          background: "hsl(0 0% 100% / 0.03)",
                          border: "1px solid hsl(0 0% 100% / 0.08)",
                          color: "var(--ui-text-muted)",
                        }}
                      >
                        <XCircle className="h-3.5 w-3.5" strokeWidth={2} />
                        ยกเลิก
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────
function SettingsContent() {
  const [meUser, setMeUser] = useState<{ name?: string; email?: string; role?: string; plan?: string; effectivePlan?: string } | null>(null);
  const [tab, setTab] = useState("profile");
  const [paymentPopup, setPaymentPopup] = useState<PaymentPopupState | null>(null);
  const [checkoutSessionId, setCheckoutSessionId] = useState("");
  const [confirmationAttempt, setConfirmationAttempt] = useState(0);
  // managed mode: server supplies the Gemini key → hide BYOK-Gemini "Get/Enable" links
  // (kept in sync with ApiKeySettings, which hides the Gemini key field in the same mode)
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    fetch("/api/user/me", { cache: "no-store" }).then(r => r.json()).then(setMeUser).catch(() => {});
    fetch("/api/user/api-keys/status", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.managed) setManaged(true); })
      .catch(() => {});
  }, []);
  const [supportOpen, setSupportOpen] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    const p = params.get("payment");
    const sessionId = params.get("session_id")?.trim() ?? "";
    if (t === "api-keys" || t === "billing" || t === "mcp") setTab(t);
    if (p === "success") {
      setCheckoutSessionId(sessionId);
      setPaymentPopup(sessionId.startsWith("cs_") ? "confirming" : "delayed");
      window.history.replaceState({}, "", window.location.pathname + (t ? `?tab=${t}` : ""));
      document.body.style.overflow = "hidden";
    } else if (p === "cancelled") {
      setPaymentPopup("cancelled");
      window.history.replaceState({}, "", window.location.pathname + (t ? `?tab=${t}` : ""));
      document.body.style.overflow = "hidden";
    }
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    if (paymentPopup !== "confirming" || !checkoutSessionId) return;
    let stopped = false;

    async function confirmPaidCheckout() {
      try {
        for (let check = 0; check < 12 && !stopped; check++) {
          const res = await fetch(
            `/api/payments/confirmation?session_id=${encodeURIComponent(checkoutSessionId)}`,
            { cache: "no-store" },
          );
          if (!res.ok) throw new Error("Payment confirmation request failed");
          const result = await res.json() as PaymentConfirmationResponse;

          if (result.confirmed && result.status === "PAID") {
            const freshMe = await fetch("/api/user/me", { cache: "no-store" })
              .then(r => r.ok ? r.json() : null)
              .catch(() => null);
            if (stopped) return;
            if (freshMe) setMeUser(freshMe);
            else if (result.plan) setMeUser(current => ({ ...(current ?? {}), plan: result.plan }));
            setPaymentPopup("confirmed");
            return;
          }

          if (result.status === "FAILED" || result.status === "REFUNDED" || result.status === "VOIDED") {
            setPaymentPopup("failed");
            return;
          }

          await new Promise(resolve => window.setTimeout(resolve, 1250));
        }
        if (!stopped) setPaymentPopup("delayed");
      } catch {
        if (!stopped) setPaymentPopup("delayed");
      }
    }

    void confirmPaidCheckout();
    return () => { stopped = true; };
  }, [checkoutSessionId, confirmationAttempt, paymentPopup]);

  function closePaymentPopup() {
    setPaymentPopup(null);
    document.body.style.overflow = "";
  }

  function retryPaymentConfirmation() {
    if (!checkoutSessionId) return;
    setConfirmationAttempt(current => current + 1);
    setPaymentPopup("confirming");
  }

  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
    { id: "mcp",      label: "Agent / MCP", icon: Terminal },
    { id: "billing",  label: "Billing",  icon: CreditCard },
  ];
  const paymentConfirmed = paymentPopup === "confirmed";
  const paymentWaiting = paymentPopup === "confirming";
  const paymentDelayed = paymentPopup === "delayed";
  const paymentPlan = meUser?.effectivePlan ?? meUser?.plan ?? "PRO";
  const paymentIsBusiness = paymentPlan === "BUSINESS";

  return (
    <div className="max-w-5xl mx-auto space-y-6 px-0">

      {/* ── Payment Result Popup ──────────────────────────────────────── */}
      {paymentPopup && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-9999 flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(16px)" }}
          onClick={() => { if (!paymentWaiting) closePaymentPopup(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-result-title"
            className="relative w-full max-w-sm overflow-hidden rounded-3xl text-center"
            onClick={e => e.stopPropagation()}
            style={{
              background: paymentConfirmed
                ? "linear-gradient(160deg, #0a1a12 0%, #060d09 100%)"
                : paymentWaiting || paymentDelayed
                  ? "linear-gradient(160deg, #171126 0%, #09070f 100%)"
                  : "linear-gradient(160deg, #1a0a0a 0%, #0d0606 100%)",
              border: paymentConfirmed
                ? "1px solid hsl(142 60% 35% / 0.5)"
                : paymentWaiting || paymentDelayed
                  ? "1px solid hsl(258 70% 55% / 0.45)"
                  : "1px solid hsl(0 70% 35% / 0.5)",
              boxShadow: paymentConfirmed
                ? "0 32px 80px hsl(142 60% 20% / 0.5), 0 0 0 1px hsl(142 60% 50% / 0.08) inset"
                : paymentWaiting || paymentDelayed
                  ? "0 32px 80px hsl(258 60% 18% / 0.55), 0 0 0 1px hsl(258 70% 60% / 0.08) inset"
                  : "0 32px 80px hsl(0 70% 20% / 0.5), 0 0 0 1px hsl(0 70% 50% / 0.08) inset",
            }}
          >
            <div className="absolute -top-16 left-1/2 -translate-x-1/2 h-40 w-40 rounded-full blur-3xl pointer-events-none"
              style={{
                background: paymentConfirmed
                  ? "hsl(142 70% 45% / 0.25)"
                  : paymentWaiting || paymentDelayed
                    ? "hsl(258 80% 60% / 0.25)"
                    : "hsl(0 70% 45% / 0.2)",
              }} />

            <div className="relative px-8 pb-7 pt-9">
              {paymentConfirmed ? (
                <>
                  <div className="mx-auto mb-6 relative w-24 h-24">
                    <div className="absolute inset-0 rounded-full animate-ping opacity-20"
                      style={{ background: "hsl(142 60% 50% / 0.3)" }} />
                    <div className="absolute inset-2 rounded-full"
                      style={{ background: "hsl(142 60% 50% / 0.08)", border: "1px solid hsl(142 60% 50% / 0.2)" }} />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full"
                        style={{ background: "linear-gradient(135deg, hsl(142 60% 35%), hsl(160 70% 30%))", boxShadow: "0 8px 24px hsl(142 60% 40% / 0.4)" }}>
                        <Check className="h-8 w-8 text-white" strokeWidth={3} />
                      </div>
                    </div>
                  </div>

                  <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 mb-4"
                    style={{
                      background: paymentIsBusiness ? "hsl(252 70% 60% / 0.12)" : "hsl(142 60% 50% / 0.12)",
                      border: paymentIsBusiness ? "1px solid hsl(252 70% 60% / 0.3)" : "1px solid hsl(142 60% 50% / 0.25)",
                    }}>
                    <Crown className="h-3 w-3" style={{ color: paymentIsBusiness ? "hsl(252 70% 70%)" : "hsl(142 60% 60%)" }} />
                    <span className="text-xs font-semibold tracking-wide" style={{ color: paymentIsBusiness ? "hsl(252 70% 70%)" : "hsl(142 60% 60%)" }}>
                      {paymentIsBusiness ? "BUSINESS MEMBER" : "PRO MEMBER"}
                    </span>
                  </div>

                  <h2 id="payment-result-title" className="text-2xl font-bold text-white mb-2 tracking-tight">ชำระเงินสำเร็จ!</h2>
                  <p className="text-sm text-emerald-300/70 leading-relaxed mb-1">
                    ระบบยืนยันธุรกรรมและอัปเดตแพ็กเกจเรียบร้อยแล้ว
                  </p>
                  <p className="text-xs text-zinc-500 mb-6">Hero Script พร้อมใช้งานแล้ว</p>

                  <button
                    onClick={() => { closePaymentPopup(); window.location.href = "/hero-script"; }}
                    className="w-full rounded-2xl py-3 text-sm font-bold text-white tracking-wide transition-all hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0"
                    style={{
                      background: paymentIsBusiness
                        ? "linear-gradient(135deg, hsl(252 70% 50%), hsl(280 70% 45%))"
                        : "linear-gradient(135deg, hsl(142 60% 38%), hsl(160 65% 32%))",
                      boxShadow: paymentIsBusiness
                        ? "0 8px 24px hsl(252 70% 40% / 0.4), inset 0 1px 0 rgba(255,255,255,0.15)"
                        : "0 8px 24px hsl(142 60% 35% / 0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
                    }}>
                    เริ่มเขียนสคริปต์ →
                  </button>
                </>
              ) : paymentWaiting ? (
                <>
                  <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full"
                    style={{ background: "hsl(258 70% 55% / 0.1)", border: "1px solid hsl(258 70% 60% / 0.25)", boxShadow: "0 8px 24px hsl(258 60% 35% / 0.25)" }}>
                    <Loader2 className="h-9 w-9 animate-spin text-violet-300" strokeWidth={1.75} />
                  </div>

                  <h2 id="payment-result-title" className="text-2xl font-bold text-white mb-2 tracking-tight">กำลังยืนยันการชำระเงิน</h2>
                  <p className="text-sm text-violet-200/70 leading-relaxed mb-1">ระบบกำลังตรวจสอบธุรกรรมกับ Stripe</p>
                  <p className="text-xs text-zinc-500">ยังไม่เปิดสิทธิ์จนกว่าจะยืนยันสำเร็จ</p>
                </>
              ) : paymentDelayed ? (
                <>
                  <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full"
                    style={{ background: "hsl(38 90% 55% / 0.1)", border: "1px solid hsl(38 90% 55% / 0.25)" }}>
                    <Clock className="h-9 w-9 text-amber-300" strokeWidth={1.75} />
                  </div>

                  <h2 id="payment-result-title" className="text-2xl font-bold text-white mb-2 tracking-tight">การยืนยันใช้เวลานานกว่าปกติ</h2>
                  <p className="text-sm text-amber-100/70 leading-relaxed mb-1">ยังไม่มีการยืนยันสิทธิ์จากระบบ จึงยังไม่แสดงว่าชำระสำเร็จ</p>
                  <p className="text-xs text-zinc-500 mb-6">ลองตรวจสอบอีกครั้ง หรือแจ้ง Support หากเกิน 5 นาที</p>

                  <div className="space-y-2">
                    <button
                      onClick={retryPaymentConfirmation}
                      disabled={!checkoutSessionId}
                      className="w-full rounded-2xl py-3 text-sm font-bold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ background: VIOLET_GRAD }}>
                      ตรวจสอบอีกครั้ง
                    </button>
                    <button
                      onClick={() => { closePaymentPopup(); setSupportOpen(true); }}
                      className="w-full rounded-2xl py-2.5 text-sm font-semibold text-white/70 transition-all hover:bg-white/10 hover:text-white"
                      style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
                      ติดต่อ Support
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full"
                    style={{ background: "hsl(0 70% 50% / 0.1)", border: "1px solid hsl(0 70% 50% / 0.25)", boxShadow: "0 8px 24px hsl(0 70% 40% / 0.2)" }}>
                    <XCircle className="h-10 w-10 text-red-400" strokeWidth={1.5} />
                  </div>

                  <h2 id="payment-result-title" className="text-2xl font-bold text-white mb-2 tracking-tight">
                    {paymentPopup === "cancelled" ? "ยกเลิกการชำระเงิน" : "ยังไม่สามารถยืนยันการชำระเงิน"}
                  </h2>
                  <p className="text-sm text-red-300/70 leading-relaxed mb-1">
                    {paymentPopup === "cancelled" ? "ระบบยังไม่ได้ยืนยันธุรกรรมนี้" : "ธุรกรรมนี้ยังไม่ได้เปิดสิทธิ์แพ็กเกจ"}
                  </p>
                  <p className="text-xs text-zinc-500 mb-6">ตรวจสอบประวัติการชำระเงิน หรือลองใหม่เมื่อพร้อม</p>

                  <button
                    onClick={closePaymentPopup}
                    className="w-full rounded-2xl py-3 text-sm font-semibold text-white/70 transition-all hover:text-white hover:bg-white/10"
                    style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
                    ปิด
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Page header */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
          Account · Settings
        </p>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
          Settings
        </h1>
        <p className="text-base" style={{ color: "var(--ui-text-secondary)" }}>
          จัดการบัญชี, API keys และการชำระเงินของคุณ
        </p>
      </div>

      {/* Tabs — flat pill style */}
      <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl w-full sm:w-auto sm:inline-flex"
        style={{
          background: "var(--ui-card-bg)",
          border: "1px solid var(--ui-card-border)",
        }}>
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all",
                active
                  ? "shadow-sm"
                  : "hover:bg-white/3"
              )}
              style={active ? {
                background: VIOLET_GRAD,
                color: "#fff",
                boxShadow: "0 4px 12px hsl(258 90% 66% / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
              } : {
                color: "var(--ui-text-muted)",
              }}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="space-y-6">

        {/* Profile Tab */}
        {tab === "profile" && (
          <div className="ve-card rounded-xl p-7">
            <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  background: "hsl(var(--accent-primary) / 0.1)",
                  border: "1px solid hsl(var(--accent-primary) / 0.2)",
                  boxShadow: "0 4px 12px hsl(var(--accent-primary) / 0.1)",
                }}>
                <User className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                  Profile Settings
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                  ข้อมูลส่วนตัวและการตั้งค่าบัญชี
                </p>
              </div>
            </div>
            <ProfileSettings user={meUser ?? undefined} />
          </div>
        )}

        {/* API Keys Tab */}
        {tab === "api-keys" && (
          <div className="ve-card rounded-xl p-7">
            <div className="flex items-center justify-between mb-6 pb-5 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    background: "hsl(var(--accent-primary) / 0.1)",
                    border: "1px solid hsl(var(--accent-primary) / 0.2)",
                    boxShadow: "0 4px 12px hsl(var(--accent-primary) / 0.1)",
                  }}>
                  <Key className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
                </div>
                <div>
                  <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                    API Credentials
                  </h2>
                  <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                    เก็บ API keys ของ AI providers
                  </p>
                </div>
              </div>
              {!managed && (
                <div className="flex flex-col items-end gap-1.5">
                  <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all hover:bg-white/5"
                    style={{
                      background: "hsl(0 0% 100% / 0.03)",
                      border: "1px solid hsl(0 0% 100% / 0.08)",
                      color: "var(--ui-text-secondary)",
                    }}>
                    ① Get Gemini Key <ExternalLink className="h-3 w-3" />
                  </a>
                  <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all hover:bg-white/5"
                    style={{
                      background: "hsl(38 92% 50% / 0.08)",
                      border: "1px solid hsl(38 92% 50% / 0.3)",
                      color: "hsl(38 100% 70%)",
                    }}>
                    ② Enable Gemini API <ExternalLink className="h-3 w-3" />
                  </a>
                  <p className="text-[10px] text-white/30 text-right max-w-[180px]">ต้องทำทั้ง 2 ขั้น ไม่งั้นเจอ 403</p>
                </div>
              )}
            </div>
            <ApiKeySettings />
          </div>
        )}

        {/* Billing Tab */}
        {tab === "billing" && (
          <div className="ve-card rounded-xl p-7">
            <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  background: "hsl(var(--accent-primary) / 0.1)",
                  border: "1px solid hsl(var(--accent-primary) / 0.2)",
                  boxShadow: "0 4px 12px hsl(var(--accent-primary) / 0.1)",
                }}>
                <CreditCard className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                  Billing & Payments
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                  ดูประวัติและจัดการแพ็กเกจของคุณ
                </p>
              </div>
            </div>
            {/* Clip quota row — fail-soft: renders nothing while loading or on error */}
            <QuotaStatus variant="row" className="mb-6" />
            <BillingTab />
          </div>
        )}

        {/* Agent / MCP Tab */}
        {tab === "mcp" && (
          <div className="ve-card rounded-xl p-7">
            <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{ background: "hsl(var(--accent-primary) / 0.1)", border: "1px solid hsl(var(--accent-primary) / 0.2)" }}>
                <Terminal className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>Agent / MCP Access</h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>ต่อ Claude Code / agent ของคุณเข้ากับ HERO AI</p>
              </div>
            </div>
            <McpAccessSettings allowed={(meUser?.effectivePlan ?? meUser?.plan) === "PRO" || (meUser?.effectivePlan ?? meUser?.plan) === "BUSINESS"} />
          </div>
        )}

        {/* Coupon */}
        <CouponBox />

        {/* Contact Us banner — premium */}
        <div className="ve-card rounded-xl p-6 flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: "linear-gradient(135deg, hsl(252 70% 65% / 0.18), hsl(280 80% 65% / 0.08))",
              border: "1px solid hsl(252 70% 65% / 0.3)",
              boxShadow: "0 4px 14px hsl(252 70% 65% / 0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}>
            <MessageCircle className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              ต้องการความช่วยเหลือ?
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
              ส่งข้อความหาทีมงาน — ตอบกลับทาง Email ภายใน 24 ชม.
            </p>
          </div>
          <button
            onClick={() => setSupportOpen(true)}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all hover:brightness-110 active:scale-[0.98]"
            style={{
              background: "linear-gradient(135deg, hsl(252 70% 60%), hsl(280 80% 60%))",
              color: "#fff",
              boxShadow: "0 6px 16px hsl(252 70% 60% / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
            }}>
            <MessageCircle className="h-3.5 w-3.5" strokeWidth={2.5} />
            Contact Us
          </button>
        </div>

        {/* Trust footer */}
        <div className="flex items-center justify-center gap-2 text-xs pt-2"
          style={{ color: "var(--ui-text-muted)" }}>
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />
          <span>การชำระเงินทุกครั้งเข้ารหัสและผ่าน Stripe</span>
        </div>
      </div>

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 px-4 md:px-6 pt-3 md:pt-4 pb-12">
        <SettingsContent />
      </div>
    </div>
  );
}
