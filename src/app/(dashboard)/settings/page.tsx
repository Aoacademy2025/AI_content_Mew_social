"use client";

import { useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { SupportModal } from "@/components/ui/support-modal";
import {
  User, Key, ExternalLink, Ticket, Crown, Loader2, MessageCircle,
  CreditCard, Check, Clock, ArrowRight, Sparkles, ShieldCheck, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Coupon Box ───────────────────────────────────────────────────────────
function CouponBox() {
  const { update } = useSession();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/coupons/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      toast.success(data.message);
      setCode("");
      await update();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="premium-card p-7">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "linear-gradient(135deg, hsl(45 100% 50% / 0.18), hsl(38 92% 55% / 0.08))",
            border: "1px solid hsl(45 100% 50% / 0.3)",
            boxShadow: "0 4px 14px hsl(45 100% 50% / 0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}>
          <Ticket className="h-5 w-5 text-yellow-400" strokeWidth={2.25} />
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              ใช้รหัสคูปอง
            </h2>
            <p className="text-sm mt-1" style={{ color: "var(--ui-text-muted)" }}>
              มีรหัสคูปองอยู่แล้ว? กรอกที่นี่เพื่ออัปเกรดแผนการใช้งานทันที
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="PROMO2025"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && redeem()}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-mono uppercase tracking-wider outline-none transition-all focus:ring-2 focus:ring-yellow-500/30 focus:border-yellow-500/50"
              style={{
                background: "hsl(0 0% 100% / 0.03)",
                border: "1px solid hsl(0 0% 100% / 0.08)",
                color: "var(--ui-text-primary)",
              }}
            />
            <button
              onClick={redeem}
              disabled={loading || !code.trim()}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:scale-[0.98]"
              style={{
                background: "linear-gradient(135deg, hsl(45 100% 55%), hsl(38 92% 55%))",
                color: "#1a1100",
                boxShadow: "0 6px 20px hsl(45 100% 50% / 0.3), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crown className="h-4 w-4" strokeWidth={2.5} />}
              ใช้คูปอง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  PAID:     { label: "ชำระแล้ว",  color: "text-emerald-400", bg: "hsl(142 60% 50% / 0.15)", icon: Check },
  PENDING:  { label: "รอชำระ",    color: "text-amber-400",   bg: "hsl(38 92% 55% / 0.15)",  icon: Clock },
  FAILED:   { label: "ไม่สำเร็จ", color: "text-red-400",     bg: "hsl(0 75% 60% / 0.15)",   icon: XCircle },
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

      {/* Payment history */}
      <div className="space-y-3">
        <p className="eyebrow">ประวัติการชำระเงิน</p>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--ui-text-muted)" }} />
          </div>
        ) : payments.length === 0 ? (
          <div className="premium-card p-12 text-center">
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
                <div key={p.id} className="premium-card p-4 transition-colors hover:bg-white/3">
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
                          background: "linear-gradient(135deg, hsl(38 92% 55%), hsl(38 92% 50%))",
                          color: "#1a1100",
                          boxShadow: "0 4px 12px hsl(38 92% 50% / 0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
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
  const { data: session } = useSession();
  const [tab, setTab] = useState("profile");
  const [supportOpen, setSupportOpen] = useState(false);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "api-keys" || t === "billing") setTab(t);
  }, []);

  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
    { id: "billing",  label: "Billing",  icon: CreditCard },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Page header */}
      <div className="space-y-2">
        <p className="eyebrow" style={{ color: "hsl(var(--accent-primary))" }}>Account</p>
        <h1 className="section-heading">Settings</h1>
        <p className="text-base" style={{ color: "var(--ui-text-secondary)" }}>
          จัดการบัญชี, API keys และการชำระเงินของคุณ
        </p>
      </div>

      {/* Tabs — premium pill style */}
      <div className="inline-flex items-center gap-1 p-1 rounded-xl"
        style={{
          background: "hsl(0 0% 100% / 0.03)",
          border: "1px solid hsl(0 0% 100% / 0.06)",
        }}>
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all",
                active
                  ? "shadow-sm"
                  : "hover:bg-white/3"
              )}
              style={active ? {
                background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))",
                color: "#fff",
                boxShadow: "0 4px 12px hsl(var(--accent-primary) / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
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
          <div className="premium-card p-7">
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
            <ProfileSettings user={session?.user} />
          </div>
        )}

        {/* API Keys Tab */}
        {tab === "api-keys" && (
          <div className="premium-card p-7">
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
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all hover:bg-white/5"
                style={{
                  background: "hsl(0 0% 100% / 0.03)",
                  border: "1px solid hsl(0 0% 100% / 0.08)",
                  color: "var(--ui-text-secondary)",
                }}>
                Get Gemini Key <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <ApiKeySettings />
          </div>
        )}

        {/* Billing Tab */}
        {tab === "billing" && (
          <div className="premium-card p-7">
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
            <BillingTab />
          </div>
        )}

        {/* Coupon */}
        <CouponBox />

        {/* Contact Us banner — premium */}
        <div className="premium-card p-6 flex items-center gap-4">
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
    <>
      <SettingsContent />
    </>
  );
}
