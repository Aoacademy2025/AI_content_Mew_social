"use client";

import { useEffect, useState } from "react";
import {
  Palette, FileText, Video, Sparkles, Crown, Building2, ArrowRight,
  Loader2, AlertTriangle, Film, Clapperboard, BookOpen, Settings,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";

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

/* ═══════════════════════════════════════════════════
   SCI-FI / NEON COMPONENTS
═══════════════════════════════════════════════════ */

function CornerBrackets({ color = "cyan" }: { color?: "cyan" | "violet" | "amber" }) {
  const colorMap = {
    cyan:   "border-cyan-400/40",
    violet: "border-violet-400/40",
    amber:  "border-amber-400/40",
  };
  const C = `absolute h-3 w-3 ${colorMap[color]} pointer-events-none`;
  return (
    <>
      <span aria-hidden className={`${C} top-2 left-2 border-t border-l rounded-tl-sm`} />
      <span aria-hidden className={`${C} top-2 right-2 border-t border-r rounded-tr-sm`} />
      <span aria-hidden className={`${C} bottom-2 left-2 border-b border-l rounded-bl-sm`} />
      <span aria-hidden className={`${C} bottom-2 right-2 border-b border-r rounded-br-sm`} />
    </>
  );
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
      {/* ── Full-page sci-fi backdrop — same vibe as /docs ────────────── */}
      <div aria-hidden className="dash-grid-bg pointer-events-none fixed inset-0 z-0" />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="dash-orb-1 absolute -top-32 left-[15%] h-112 w-md rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)" }} />
        <div className="dash-orb-2 absolute -top-20 right-[10%] h-96 w-96 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)" }} />
        <div className="dash-orb-3 absolute top-[40%] left-1/2 -translate-x-1/2 h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(285 70% 60%), transparent)" }} />
        <div className="dash-orb-1 absolute bottom-[15%] right-[8%] h-96 w-96 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)", animationDelay: "-7s" }} />
        <div className="dash-orb-2 absolute bottom-[5%] left-[10%] h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)", animationDelay: "-12s" }} />
      </div>

      {/* ── Premium animations & decorations ─────────────────────────── */}
      <style jsx global>{`
        @keyframes dash-orb-1 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.32; }
          33%     { transform: translate(50px,40px) scale(1.18); opacity: 0.45; }
          66%     { transform: translate(-40px,60px) scale(0.95); opacity: 0.28; }
        }
        @keyframes dash-orb-2 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.25; }
          50%     { transform: translate(-60px,50px) scale(1.22); opacity: 0.42; }
        }
        @keyframes dash-orb-3 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.20; }
          50%     { transform: translate(40px,-50px) scale(1.12); opacity: 0.35; }
        }
        @keyframes dash-grid-drift {
          0%   { background-position: 0 0; }
          100% { background-position: 40px 40px; }
        }
        @keyframes dash-border-spin {
          0%   { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        @keyframes dash-shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes dash-fade-up {
          0%   { opacity: 0; transform: translateY(14px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes dash-fade-in {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes dash-icon-pulse {
          0%,100% { box-shadow: 0 0 0 1px hsl(var(--c-accent) / 0.35) inset, 0 0 12px hsl(var(--c-accent) / 0.20); }
          50%     { box-shadow: 0 0 0 1px hsl(var(--c-accent) / 0.55) inset, 0 0 22px hsl(var(--c-accent) / 0.40); }
        }
        @keyframes dash-chip-pulse {
          0%,100% { opacity: 1; }
          50%     { opacity: 0.55; }
        }

        .dash-orb-1 { animation: dash-orb-1 24s cubic-bezier(.45,.05,.55,.95) infinite; }
        .dash-orb-2 { animation: dash-orb-2 28s cubic-bezier(.45,.05,.55,.95) infinite; }
        .dash-orb-3 { animation: dash-orb-3 21s cubic-bezier(.45,.05,.55,.95) infinite; }
        .dash-grid-bg {
          background-image:
            linear-gradient(hsl(0 0% 100% / 0.025) 1px, transparent 1px),
            linear-gradient(90deg, hsl(0 0% 100% / 0.025) 1px, transparent 1px);
          background-size: 40px 40px;
          animation: dash-grid-drift 30s linear infinite;
          mask-image: linear-gradient(to bottom, black 0%, black 70%, hsl(0 0% 0% / 0.7) 100%);
        }
        .dash-fade-up { animation: dash-fade-up 0.6s cubic-bezier(.2,.65,.3,1) both; }
        .dash-fade-in { animation: dash-fade-in 0.5s ease-out both; }
        .dash-chip-dot { animation: dash-chip-pulse 2s ease-in-out infinite; }

        .dash-card {
          position: relative;
          background:
            radial-gradient(120% 80% at 0% 0%, hsl(190 100% 50% / 0.04), transparent 50%),
            radial-gradient(120% 80% at 100% 100%, hsl(252 80% 60% / 0.04), transparent 50%),
            hsl(220 30% 6% / 0.85);
          backdrop-filter: blur(12px);
          box-shadow:
            0 1px 0 hsl(0 0% 100% / 0.04) inset,
            0 24px 48px hsl(0 0% 0% / 0.35);
          border-radius: 1rem;
        }
        .dash-card-border {
          position: absolute;
          inset: 0;
          padding: 1px;
          border-radius: 1rem;
          background: linear-gradient(110deg,
            hsl(0 0% 100% / 0.04) 0%,
            hsl(190 100% 50% / 0.40) 20%,
            hsl(252 80% 60% / 0.30) 40%,
            hsl(0 0% 100% / 0.04) 60%,
            hsl(190 100% 50% / 0.35) 80%,
            hsl(0 0% 100% / 0.04) 100%);
          background-size: 200% 100%;
          animation: dash-border-spin 8s linear infinite;
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
                  mask-composite: exclude;
          pointer-events: none;
        }
        .dash-card-interactive:hover .dash-card-border { animation-duration: 3.5s; }
        .dash-card-interactive { transition: transform 220ms cubic-bezier(.2,.65,.3,1); }
        .dash-card-interactive:hover { transform: translateY(-2px); }

        .dash-icon-frame {
          background: linear-gradient(135deg, hsl(var(--c-accent) / 0.18), hsl(var(--c-accent) / 0.06));
          border: 1px solid hsl(var(--c-accent) / 0.40);
          animation: dash-icon-pulse 3.6s ease-in-out infinite;
        }

        /* Skeleton — shimmer placeholder that matches card aesthetic, no spinner */
        @keyframes dash-skeleton-shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .dash-skeleton {
          background:
            linear-gradient(90deg,
              hsl(0 0% 100% / 0.04) 0%,
              hsl(190 100% 50% / 0.08) 40%,
              hsl(252 80% 60% / 0.06) 60%,
              hsl(0 0% 100% / 0.04) 100%);
          background-size: 200% 100%;
          animation: dash-skeleton-shimmer 1.6s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .dash-orb-1, .dash-orb-2, .dash-orb-3, .dash-grid-bg, .dash-fade-up, .dash-fade-in,
          .dash-chip-dot, .dash-card-border, .dash-icon-frame, .dash-skeleton {
            animation: none !important;
          }
        }
      `}</style>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 md:px-6 pt-3 md:pt-4 pb-12">

        {/* Eyebrow */}
        <div className="dash-fade-up flex items-center gap-2 mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/70"
          style={{ animationDelay: "0ms" }}>
          <span className="h-px w-6 bg-linear-to-r from-transparent to-cyan-400/50" />
          Dashboard
          <span className="dash-chip-dot h-1 w-1 rounded-full bg-cyan-400" />
          {planLabel}
        </div>

        {/* Title row */}
        <div className="dash-fade-up flex flex-wrap items-end justify-between gap-4 mb-1" style={{ animationDelay: "60ms" }}>
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

        <p className="dash-fade-up text-base text-white/55 max-w-2xl leading-relaxed mb-6" style={{ animationDelay: "140ms" }}>
          เริ่มสร้างเนื้อหาวิดีโอด้วย AI — เลือก action ด้านล่างเพื่อเริ่ม
        </p>

        {/* Quick actions — premium CTA row */}
        <div className="dash-fade-up grid grid-cols-2 md:grid-cols-4 gap-3 mb-8" style={{ animationDelay: "120ms" }}>
          {[
            { label: "Video Editor", desc: "Timeline editor", href: "/video-editor", Icon: Clapperboard, color: "190 100% 50%" },
            { label: "Content",      desc: "Generate script",  href: "/content",      Icon: FileText,     color: "252 80% 60%" },
            { label: "Gallery",      desc: "ดู renders เก่า",   href: "/videos",       Icon: Video,        color: "142 70% 45%" },
            { label: "Docs",         desc: "วิธีใช้งาน",        href: "/docs",         Icon: BookOpen,     color: "35 90% 55%" },
          ].map(({ label, desc, href, Icon, color }) => (
            <Link key={href} href={href} className="dash-card dash-card-interactive overflow-hidden relative group">
              <span aria-hidden className="dash-card-border" />
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
          <div className="dash-fade-in relative overflow-hidden rounded-xl px-4 py-3 mb-6 flex items-center gap-3"
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
        <div className="dash-fade-up grid gap-4 grid-cols-1 sm:grid-cols-3 mb-8" style={{ animationDelay: "180ms" }}>
          {[
            { label: "Styles",  count: stats?.styleCount ?? 0,   limit: stats?.limits?.styles ?? null,   icon: Palette,  href: "/style",   color: "220 90% 65%" },
            { label: "Content", count: stats?.contentCount ?? 0, limit: stats?.limits?.contents ?? null, icon: FileText, href: "/content", color: "252 70% 65%" },
            { label: "Videos",  count: stats?.videoCount ?? 0,   limit: null,                            icon: Video,    href: "/videos",  color: "142 60% 50%" },
          ].map(({ label, count, limit, icon: Icon, href, color }) => (
            <Link key={href} href={href} className="dash-card dash-card-interactive overflow-hidden block">
              <span aria-hidden className="dash-card-border" />
              <CornerBrackets />
              <div className="relative p-6">
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/50">{label}</p>
                    <p className="text-[10px] font-mono text-white/30 mt-0.5">#{href.slice(1)}</p>
                  </div>
                  <div className="dash-icon-frame relative flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
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
          <div className="dash-fade-up grid gap-5 md:grid-cols-2 mb-8" style={{ animationDelay: "240ms" }}>
            {(stats?.recentContents?.length ?? 0) > 0 && (
              <div className="dash-card overflow-hidden relative">
                <span aria-hidden className="dash-card-border" />
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
              <div className="dash-card overflow-hidden relative">
                <span aria-hidden className="dash-card-border" />
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
          <div className="dash-fade-in dash-card overflow-hidden relative" style={{ animationDelay: "500ms" }}>
            <span aria-hidden className="dash-card-border" />
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
        <div className="dash-fade-in mt-12 flex items-center justify-center gap-2 text-[10px] text-white/25 font-mono" style={{ animationDelay: "600ms" }}>
          <span className="h-px w-12 bg-linear-to-r from-transparent to-white/15" />
          <Sparkles className="h-3 w-3" />
          <span>Hero AI Studio · studio.heroaiengine.com</span>
          <span className="h-px w-12 bg-linear-to-l from-transparent to-white/15" />
        </div>
      </div>
    </div>
  );
}
