"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  Palette, FileText, Video, Sparkles, Crown, ArrowRight,
  Clock, CheckCircle2, Loader2, AlertTriangle, Film, Zap,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface Stats {
  plan: "FREE" | "PRO";
  styleCount: number;
  contentCount: number;
  videoCount: number;
  limits: { styles: number | null; contents: number | null; images: null };
  recentContents: { id: string; headline: string | null; createdAt: string; language: string }[];
  recentVideos: { id: string; status: string; createdAt: string; avatarModel: string; content: { headline: string | null } | null }[];
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

  const isPro = stats?.plan === "PRO";
  const atStyleLimit = !isPro && stats ? stats.styleCount >= (stats.limits?.styles ?? Infinity) : false;
  const atContentLimit = !isPro && stats ? stats.contentCount >= (stats.limits?.contents ?? Infinity) : false;

  return (
    <DashboardLayout>
      <div className="space-y-6">

        {/* Welcome hero */}
        <div className="relative overflow-hidden rounded-2xl p-7"
          style={{
            background: "linear-gradient(135deg, var(--ui-card-bg-3), var(--ui-card-bg))",
            border: "1px solid hsl(190 100% 50% / 0.15)",
          }}>
          <div className="absolute right-0 top-0 h-48 w-48 rounded-full blur-3xl pointer-events-none"
            style={{ background: "hsl(190 100% 50% / 0.05)" }} />
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-cyan-500" />
              <span className="text-xs font-semibold text-cyan-500 uppercase tracking-wider">Welcome Back</span>
            </div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: "var(--ui-text-primary)" }}>
              สวัสดีคุณ {session?.user?.name || "ผู้ใช้งาน"}
            </h1>
            <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>เริ่มสร้างเนื้อหาของคุณวันนี้</p>
            <div className="flex gap-3 mt-5">
              <Link href="/content" className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
                <Sparkles className="h-4 w-4" /> Generate Content
              </Link>
              <Link href="/video-creator" className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}>
                <Film className="h-4 w-4" /> Avatar Cloning
              </Link>
            </div>
          </div>
          {/* Plan badge */}
          {stats && (
            <div className={`absolute top-6 right-6 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${isPro ? "text-amber-500" : ""}`}
              style={{
                background: isPro ? "hsl(38 92% 50% / 0.12)" : "var(--ui-btn-bg)",
                border: `1px solid ${isPro ? "hsl(38 92% 50% / 0.3)" : "var(--ui-btn-border)"}`,
                color: isPro ? "hsl(38 92% 45%)" : "var(--ui-text-muted)",
              }}>
              <Crown className="h-3.5 w-3.5" />
              {isPro ? "Pro Plan" : "Free Plan"}
            </div>
          )}
        </div>

        {/* Limit warning */}
        {!isPro && (atStyleLimit || atContentLimit) && (
          <div className="flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ background: "hsl(38 92% 50% / 0.08)", border: "1px solid hsl(38 92% 50% / 0.25)" }}>
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-600 dark:text-amber-300">You've reached your Free plan limit</p>
              <p className="text-xs text-amber-500/70">Upgrade to Pro for unlimited access</p>
            </div>
            <Link href="/settings" className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
              style={{ background: "hsl(38 92% 50%)" }}>
              Upgrade
            </Link>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Styles", count: stats?.styleCount ?? 0, limit: stats?.limits?.styles ?? null, icon: Palette, href: "/style", color: "hsl(190 100% 50%)" },
            { label: "Content", count: stats?.contentCount ?? 0, limit: stats?.limits?.contents ?? null, icon: FileText, href: "/content", color: "hsl(252 83% 57%)" },
            { label: "Videos", count: stats?.videoCount ?? 0, limit: null, icon: Video, href: "/videos", color: "hsl(142 72% 40%)" },
          ].map(({ label, count, limit, icon: Icon, href, color }) => (
            <Link key={href} href={href}>
              <div className="rounded-xl p-5 transition-all cursor-pointer hover:shadow-md" style={CARD}>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: color + "22" }}>
                    <Icon className="h-4 w-4" style={{ color }} />
                  </div>
                </div>
                {loading ? (
                  <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--ui-text-muted)" }} />
                ) : (
                  <p className="text-3xl font-bold" style={{ color: "var(--ui-text-primary)" }}>{count}</p>
                )}
                <UsageBar count={count} limit={limit} />
                {!isPro && label === "Videos" && (
                  <p className="mt-2 text-xs text-amber-500">Pro only</p>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Quick actions */}
        <div>
          <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: "var(--ui-text-muted)" }}>Quick Actions</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { title: "Create Style", desc: "Train AI with your writing voice", href: "/style", icon: Palette, disabled: atStyleLimit },
              { title: "Generate Content", desc: "AI social media content", href: "/content", icon: FileText, disabled: atContentLimit },
              { title: "Avatar Cloning", desc: "Create avatar videos from scripts", href: "/video-creator", icon: Film, disabled: !isPro },
            ].map(({ title, desc, href, icon: Icon, disabled }) => (
              <Link key={href} href={disabled ? "#" : href}>
                <div className={cn("group rounded-xl p-4 transition-all", disabled ? "opacity-40 cursor-not-allowed" : "hover:shadow-md cursor-pointer")} style={CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)" }}>
                      <Icon className="h-4 w-4 text-cyan-500" />
                    </div>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" style={{ color: "var(--ui-text-muted)" }} />
                  </div>
                  <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>{title}</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
                  {disabled && (
                    <p className="text-[10px] text-amber-500 mt-2">{href === "/video-creator" ? "Pro only" : "Limit reached"}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        {!loading && ((stats?.recentContents?.length ?? 0) > 0 || (stats?.recentVideos?.length ?? 0) > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            {(stats?.recentContents?.length ?? 0) > 0 && (
              <div className="rounded-xl p-5" style={CARD}>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>Recent Content</p>
                  <Link href="/content" className="text-xs text-cyan-500 hover:text-cyan-400 transition-colors flex items-center gap-1">
                    View all <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="space-y-1">
                  {stats!.recentContents.map((c) => (
                    <Link key={c.id} href="/content">
                      <div className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/5">
                        <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ui-text-muted)" }} />
                        <p className="flex-1 truncate text-xs" style={{ color: "var(--ui-text-secondary)" }}>{c.headline || "Untitled"}</p>
                        <p className="text-[10px] shrink-0" style={{ color: "var(--ui-text-muted)" }}>
                          {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {(stats?.recentVideos?.length ?? 0) > 0 && (
              <div className="rounded-xl p-5" style={CARD}>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>Recent Videos</p>
                  <Link href="/videos" className="text-xs text-cyan-500 hover:text-cyan-400 transition-colors flex items-center gap-1">
                    View all <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="space-y-1">
                  {stats!.recentVideos.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-lg px-3 py-2">
                      <Video className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ui-text-muted)" }} />
                      <p className="flex-1 truncate text-xs" style={{ color: "var(--ui-text-secondary)" }}>{v.content?.headline || v.avatarModel}</p>
                      <span className={`text-[10px] shrink-0 ${statusStyle(v.status)}`}>
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

        {/* Upgrade CTA */}
        {!isPro && stats && (
          <div className="flex items-center gap-4 rounded-xl p-5"
            style={{ background: "hsl(38 92% 50% / 0.06)", border: "1px solid hsl(38 92% 50% / 0.2)" }}>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
              style={{ background: "hsl(38 92% 50% / 0.12)" }}>
              <Crown className="h-5 w-5 text-amber-500" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Upgrade to Pro</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>Unlimited styles, content, and avatar videos</p>
            </div>
            <Link href="/settings" className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ background: "hsl(38 92% 50%)" }}>
              <Crown className="h-4 w-4" /> Upgrade
            </Link>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
