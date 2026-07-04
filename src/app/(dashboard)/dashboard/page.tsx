"use client";

import { useEffect, useState } from "react";
import {
  Palette, FileText, Video, Crown, Building2, ArrowRight,
  Loader2, AlertTriangle, Clapperboard, BookOpen,
  Activity, Users, Ticket,
} from "lucide-react";
import Link from "next/link";
import { DashboardOnboarding } from "@/components/onboarding/DashboardOnboarding";
import { QuotaStatus } from "@/components/quota-status";
import { V2JobBadge } from "@/components/v2-job-badge";
import { DashboardFounderBanner } from "@/components/marketing/founder-banner";

type PlanKey = "FREE" | "PRO" | "BUSINESS";
type Role = "ADMIN" | "USER";

interface Stats {
  plan: PlanKey;
  proExpiresAt: string | null;
  styleCount: number;
  contentCount: number;
  videoCount: number;
  limits: { styles: number | null; contents: number | null; images: null };
  recentContents: { id: string; headline: string | null; createdAt: string; language: string }[];
  recentVideos: { id: string; status: string; createdAt: string; avatarModel: string; script?: string | null; content: { headline: string | null } | null }[];
}

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts)
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";

// .ve-card / .ve-card-hover / .ve-rise now live in globals.css (Editor v2 house utilities).

function daysLeft(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86400000);
}

// Status pills are STATE (semantic), not the violet accent.
function statusStyle(s: string): React.CSSProperties {
  if (s === "COMPLETED") return { color: "#34D399", background: "rgba(52,211,153,.10)", border: "1px solid rgba(52,211,153,.30)" };
  if (s === "PROCESSING") return { color: "#38BDF8", background: "rgba(56,189,248,.10)", border: "1px solid rgba(56,189,248,.30)" };
  if (s === "FAILED") return { color: "#F87171", background: "rgba(248,113,113,.10)", border: "1px solid rgba(248,113,113,.30)" };
  return { color: "var(--ui-text-muted)", background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-badge-neutral-border)" };
}

function UsageBar({ count, limit }: { count: number; limit: number | null }) {
  if (!limit) return null;
  const pct = Math.min((count / limit) * 100, 100);
  const warn = pct >= 80;
  return (
    <div className="mt-4 space-y-1.5">
      <div className="flex justify-between text-[10px] font-mono" style={{ color: "var(--ui-text-muted)" }}>
        <span>{count} / {limit}</span>
        {/* warn = amber (semantic warning), otherwise violet */}
        <span style={{ color: warn ? "#FBBF24" : VIOLET_LIGHT }}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--ui-divider)" }}>
        <div className="h-full rounded-full transition-all" style={{
          width: `${pct}%`,
          background: warn ? "#FBBF24" : VIOLET_GRAD,
        }} />
      </div>
    </div>
  );
}

