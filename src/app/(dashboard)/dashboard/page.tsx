"use client";

import { useEffect, useState } from "react";
import {
  Palette, FileText, Video, Sparkles, Crown, Building2, ArrowRight,
  Loader2, AlertTriangle, Film, Clapperboard, BookOpen, Settings,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { PremiumBackdrop, CornerBrackets } from "@/components/layout/premium-page";
import { DashboardOnboarding } from "@/components/onboarding/DashboardOnboarding";

type PlanKey = "FREE" | "PRO" | "BUSINESS";

interface Stats {
  plan: PlanKey;
  proExpiresAt: string | null;
  styleCount: number;
  contentCount: number;
  videoCount: number;
  limits: { styles: number | null; contents: number | null; images: null };
  recentContents: { id: string; headline: string | null; createdAt: string; language: string }[];
  recentVideos: { id: string; status: string; createdAt: string; avatarModel: string; content: { headline: string | null } | null }[];
}

function daysLeft(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86400000);
}

function statusStyle(s: string) {
  if (s === "COMPLETED") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  if (s === "PROCESSING") return "text-cyan-300 bg-cyan-500/10 border-cyan-500/30";
  if (s === "FAILED") return "text-red-300 bg-red-500/10 border-red-500/30";
  return "text-white/40 bg-white/5 border-white/10";
}

