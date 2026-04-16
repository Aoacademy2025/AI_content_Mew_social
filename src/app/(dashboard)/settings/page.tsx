"use client";

import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { ApiKeySettings } from "@/components/settings/api-key-settings";
import {
  User, Key, CreditCard, CheckCircle2, Crown, Loader2,
  TrendingUp, Cpu, ExternalLink, Zap, Film, Star,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CARD: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

function SettingsContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const initTab = searchParams.get("tab") === "api-keys" ? "api-keys" : searchParams.get("tab") === "billing" ? "billing" : "profile";
  const [tab, setTab] = useState(initTab);
  const [plan, setPlan] = useState<"FREE" | "PRO" | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    fetch("/api/user/me").then(r => r.json()).then(d => setPlan(d.plan || "FREE")).catch(() => setPlan("FREE"));
  }, []);

  async function upgradeToPro() {
    setUpgrading(true);
    try {
      const res = await fetch("/api/user/upgrade", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (res.ok) { setPlan("PRO"); toast.success("Upgraded to Pro Plan!"); }
      else throw new Error();
    } catch { toast.error("Upgrade failed. Add OpenAI API Key first."); }
    finally { setUpgrading(false); }
  }

  const tabs = [
    { id: "profile",  label: "Profile",  icon: User },
    { id: "api-keys", label: "API Keys", icon: Key },
    { id: "billing",  label: "Billing",  icon: CreditCard },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>Settings</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--ui-text-muted)" }}>Manage your workspace configuration, API connections, and subscription details.</p>
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

      {/* Two-column layout */}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">

        {/* ── Left column ── */}
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

          {/* Billing Tab */}
          {tab === "billing" && (
            <div className="rounded-xl p-5" style={CARD}>
              <div className="flex items-center gap-2 mb-5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)" }}>
                  <CreditCard className="h-4 w-4 text-cyan-400" />
                </div>
                <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Billing & Usage</h2>
              </div>
              <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>Billing management coming soon.</p>
            </div>
          )}

          {/* Stats row */}
          {tab !== "billing" && (
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
          )}

          {/* Help banner */}
          {tab !== "billing" && (
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
          )}
        </div>

        {/* ── Right column — Subscription ── */}
        <div className="space-y-4">
          <div className="rounded-xl p-5" style={CARD}>
            <div className="flex items-center gap-2 mb-4">
              <Crown className="h-4 w-4" style={{ color: "var(--ui-text-muted)" }} />
              <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Subscription</h2>
            </div>

            {/* Free Plan */}
            <div className="rounded-xl p-4 mb-3" style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>Free Plan</p>
                {plan === "FREE" && (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                    style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-muted)" }}>
                    Current
                  </span>
                )}
              </div>
              <p className="text-xs mb-3" style={{ color: "var(--ui-text-muted)" }}>Limited testing & exploration</p>
              <div className="space-y-1.5">
                {["Standard AI Models", "10 Static Styles", "Content Generation"].map(f => (
                  <div key={f} className="flex items-center gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                    <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} /> {f}
                  </div>
                ))}
              </div>
            </div>

            {/* Pro Plan */}
            <div className="relative rounded-xl p-4" style={{ background: "hsl(190 100% 50% / 0.05)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
              <div className="absolute -top-2.5 right-4">
                <span className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: "hsl(190 100% 50%)", color: "hsl(222 47% 6%)" }}>
                  Recommended
                </span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>Pro Plan</p>
                <div className="text-right">
                  <span className="text-lg font-bold" style={{ color: "var(--ui-text-primary)" }}>$49</span>
                  <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>/mo</span>
                </div>
              </div>
              <p className="text-xs mb-3" style={{ color: "var(--ui-text-muted)" }}>Professional production tools</p>
              <div className="space-y-1.5 mb-4">
                {[
                  { icon: Star, label: "Infinite styles & contents" },
                  { icon: Film, label: "Advanced Video generation" },
                  { icon: Zap, label: "Priority processing" },
                ].map(({ icon: Icon, label }) => (
                  <div key={label} className="flex items-center gap-2 text-xs text-cyan-400/80">
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </div>
                ))}
              </div>
              {plan === "PRO" ? (
                <div className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-cyan-400"
                  style={{ background: "hsl(190 100% 50% / 0.1)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
                  <CheckCircle2 className="h-4 w-4" /> Active Plan
                </div>
              ) : (
                <button onClick={upgradeToPro} disabled={upgrading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-60"
                  style={{ background: "hsl(190 100% 50%)", color: "hsl(222 47% 6%)" }}>
                  {upgrading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Switch to Pro
                </button>
              )}
            </div>

            {/* Payment method placeholder */}
            <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--ui-divider)" }}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium" style={{ color: "var(--ui-text-muted)" }}>Payment Method</p>
                <button className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">Edit</button>
              </div>
              <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}>
                <p className="text-xs text-center" style={{ color: "var(--ui-text-muted)" }}>No payment method added</p>
              </div>
            </div>
          </div>
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
