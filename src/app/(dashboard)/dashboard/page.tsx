"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import {
  Palette, FileText, Video, Sparkles, Crown, Building2, ArrowRight,
  Clock, CheckCircle2, Loader2, AlertTriangle, Film, Zap,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

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

const CARD: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

function UsageBar({ count, limit }: { count: number; limit: number | null }) {
  if (!limit) return null;
  const pct = Math.min((count / limit) * 100, 100);
  const warn = pct >= 80;
  return (
    <div className="mt-3 space-y-1">
      <div className="flex justify-between text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
        <span>{count} / {limit} used</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--ui-btn-bg)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: warn ? "hsl(38 92% 50%)" : "hsl(190 100% 50%)" }} />
      </div>
    </div>
  );
}

function statusStyle(s: string) {
  if (s === "COMPLETED") return "text-green-500";
  if (s === "PROCESSING") return "text-cyan-500";
  if (s === "FAILED") return "text-red-500";
  return "text-gray-400";
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/user/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
  }, []);

  const isBusiness = stats?.plan === "BUSINESS";
  const isPro = stats?.plan === "PRO";
  const isPaid = isPro || isBusiness;
  const planLabel = isBusiness ? "Business Plan" : isPro ? "Pro Plan" : "Free Plan";
  const PlanIcon = isBusiness ? Building2 : Crown;
  const planBadgeBg = isBusiness ? "hsl(252 83% 57% / 0.12)" : isPro ? "hsl(38 92% 50% / 0.12)" : "var(--ui-btn-bg)";
  const planBadgeBorder = isBusiness ? "hsl(252 83% 57% / 0.35)" : isPro ? "hsl(38 92% 50% / 0.3)" : "var(--ui-btn-border)";
  const planBadgeColor = isBusiness ? "hsl(252 83% 70%)" : isPro ? "hsl(38 92% 45%)" : "var(--ui-text-muted)";

  const atStyleLimit = !isPaid && stats ? stats.styleCount >= (stats.limits?.styles ?? Infinity) : false;
  const atContentLimit = !isPaid && stats ? stats.contentCount >= (stats.limits?.contents ?? Infinity) : false;

  return (
    <>
      <div className="space-y-8 max-w-7xl mx-auto">

        {/* Welcome hero — premium gradient + ambient glow */}
        <div className="premium-card-featured relative overflow-hidden p-8 md:p-10">
          {/* Ambient glow */}
          <div className="absolute -right-10 -top-10 h-72 w-72 rounded-full blur-3xl pointer-events-none"
            style={{ background: "radial-gradient(circle, hsl(var(--accent-secondary) / 0.18), transparent 70%)" }} />
          <div className="absolute -left-20 -bottom-20 h-72 w-72 rounded-full blur-3xl pointer-events-none"
            style={{ background: "radial-gradient(circle, hsl(var(--accent-primary) / 0.12), transparent 70%)" }} />

          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="h-3.5 w-3.5" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.5} />
              <span className="eyebrow" style={{ color: "hsl(var(--accent-primary))" }}>Welcome Back</span>
            </div>
            <h1 className="section-heading mb-2">
              สวัสดีคุณ <span className="gradient-text">{session?.user?.name || "ผู้ใช้งาน"}</span>
            </h1>
            <p className="text-base" style={{ color: "var(--ui-text-secondary)" }}>เริ่มสร้างเนื้อหาของคุณวันนี้</p>
            <div className="flex flex-wrap gap-3 mt-7">
              <Link href="/content" className="btn-premium-primary">
                <Sparkles className="h-4 w-4" strokeWidth={2.5} /> Generate Content
              </Link>
              <Link href="/video-creator" className="btn-premium-secondary">
                <Film className="h-4 w-4" /> Avatar Cloning
              </Link>
            </div>
          </div>
          {/* Plan badge */}
          {stats && (
            <div className="absolute top-6 right-6 flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold"
                style={{
                  background: planBadgeBg,
                  border: `1px solid ${planBadgeBorder}`,
                  color: planBadgeColor,
                }}>
                <PlanIcon className="h-3.5 w-3.5" />
                {planLabel}
              </div>
              {isPaid && stats.proExpiresAt && (() => {
                const d = daysLeft(stats.proExpiresAt!);
                return (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${d <= 3 ? "bg-red-500/15 text-red-400" : d <= 7 ? "bg-amber-500/15 text-amber-400" : "bg-white/5 text-white/35"}`}>
                    {d > 0 ? `หมดใน ${d} วัน` : "หมดอายุแล้ว"}
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        {/* Limit warning — only for unpaid users */}
        {!isPaid && (atStyleLimit || atContentLimit) && (
          <div className="flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ background: "hsl(38 92% 50% / 0.08)", border: "1px solid hsl(38 92% 50% / 0.25)" }}>
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-600 dark:text-amber-300">You've reached your Free plan limit</p>
              <p className="text-xs text-amber-500/70">Upgrade to Pro for unlimited access</p>
            </div>
            <Link href="/pricing" className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
              style={{ background: "hsl(38 92% 50%)" }}>
              Upgrade
            </Link>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid gap-5 sm:grid-cols-3">
          {[
            { label: "Styles", count: stats?.styleCount ?? 0, limit: stats?.limits?.styles ?? null, icon: Palette, href: "/style", color: "hsl(220 90% 65%)" },
            { label: "Content", count: stats?.contentCount ?? 0, limit: stats?.limits?.contents ?? null, icon: FileText, href: "/content", color: "hsl(252 70% 65%)" },
            { label: "Videos", count: stats?.videoCount ?? 0, limit: null, icon: Video, href: "/videos", color: "hsl(142 60% 50%)" },
          ].map(({ label, count, limit, icon: Icon, href, color }) => (
            <Link key={href} href={href}>
              <div className="premium-card premium-card-interactive p-6">
                <div className="flex items-center justify-between mb-5">
                  <p className="eyebrow">{label}</p>
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl"
                    style={{
                      background: color + "1A",
                      border: `1px solid ${color}33`,
                      boxShadow: `0 4px 12px ${color}1F`,
                    }}>
                    <Icon className="h-4 w-4" style={{ color }} strokeWidth={2.25} />
                  </div>
                </div>
                {loading ? (
                  <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--ui-text-muted)" }} />
                ) : (
                  <p className="text-4xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>{count}</p>
                )}
                <UsageBar count={count} limit={limit} />
                {!isPaid && label === "Videos" && (
                  <p className="mt-3 text-xs font-medium text-amber-400/90">Pro only</p>
                )}
              </div>
            </Link>
          ))}
        </div>


        {/* Recent activity */}
        {!loading && ((stats?.recentContents?.length ?? 0) > 0 || (stats?.recentVideos?.length ?? 0) > 0) && (
          <div className="grid gap-5 md:grid-cols-2">
            {(stats?.recentContents?.length ?? 0) > 0 && (
              <div className="premium-card p-6">
                <div className="flex items-center justify-between mb-5">
                  <p className="eyebrow">Recent Content</p>
                  <Link href="/content" className="text-xs font-medium transition-colors flex items-center gap-1 hover:gap-1.5"
                    style={{ color: "hsl(var(--accent-primary))" }}>
                    View all <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="space-y-0.5">
                  {stats!.recentContents.map((c) => (
                    <Link key={c.id} href="/content">
                      <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/3">
                        <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ui-text-muted)" }} strokeWidth={1.75} />
                        <p className="flex-1 truncate text-sm" style={{ color: "var(--ui-text-secondary)" }}>{c.headline || "Untitled"}</p>
                        <p className="text-[10px] shrink-0 font-medium" style={{ color: "var(--ui-text-muted)" }}>
                          {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {(stats?.recentVideos?.length ?? 0) > 0 && (
              <div className="premium-card p-6">
                <div className="flex items-center justify-between mb-5">
                  <p className="eyebrow">Recent Videos</p>
                  <Link href="/videos" className="text-xs font-medium transition-colors flex items-center gap-1 hover:gap-1.5"
                    style={{ color: "hsl(var(--accent-primary))" }}>
                    View all <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="space-y-0.5">
                  {stats!.recentVideos.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
                      <Video className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ui-text-muted)" }} strokeWidth={1.75} />
                      <p className="flex-1 truncate text-sm" style={{ color: "var(--ui-text-secondary)" }}>{v.content?.headline || v.avatarModel}</p>
                      <span className={`text-[10px] shrink-0 font-medium ${statusStyle(v.status)}`}>
                        {v.status === "PROCESSING" && <Loader2 className="inline h-3 w-3 animate-spin mr-1" />}
                        {v.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Upgrade CTA — Free → Pro, Pro → Business, Business → hidden */}
        {stats && !isBusiness && (
          <div className="flex items-center gap-4 rounded-xl p-5"
            style={{
              background: isPro ? "hsl(252 83% 57% / 0.06)" : "hsl(38 92% 50% / 0.06)",
              border: `1px solid ${isPro ? "hsl(252 83% 57% / 0.25)" : "hsl(38 92% 50% / 0.2)"}`,
            }}>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
              style={{ background: isPro ? "hsl(252 83% 57% / 0.14)" : "hsl(38 92% 50% / 0.12)" }}>
              {isPro
                ? <Building2 className="h-5 w-5 text-violet-300" />
                : <Crown className="h-5 w-5 text-amber-500" />
              }
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>
                {isPro ? "Upgrade to Business" : "Upgrade to Pro"}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                {isPro
                  ? "Up to 300 clips/month, 10-min videos, 90-day storage, priority support"
                  : "Unlimited styles, content, and avatar videos"}
              </p>
            </div>
            <Link href="/pricing" className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ background: isPro ? "hsl(252 83% 57%)" : "hsl(38 92% 50%)" }}>
              {isPro ? <Building2 className="h-4 w-4" /> : <Crown className="h-4 w-4" />}
              Upgrade
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