function UsageBar({ count, limit }: { count: number; limit: number | null }) {
  if (!limit) return null;
  const pct = Math.min((count / limit) * 100, 100);
  const warn = pct >= 80;
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex justify-between text-[10px] font-mono text-white/45">
        <span>{count} / {limit}</span>
        <span className={warn ? "text-amber-300" : "text-cyan-300"}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/5 relative">
        <div className="h-full rounded-full transition-all" style={{
          width: `${pct}%`,
          background: warn ? "linear-gradient(90deg, hsl(35 100% 50%), hsl(15 100% 55%))" : "linear-gradient(90deg, hsl(190 100% 50%), hsl(220 100% 55%))",
          boxShadow: warn ? "0 0 8px hsl(35 100% 50% / 0.5)" : "0 0 8px hsl(190 100% 50% / 0.5)",
        }} />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");

  useEffect(() => {
    fetch("/api/user/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
    fetch("/api/user/me").then(r => r.json()).then(d => { if (d.name) setUserName(d.name); }).catch(() => {});
  }, []);

  const isBusiness = stats?.plan === "BUSINESS";
  const isPro = stats?.plan === "PRO";
  const isPaid = isPro || isBusiness;
  const planLabel = isBusiness ? "Business Plan" : isPro ? "Pro Plan" : "Free Plan";
  const PlanIcon = isBusiness ? Building2 : Crown;
  const planAccent = isBusiness ? "violet" : isPro ? "amber" : "cyan";

  const atStyleLimit = !isPaid && stats ? stats.styleCount >= (stats.limits?.styles ?? Infinity) : false;
  const atContentLimit = !isPaid && stats ? stats.contentCount >= (stats.limits?.contents ?? Infinity) : false;

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <PremiumBackdrop />

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 md:px-6 pt-3 md:pt-4 pb-12">

        {/* Eyebrow */}
        <div className="pp-fade-up flex items-center gap-2 mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/70"
          style={{ animationDelay: "0ms" }}>
          <span className="h-px w-6 bg-linear-to-r from-transparent to-cyan-400/50" />
          Dashboard
          <span className="pp-chip-dot h-1 w-1 rounded-full bg-cyan-400" />
          {planLabel}
        </div>

        {/* Title row */}
        <div className="pp-fade-up flex flex-wrap items-end justify-between gap-4 mb-1" style={{ animationDelay: "60ms" }}>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white leading-tight">
            สวัสดีคุณ{" "}
            <span className="inline-block bg-linear-to-r from-cyan-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
              {userName || "ผู้ใช้งาน"}
            </span>
          </h1>

          {/* Plan badge */}
          {stats && (
            <div className="flex flex-col items-end gap-1.5">
              <div className="relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold backdrop-blur-xl"
                style={{
                  background: planAccent === "violet"
                    ? "linear-gradient(135deg, hsl(252 83% 57% / 0.18), hsl(252 83% 57% / 0.08))"
                    : planAccent === "amber"
                    ? "linear-gradient(135deg, hsl(38 92% 50% / 0.18), hsl(38 92% 50% / 0.08))"
                    : "linear-gradient(135deg, hsl(190 100% 50% / 0.15), hsl(190 100% 50% / 0.05))",
                  border: `1px solid hsl(${planAccent === "violet" ? "252 83% 57%" : planAccent === "amber" ? "38 92% 50%" : "190 100% 50%"} / 0.40)`,
                  color: planAccent === "violet" ? "hsl(252 90% 80%)" : planAccent === "amber" ? "hsl(38 100% 70%)" : "hsl(190 100% 75%)",
                  boxShadow: `0 0 16px hsl(${planAccent === "violet" ? "252 83% 57%" : planAccent === "amber" ? "38 92% 50%" : "190 100% 50%"} / 0.20)`,
                }}>
                <PlanIcon className="h-3.5 w-3.5" />
                {planLabel}
              </div>
              {isPaid && stats.proExpiresAt && (() => {
                const d = daysLeft(stats.proExpiresAt!);
                return (
                  <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border ${
                    d <= 3 ? "bg-red-500/10 text-red-300 border-red-500/30" :
                    d <= 7 ? "bg-amber-500/10 text-amber-300 border-amber-500/30" :
                    "bg-white/5 text-white/45 border-white/10"
                  }`}>
                    {d > 0 ? `${d}d remaining` : "Expired"}
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        <p className="pp-fade-up text-base text-white/55 max-w-2xl leading-relaxed mb-6" style={{ animationDelay: "140ms" }}>
          เริ่มสร้างเนื้อหาวิดีโอด้วย AI — เลือก action ด้านล่างเพื่อเริ่ม
        </p>

        {/* Key setup checklist + first-login wizard */}
        <DashboardOnboarding />

        {/* Quick actions — premium CTA row */}
        <div className="pp-fade-up grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8" style={{ animationDelay: "120ms" }}>
          {[
            { label: "Video Editor", desc: "Timeline editor", href: "/video-editor", Icon: Clapperboard, color: "190 100% 50%" },
            { label: "Gallery",      desc: "ดู renders เก่า",   href: "/videos",       Icon: Video,        color: "142 70% 45%" },
            { label: "Docs",         desc: "วิธีใช้งาน",        href: "/docs",         Icon: BookOpen,     color: "35 90% 55%" },
          ].map(({ label, desc, href, Icon, color }) => (
            <Link key={href} href={href} className="pp-card pp-card-interactive overflow-hidden relative group">
              <span aria-hidden className="pp-card-border" />
              <CornerBrackets />
              <div className="relative p-4 flex items-start gap-3">
                <div className="relative flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
                  style={{
                    background: `linear-gradient(135deg, hsl(${color} / 0.22), hsl(${color} / 0.08))`,
                    border: `1px solid hsl(${color} / 0.45)`,
                    boxShadow: `0 0 14px hsl(${color} / 0.25)`,
                  }}>
                  <Icon className="h-4.5 w-4.5" style={{ color: `hsl(${color})` }} strokeWidth={2.25} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-bold text-white tracking-tight">{label}</p>
                  <p className="text-[11px] text-white/45 mt-0.5">{desc}</p>
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-white/30 transition-all group-hover:text-cyan-300 group-hover:translate-x-0.5 mt-1" />
              </div>
            </Link>
          ))}
        </div>

        {/* Limit warning — only for unpaid users at limit */}
        {!isPaid && (atStyleLimit || atContentLimit) && (
          <div className="pp-fade-in relative overflow-hidden rounded-xl px-4 py-3 mb-6 flex items-center gap-3"
            style={{
              background: "linear-gradient(135deg, hsl(35 100% 50% / 0.10), hsl(15 100% 50% / 0.05))",
              border: "1px solid hsl(35 100% 50% / 0.35)",
              boxShadow: "0 0 16px hsl(35 100% 50% / 0.12)",
            }}>
            <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0 drop-shadow-[0_0_4px_hsl(35_100%_50%/0.5)]" />
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-100">คุณใช้ Free plan ครบ limit แล้ว</p>
              <p className="text-xs text-amber-200/70 mt-0.5">Upgrade เป็น Pro เพื่อใช้งานไม่จำกัด</p>
            </div>
            <Link href="/pricing" className="rounded-lg px-3.5 py-1.5 text-xs font-bold text-white shadow-lg"
              style={{ background: "linear-gradient(135deg, hsl(35 100% 50%), hsl(15 100% 55%))", boxShadow: "0 0 12px hsl(35 100% 50% / 0.45)" }}>
              Upgrade
            </Link>
          </div>
        )}

        {/* Stats grid — 3 numbered cards */}
        <div className="pp-fade-up grid gap-4 grid-cols-1 sm:grid-cols-2 mb-8" style={{ animationDelay: "180ms" }}>
          {[
            { label: "Styles",  count: stats?.styleCount ?? 0,   limit: stats?.limits?.styles ?? null,   icon: Palette,  href: "/style",   color: "220 90% 65%" },
            { label: "Videos",  count: stats?.videoCount ?? 0,   limit: null,                            icon: Video,    href: "/videos",  color: "142 60% 50%" },
          ].map(({ label, count, limit, icon: Icon, href, color }) => (
            <Link key={href} href={href} className="pp-card pp-card-interactive overflow-hidden block">
              <span aria-hidden className="pp-card-border" />
              <CornerBrackets />
              <div className="relative p-6">
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/50">{label}</p>
                    <p className="text-[10px] font-mono text-white/30 mt-0.5">#{href.slice(1)}</p>
                  </div>
                  <div className="pp-icon-frame relative flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
                    style={{ "--c-accent": color } as React.CSSProperties}>
                    <Icon className="h-4.5 w-4.5" style={{ color: `hsl(${color})` }} strokeWidth={2.25} />
                  </div>
                </div>
                {loading ? null : (
                  <div className="flex items-baseline gap-2">
                    <p className="text-5xl font-black tracking-tight text-white tabular-nums">{count}</p>
                    <TrendingUp className="h-4 w-4 text-cyan-400/40 mb-1" />
                  </div>
                )}
                <UsageBar count={count} limit={limit} />
                {!isPaid && label === "Videos" && (
                  <div className="mt-3 flex items-center gap-1.5">
                    <Crown className="h-3 w-3 text-amber-400" />
                    <p className="text-[11px] font-bold text-amber-300">Pro only feature</p>
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Recent activity — render whenever there's data; skipped silently when none exists */}
        {((stats?.recentContents?.length ?? 0) > 0 || (stats?.recentVideos?.length ?? 0) > 0) && (
          <div className="pp-fade-up grid gap-5 md:grid-cols-2 mb-8" style={{ animationDelay: "240ms" }}>
            {(stats?.recentContents?.length ?? 0) > 0 && (
              <div className="pp-card overflow-hidden relative">
                <span aria-hidden className="pp-card-border" />
                <CornerBrackets />
                <div className="relative p-6">
                  <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-cyan-300" />
                      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/70">Recent Content</p>
                    </div>
                    <Link href="/content" className="group flex items-center gap-1 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 transition-colors">
                      View all <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  <div className="space-y-1">
                    {stats!.recentContents.map((c) => (
                      <Link key={c.id} href="/content">
                        <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-cyan-500/5 group/row">
                          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400/40 group-hover/row:bg-cyan-400 transition-colors shrink-0" />
                          <p className="flex-1 truncate text-[13px] text-white/75">{c.headline || "Untitled"}</p>
                          <p className="text-[10px] font-mono text-white/35 shrink-0">
                            {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </p>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {(stats?.recentVideos?.length ?? 0) > 0 && (
              <div className="pp-card overflow-hidden relative">
                <span aria-hidden className="pp-card-border" />
                <CornerBrackets />
                <div className="relative p-6">
                  <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <Video className="h-3.5 w-3.5 text-cyan-300" />
                      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/70">Recent Videos</p>
                    </div>
                    <Link href="/videos" className="group flex items-center gap-1 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 transition-colors">
                      View all <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                  <div className="space-y-1">
                    {stats!.recentVideos.map((v) => (
                      <div key={v.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-400/40 shrink-0" />
                        <p className="flex-1 truncate text-[13px] text-white/75">{v.content?.headline || v.avatarModel}</p>
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border shrink-0 ${statusStyle(v.status)}`}>
                          {v.status === "PROCESSING" && <Loader2 className="inline h-2.5 w-2.5 animate-spin mr-1" />}
                          {v.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Upgrade CTA */}
        {stats && !isBusiness && (
          <div className="pp-fade-in pp-card overflow-hidden relative" style={{ animationDelay: "500ms" }}>
            <span aria-hidden className="pp-card-border" />
            <CornerBrackets color={isPro ? "violet" : "amber"} />
            <div className="relative p-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
                style={{
                  background: isPro
                    ? "linear-gradient(135deg, hsl(252 83% 57% / 0.22), hsl(252 83% 57% / 0.08))"
                    : "linear-gradient(135deg, hsl(38 92% 50% / 0.22), hsl(38 92% 50% / 0.08))",
                  border: `1px solid hsl(${isPro ? "252 83% 57%" : "38 92% 50%"} / 0.45)`,
                  boxShadow: `0 0 16px hsl(${isPro ? "252 83% 57%" : "38 92% 50%"} / 0.30)`,
                }}>
                {isPro
                  ? <Building2 className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
                  : <Crown className="h-5 w-5 text-amber-300" strokeWidth={2.25} />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-bold text-white tracking-tight">
                  {isPro ? "Upgrade to Business" : "Upgrade to Pro"}
                </p>
                <p className="text-[12px] text-white/55 mt-0.5">
                  {isPro
                    ? "300 clips/month • วิดีโอ 10 นาที • 90-day storage • Priority support"
                    : "Unlimited styles, content และ avatar videos"}
                </p>
              </div>
              <Link href="/pricing" className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-bold text-white shadow-lg shrink-0 transition-transform hover:scale-105"
                style={{
                  background: isPro
                    ? "linear-gradient(135deg, hsl(252 83% 57%), hsl(280 80% 60%))"
                    : "linear-gradient(135deg, hsl(38 92% 50%), hsl(15 100% 55%))",
                  boxShadow: `0 0 16px hsl(${isPro ? "252 83% 57%" : "38 92% 50%"} / 0.45)`,
                }}>
                {isPro ? <Building2 className="h-4 w-4" /> : <Crown className="h-4 w-4" />}
                Upgrade
              </Link>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="pp-fade-in mt-12 flex items-center justify-center gap-2 text-[10px] text-white/25 font-mono" style={{ animationDelay: "600ms" }}>
          <span className="h-px w-12 bg-linear-to-r from-transparent to-white/15" />
          <Sparkles className="h-3 w-3" />
          <span>Hero AI Studio · studio.heroaiengine.com</span>
          <span className="h-px w-12 bg-linear-to-l from-transparent to-white/15" />
        </div>
      </div>
    </div>
  );
}
