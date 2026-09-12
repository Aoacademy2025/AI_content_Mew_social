"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Users, Ban, FileText, Video, Images, UserPlus, CalendarDays,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
// Flat v2 card surface — inline var(--ui-*), matches settings/dashboard (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

interface AdminStats {
  totalUsers: number; freeUsers: number; paidUsers: number; suspendedUsers: number;
  totalContents: number; totalVideos: number; totalImages: number; newToday: number; newThisWeek: number;
}

// Single stat card — matches the original grid card (byte-identical for non-hero).
function StatCard({
  title, value, sub, icon: Icon, loading,
}: {
  title: string;
  value: number | string;
  sub: string;
  icon: React.ElementType;
  loading: boolean;
}) {
  return (
    <Card className="shadow-none" style={cardStyle}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{title}</CardTitle>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
          <Icon className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? null : (
          <div className="text-3xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>{value}</div>
        )}
        <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>{sub}</p>
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
  }, []);

  // ผู้ใช้งาน group — money (จ่ายจริง/Trial/Comped/MRR) now lives only on
  // /admin/revenue (ADR 0062, Task C4).
  const userStatCards = [
    { title: "ผู้ใช้งานทั้งหมด",    value: stats?.totalUsers ?? 0,     sub: `+${stats?.newToday ?? 0} รายในวันนี้`,             icon: Users        },
    { title: "ผู้ใช้งานระดับ Free",  value: stats?.freeUsers ?? 0,      sub: "ยังไม่ได้อยู่บนแผน PRO/BUSINESS",                  icon: Users        },
    { title: "ถูกระงับการใช้งาน",    value: stats?.suspendedUsers ?? 0, sub: "บัญชีที่ถูกระงับการเข้าถึง",                       icon: Ban          },
    { title: "เนื้อหาทั้งหมด",       value: stats?.totalContents ?? 0,  sub: "รวมจากผู้ใช้งานทุกราย",                            icon: FileText     },
    { title: "วิดีโอทั้งหมด",        value: stats?.totalVideos ?? 0,    sub: "รวมจากผู้ใช้งานทุกราย",                            icon: Video        },
    { title: "รูปภาพทั้งหมด",        value: stats?.totalImages ?? 0,    sub: "รวมจากผู้ใช้งานทุกราย",                            icon: Images       },
    { title: "สมัครใช้งานวันนี้",    value: stats?.newToday ?? 0,       sub: `${stats?.newThisWeek ?? 0} รายใน 7 วันที่ผ่านมา`, icon: UserPlus     },
    { title: "สมัครใช้งาน 7 วัน",   value: stats?.newThisWeek ?? 0,    sub: "ย้อนหลัง 1 สัปดาห์",                              icon: CalendarDays },
  ];

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              ผู้ดูแลระบบ · Admin Panel
            </p>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
              Admin Panel
            </h1>
            <p className="mt-1 text-[15px]" style={{ color: "var(--ui-text-secondary)" }}>จัดการระบบและผู้ใช้งานทั้งหมด</p>
          </div>
          <Link href="/admin/users">
            <Button className="gap-2 text-white transition-all hover:brightness-110" style={{ background: VIOLET_GRAD }}>
              <Users className="h-4 w-4" />
              จัดการผู้ใช้งาน
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>

        {/* ── Stats ────────────────────────────────────────────────────── */}
        <div className="space-y-8">
          {/* ผู้ใช้งาน group */}
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: VIOLET_LIGHT }}>ผู้ใช้งาน</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {userStatCards.map((card) => (
                <StatCard key={card.title} title={card.title} value={card.value} sub={card.sub} icon={card.icon} loading={loading} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
