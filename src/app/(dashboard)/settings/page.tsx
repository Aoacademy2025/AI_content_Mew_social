"use client";

import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { ApiKeySettings } from "@/components/settings/api-key-settings";
import {
  User, Key, ExternalLink, Zap, TrendingUp, Cpu, Ticket, Crown, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CARD: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

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
      await update(); // refresh session plan
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl p-5" style={CARD}>
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "hsl(45 100% 50% / 0.12)" }}>
          <Ticket className="h-4 w-4 text-yellow-400" />
        </div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ใช้คูปอง</h2>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--ui-text-muted)" }}>
        กรอกรหัสคูปองเพื่ออัปเกรดแผนการใช้งาน
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="รหัสคูปอง เช่น PROMO2025"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === "Enter" && redeem()}
          className="flex-1 rounded-lg border px-3 py-2 text-sm font-mono uppercase outline-none focus:border-yellow-500/50 focus:ring-1 focus:ring-yellow-500/30"
          style={{ background: "var(--ui-input-bg, hsl(0 0% 10%))", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}
        />
        <button
          onClick={redeem}
          disabled={loading || !code.trim()}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ background: "hsl(45 100% 50% / 0.15)", border: "1px solid hsl(45 100% 50% / 0.3)", color: "#facc15" }}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crown className="h-4 w-4" />}
          ใช้คูปอง
        </button>
      </div>
    </div>
  );
}

function SettingsContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState("profile");
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "api-keys") setTab(t);
  }, [searchParams]);

  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>Settings</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--ui-text-muted)" }}>Manage your workspace configuration and API connections.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b" style={{ borderColor: "var(--ui-divider)" }}>
        {tabs.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px",
              tab === id
                ? "border-cyan-400 text-cyan-400"
                : "border-transparent hover:opacity-80"
            )}
            style={{ color: tab === id ? undefined : "var(--ui-text-muted)" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="space-y-4">

        {/* Profile Tab */}
        {tab === "profile" && (
          <div className="rounded-xl p-5" style={CARD}>
            <div className="flex items-center gap-2 mb-5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)" }}>
                <User className="h-4 w-4 text-cyan-400" />
              </div>
              <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Profile Settings</h2>
            </div>
            <ProfileSettings user={session?.user} />
          </div>
        )}

        {/* API Keys Tab */}
        {tab === "api-keys" && (
          <div className="rounded-xl p-5" style={CARD}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)" }}>
                  <Key className="h-4 w-4 text-cyan-400" />
                </div>
                <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>API Credentials</h2>
              </div>
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer"
                className="flex items-center gap-1 rounded-full px-3 py-1 text-xs hover:opacity-80 transition-opacity"
                style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-muted)" }}>
                Documentation <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <ApiKeySettings />
          </div>
        )}

        {/* Coupon */}
        <CouponBox />

        {/* Stats row */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl p-5" style={CARD}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>API Calls</p>
              <TrendingUp className="h-4 w-4 text-cyan-400/40" />
            </div>
            <p className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>—</p>
            <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>This month</p>
          </div>
          <div className="rounded-xl p-5" style={CARD}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>Active Tokens</p>
              <Cpu className="h-4 w-4 text-cyan-400/40" />
            </div>
            <p className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>—</p>
            <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>All time usage</p>
          </div>
        </div>

        {/* Help banner */}
        <div className="flex items-center gap-4 rounded-xl p-4" style={CARD}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "hsl(190 100% 50% / 0.1)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
            <Zap className="h-5 w-5 text-cyan-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>Need help with your API?</p>
            <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>Our engineering team is available for Enterprise customers.</p>
          </div>
          <button className="rounded-lg px-3 py-1.5 text-xs font-medium hover:opacity-80 transition-opacity"
            style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}>
            Contact Engineering
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={null}>
        <SettingsContent />
      </Suspense>
    </DashboardLayout>
  );
}