/** Flat violet quick-action launcher card. */
function QuickCard({ label, desc, href, Icon }: {
  label: string; desc: string; href: string; Icon: React.ElementType;
}) {
  return (
    <Link
      href={href}
      prefetch={true}
      className="ve-card ve-card-hover group relative flex items-start gap-3 rounded-xl p-4"
      style={{ minHeight: 44 }}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px]"
        style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
        <Icon className="h-[18px] w-[18px]" style={{ color: VIOLET }} strokeWidth={2.1} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>{label}</p>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
      </div>
      <ArrowRight
        className="mt-0.5 h-4 w-4 shrink-0 transition-all group-hover:translate-x-0.5 group-hover:text-[#B9A6FF]"
        style={{ color: "var(--ui-text-muted)" }}
      />
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>
      {children}
    </p>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [role, setRole] = useState<Role>("USER");

  useEffect(() => {
    fetch("/api/user/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
    fetch("/api/user/me").then(r => r.json()).then(d => {
      if (d.name) setUserName(d.name);
      if (d.role === "ADMIN" || d.role === "USER") setRole(d.role);
    }).catch(() => {});
  }, []);

  const isAdmin = role === "ADMIN";
  const isBusiness = stats?.plan === "BUSINESS";
  const isPro = stats?.plan === "PRO";
  const isPaid = isPro || isBusiness;
  const planLabel = isBusiness ? "Business Plan" : isPro ? "Pro Plan" : "Free Plan";

  const atStyleLimit = !isPaid && stats ? stats.styleCount >= (stats.limits?.styles ?? Infinity) : false;
  const atContentLimit = !isPaid && stats ? stats.contentCount >= (stats.limits?.contents ?? Infinity) : false;

  // Plan badge — violet single accent (Business = filled gradient, Pro = violet outline, Free = neutral)
  const PlanIcon = isBusiness ? Building2 : Crown;
  const planBadgeStyle: React.CSSProperties = isBusiness
    ? { background: VIOLET_GRAD, color: "#fff", border: "1px solid transparent" }
    : isPro
    ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT, border: `1px solid ${VIOLET_TILE_BORDER}` }
    : { background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-secondary)", border: "1px solid var(--ui-badge-neutral-border)" };

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-5xl px-4 md:px-6 pt-4 md:pt-6 pb-12">

        {/* Editor v2 background job (renders nothing unless a v2 job exists) */}
        <V2JobBadge />

        {/* Eyebrow */}
        <p className="ve-rise mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: VIOLET_LIGHT }}>
          แดชบอร์ด · {planLabel}
        </p>

        {/* Title row */}
        <div className="ve-rise flex flex-wrap items-start justify-between gap-3 mb-2" style={{ animationDelay: "40ms" }}>
          <h1 className="text-[30px] font-bold leading-tight tracking-tight"
            style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
            สวัสดีคุณ{" "}
            <span style={{
              backgroundImage: "linear-gradient(135deg,#B9A6FF,#8B66F8)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}>
              {userName || "ผู้ใช้งาน"}
            </span>
          </h1>

          {/* Plan badge */}
          {stats && (
            <div className="flex flex-col items-end gap-1.5">
              <span className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold"
                style={planBadgeStyle}>
                <PlanIcon className="h-3.5 w-3.5" />
                {planLabel}
              </span>
              {isPaid && stats.proExpiresAt && (() => {
                const d = daysLeft(stats.proExpiresAt!);
                const pillStyle: React.CSSProperties =
                  d <= 3 ? { background: "rgba(248,113,113,.10)", color: "#F87171", border: "1px solid rgba(248,113,113,.30)" }
                  : d <= 7 ? { background: "rgba(251,191,36,.10)", color: "#FBBF24", border: "1px solid rgba(251,191,36,.30)" }
                  : { background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-muted)", border: "1px solid var(--ui-badge-neutral-border)" };
                return (
                  <span className="rounded-md px-2 py-0.5 text-[10px] font-mono font-semibold" style={pillStyle}>
                    {d > 0 ? `${d}d remaining` : "Expired"}
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        <p className="ve-rise mb-6 max-w-2xl text-[15px] leading-relaxed" style={{ animationDelay: "80ms", color: "var(--ui-text-secondary)" }}>
          {isAdmin
            ? "ศูนย์ควบคุมผู้ดูแล — เลือกเครื่องมือด้านล่างเพื่อเริ่ม"
            : "เริ่มสร้างเนื้อหาวิดีโอด้วย AI — เลือก action ด้านล่างเพื่อเริ่ม"}
        </p>

        {/* Founder-urgency banner — non-paid users only, while founding seats remain */}
        <DashboardFounderBanner plan={stats?.plan} />

        {/* Key setup checklist + first-login wizard (self-gating) */}
        <DashboardOnboarding />

        {/* Minute / clip balance chip — self-fetches */}
        <div className="ve-rise mb-6" style={{ animationDelay: "100ms" }}>
          <QuotaStatus variant="chip" />
        </div>

        {/* Quick actions */}
        {isAdmin ? (
          <div className="ve-rise mb-8 space-y-6" style={{ animationDelay: "120ms" }}>
            <div>
              <SectionLabel>ผู้ดูแลระบบ</SectionLabel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <QuickCard label="Insights" desc="สรุปรายได้ & การใช้งาน" href="/admin/insights" Icon={Activity} />
                <QuickCard label="จัดการผู้ใช้" desc="ผู้ใช้ & แผน" href="/admin/users" Icon={Users} />
                <QuickCard label="คูปอง" desc="โค้ดส่วนลด & โปรฯ" href="/admin/coupons" Icon={Ticket} />
              </div>
            </div>
            <div>
              <SectionLabel>สร้างวิดีโอ</SectionLabel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <QuickCard label="Video Editor" desc="Timeline editor" href="/video-editor" Icon={Clapperboard} />
                <QuickCard label="Gallery" desc="ดู renders เก่า" href="/videos" Icon={Video} />
              </div>
            </div>
          </div>
        ) : (
          <div className="ve-rise mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3" style={{ animationDelay: "120ms" }}>
            <QuickCard label="Video Editor" desc="Timeline editor" href="/video-editor" Icon={Clapperboard} />
            <QuickCard label="Gallery" desc="ดู renders เก่า" href="/videos" Icon={Video} />
            <QuickCard label="วิธีใช้งาน" desc="คู่มือ & สอนใช้ทีละขั้น" href="/docs" Icon={BookOpen} />
          </div>
        )}

        {/* USER-only: limit warning for unpaid users at limit */}
        {!isAdmin && !isPaid && (atStyleLimit || atContentLimit) && (
          <div className="ve-rise mb-6 flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.30)" }}>
            <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "#FBBF24" }} />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>คุณใช้ Free plan ครบ limit แล้ว</p>
              <p className="mt-0.5 text-xs" style={{ color: "var(--ui-text-secondary)" }}>Upgrade เป็น Pro เพื่อใช้งานไม่จำกัด</p>
            </div>
            <Link href="/pricing" className="rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:brightness-110"
              style={{ background: VIOLET_GRAD }}>
              Upgrade
            </Link>
          </div>
        )}

        {/* USER-only: stats grid */}
        {!isAdmin && (
          <div className="ve-rise mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2" style={{ animationDelay: "160ms" }}>
            {[
              { label: "Styles", count: stats?.styleCount ?? 0, limit: stats?.limits?.styles ?? null, icon: Palette, href: "/style" },
              { label: "Videos", count: stats?.videoCount ?? 0, limit: null as number | null, icon: Video, href: "/videos" },
            ].map(({ label, count, limit, icon: Icon, href }) => (
              <Link key={href} href={href} className="ve-card ve-card-hover block rounded-xl p-6">
                <div className="mb-5 flex items-start justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px]"
                    style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
                    <Icon className="h-[18px] w-[18px]" style={{ color: VIOLET }} strokeWidth={2.1} />
                  </div>
                </div>
                {loading ? null : (
                  <p className="text-[44px] font-bold leading-none tracking-tight tabular-nums"
                    style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>{count}</p>
                )}
                <UsageBar count={count} limit={limit} />
                {!isPaid && label === "Videos" && (
                  <div className="mt-3 flex items-center gap-1.5">
                    <Crown className="h-3 w-3" style={{ color: VIOLET_LIGHT }} />
                    <p className="text-[11px] font-semibold" style={{ color: VIOLET_LIGHT }}>Pro only feature</p>
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}

        {/* Recent activity — both roles, only when data exists */}
        {((stats?.recentContents?.length ?? 0) > 0 || (stats?.recentVideos?.length ?? 0) > 0) && (
          <div className="ve-rise mb-8 grid gap-4 md:grid-cols-2" style={{ animationDelay: "200ms" }}>
            {(stats?.recentContents?.length ?? 0) > 0 && (
              <div className="ve-card rounded-xl p-6">
                <div className="mb-4 flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--ui-divider)" }}>
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5" style={{ color: VIOLET_LIGHT }} />
                    <p className="text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color: "var(--ui-text-secondary)" }}>Recent Content</p>
                  </div>
                  <Link href="/content" className="group flex items-center gap-1 text-[11px] font-semibold transition-colors" style={{ color: VIOLET_LIGHT }}>
                    View all <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
                <div className="space-y-0.5">
                  {stats!.recentContents.map((c) => (
                    <Link key={c.id} href="/content">
                      <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[rgba(139,92,246,.06)]">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: VIOLET_TILE_BORDER }} />
                        <p className="flex-1 truncate text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>{c.headline || "Untitled"}</p>
                        <p className="shrink-0 text-[10px] font-mono" style={{ color: "var(--ui-text-muted)" }}>
                          {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {(stats?.recentVideos?.length ?? 0) > 0 && (
              <div className="ve-card rounded-xl p-6">
                <div className="mb-4 flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--ui-divider)" }}>
                  <div className="flex items-center gap-2">
                    <Video className="h-3.5 w-3.5" style={{ color: VIOLET_LIGHT }} />
                    <p className="text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color: "var(--ui-text-secondary)" }}>Recent Videos</p>
                  </div>
                  <Link href="/videos" className="group flex items-center gap-1 text-[11px] font-semibold transition-colors" style={{ color: VIOLET_LIGHT }}>
                    View all <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
                <div className="space-y-0.5">
                  {stats!.recentVideos.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: VIOLET_TILE_BORDER }} />
                      <p className="flex-1 truncate text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>{v.content?.headline || (v.script ? v.script.slice(0, 40) + "…" : "วิดีโอ " + new Date(v.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" }))}</p>
                      <span className="shrink-0 rounded-md px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={statusStyle(v.status)}>
                        {v.status === "PROCESSING" && <Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />}
                        {v.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Upgrade CTA — USER only, when not on Business */}
        {!isAdmin && stats && !isBusiness && (
          <div className="ve-rise ve-card flex items-center gap-4 rounded-xl p-5" style={{ animationDelay: "260ms" }}>
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[11px]"
              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
              {isPro
                ? <Building2 className="h-5 w-5" style={{ color: VIOLET }} strokeWidth={2.1} />
                : <Crown className="h-5 w-5" style={{ color: VIOLET }} strokeWidth={2.1} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                {isPro ? "Upgrade to Business" : "Upgrade to Pro"}
              </p>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--ui-text-secondary)" }}>
                {isPro
                  ? "150 นาที/เดือน • วิดีโอ 10 นาที/คลิป • เก็บวิดีโอ 14 วัน • Priority support"
                  : "Unlimited styles, content และ avatar videos"}
              </p>
            </div>
            <Link href="/pricing" className="flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110"
              style={{ background: VIOLET_GRAD }}>
              {isPro ? <Building2 className="h-4 w-4" /> : <Crown className="h-4 w-4" />}
              Upgrade
            </Link>
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 text-center text-[10px] font-mono" style={{ color: "var(--ui-text-muted)" }}>
          Hero AI Studio · studio.heroaiengine.com
        </div>
      </div>
    </div>
  );
}
