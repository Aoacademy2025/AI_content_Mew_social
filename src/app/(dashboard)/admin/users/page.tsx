"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Crown,
  Building2,
  Ban,
  ShieldCheck,
  Trash2,
  Loader2,
  CheckCircle2,
  UserX,
  RefreshCw,
  Search,
  HardDrive,
  MessageSquareWarning,
  Ticket,
  ChevronDown,
  Check,
  BadgeDollarSign,
} from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see admin/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
// Flat v2 card surface — inline var(--ui-*), matches settings/admin (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };
const dropdownStyle: React.CSSProperties = { background: "var(--ui-card-bg-3)", borderColor: "var(--ui-card-border)", backdropFilter: "blur(8px)" };

type PlanKey = "FREE" | "PRO" | "BUSINESS";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "USER";
  plan: PlanKey;
  planExpiresAt?: string | null;
  suspended: boolean;
  createdAt: string;
  _count: { styles: number; contents: number; videos: number; images: number; supportTickets: number };
  couponRedemptions: { coupon: { code: string; durationDays: number; plan: PlanKey }; redeemedAt: string }[];
}

const PLAN_STYLES: Record<PlanKey, { bg: string; text: string; icon: React.ElementType | null; label: string }> = {
  FREE:     { bg: "bg-zinc-500/15",   text: "text-zinc-400",   icon: null,       label: "FREE" },
  PRO:      { bg: "bg-violet-500/10", text: "text-violet-300", icon: Crown,      label: "PRO" },
  BUSINESS: { bg: "bg-violet-500/20", text: "text-violet-200", icon: Building2,  label: "BUSINESS" },
};

interface CacheInfo {
  stocks: { count: number; sizeMb: number };
  renders: { count: number; sizeMb: number; protected: number };
  openTickets: number;
}

type ActionLoading = string | null;

function planExpiryFrom(user: AdminUser): Date | null {
  // Authoritative expiry lives on the user record. Coupon history is audit data,
  // not current access state.
  if (user.planExpiresAt) return new Date(user.planExpiresAt);
  return null;
}

function daysLeft(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86400000);
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<ActionLoading>(null);
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<Record<string, CacheInfo>>({});
  const [cacheLoading, setCacheLoading] = useState<string | null>(null);

  const fetchUsers = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function patchUser(
    id: string,
    data: {
      plan?: PlanKey;
      role?: "ADMIN" | "USER";
      suspended?: boolean;
      markPaid?: { plan: "PRO" | "BUSINESS"; periodDays: number };
    }
  ) {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      const updated: AdminUser = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated } : u)));
      toast.success("อัปเดตข้อมูลสำเร็จ");
    } catch {
      toast.error("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setActionLoading(null);
    }
  }

  // Convert a trial / bank-transfer customer to a real paid term (sets expiry + clears the
  // trial flag so they don't auto-revert to FREE). Use this for off-Stripe payments.
  function markPaid(user: AdminUser, plan: "PRO" | "BUSINESS", periodDays: number, label: string) {
    if (!confirm(`ยืนยัน: บันทึก ${user.email} เป็น ${plan} แบบ${label} (${periodDays} วัน)?\nระบบจะตั้งวันหมดอายุและล้างสถานะทดลองให้ — ใช้สำหรับลูกค้าที่โอนเงิน/จ่ายนอก Stripe`)) return;
    patchUser(user.id, { markPaid: { plan, periodDays } });
  }

  async function deleteUser(id: string) {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed");
      }
      setUsers((prev) => prev.filter((u) => u.id !== id));
      toast.success("ลบผู้ใช้งานสำเร็จ");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    } finally {
      setActionLoading(null);
      setDeleteConfirm(null);
    }
  }

  async function loadCacheInfo(userId: string) {
    setCacheLoading(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/cache`);
      if (!res.ok) throw new Error("Failed");
      const data: CacheInfo = await res.json();
      setCacheInfo(prev => ({ ...prev, [userId]: data }));
    } catch {
      toast.error("โหลดข้อมูลแคชไม่สำเร็จ");
    } finally {
      setCacheLoading(null);
    }
  }

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              Admin · Users
            </p>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
              จัดการผู้ใช้งาน
            </h1>
            <p className="text-sm mt-1" style={{ color: "var(--ui-text-secondary)" }}>ผู้ใช้งานทั้งหมด {users.length} ราย</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchUsers}
            disabled={loading}
            className="gap-2 text-zinc-400 hover:text-white"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="ค้นหาด้วยชื่อหรืออีเมล..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] py-2 pl-9 pr-4 text-sm placeholder-zinc-500 outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30"
            style={{ color: "var(--ui-text-primary)" }}
          />
        </div>

        {/* User Cards */}
        {loading ? null : filtered.length === 0 ? (
          <Card className="shadow-none" style={cardStyle}>
            <CardContent className="flex items-center justify-center py-12 text-zinc-500">
              ไม่พบผู้ใช้
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((user) => {
              const isActioning = actionLoading === user.id;
              return (
                <Card
                  key={user.id}
                  className="transition-colors shadow-none"
                  style={user.suspended
                    ? { background: "hsl(0 70% 50% / 0.05)", border: "1px solid hsl(0 70% 55% / 0.25)" }
                    : cardStyle}
                >
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start gap-3">
                      {/* Avatar */}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-sm font-bold text-violet-300">
                        {user.name.charAt(0).toUpperCase()}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <CardTitle className="text-sm" style={{ color: "var(--ui-text-primary)" }}>{user.name}</CardTitle>
                          {/* Plan badge */}
                          {(() => {
                            const ps = PLAN_STYLES[user.plan] ?? PLAN_STYLES.FREE;
                            const Icon = ps.icon;
                            return (
                              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${ps.bg} ${ps.text}`}>
                                {Icon && <Icon className="h-3 w-3" />}
                                {ps.label}
                              </span>
                            );
                          })()}
                          {/* Plan expiry countdown (PRO/BUSINESS) */}
                          {user.plan !== "FREE" && (() => {
                            const exp = planExpiryFrom(user);
                            if (!exp) return null;
                            const d = daysLeft(exp);
                            return (
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${d <= 3 ? "bg-red-500/15 text-red-400" : d <= 7 ? "bg-amber-500/15 text-amber-400" : ""}`}
                                style={d <= 7 ? undefined : { background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-muted)" }}
                              >
                                {d > 0 ? `หมดใน ${d} วัน` : "หมดอายุแล้ว"}
                              </span>
                            );
                          })()}
                          {/* Role badge */}
                          {user.role === "ADMIN" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
                              <ShieldCheck className="h-3 w-3" />
                              ADMIN
                            </span>
                          )}
                          {/* Suspended badge */}
                          {user.suspended && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                              <Ban className="h-3 w-3" />
                              ถูกระงับการใช้งาน
                            </span>
                          )}
                          {/* Open tickets badge */}
                          {user._count.supportTickets > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/20 px-2 py-0.5 text-xs font-medium text-orange-400">
                              <MessageSquareWarning className="h-3 w-3" />
                              {user._count.supportTickets} report
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs" style={{ color: "var(--ui-text-muted)" }}>{user.email}</p>
                        <p className="mt-0.5 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                          สมัครใช้งานเมื่อ{" "}
                          {new Date(user.createdAt).toLocaleDateString("th-TH", {
                            day: "2-digit",
                            month: "short",
                            year: "2-digit",
                          })}
                          {" · "}
                          {user._count.styles} styles · {user._count.contents} contents ·{" "}
                          {user._count.videos} videos · {user._count.images} images
                        </p>
                        {/* Coupon redemptions */}
                        {user.couponRedemptions?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {user.couponRedemptions.map((r, i) => (
                              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300">
                                <Ticket className="h-3 w-3" />
                                {r.coupon.code}
                                {r.coupon.durationDays === 0 ? " (ถาวร)" : ` (${r.coupon.durationDays}วัน)`}
                                {" · "}{new Date(r.redeemedAt).toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "2-digit" })}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Cache info row */}
                        {cacheInfo[user.id] && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                            <span className="flex items-center gap-1">
                              <HardDrive className="h-3 w-3 text-zinc-600" />
                              Stock: {cacheInfo[user.id].stocks.count} ไฟล์ ({cacheInfo[user.id].stocks.sizeMb} MB)
                            </span>
                            <span>Render: {cacheInfo[user.id].renders.count} ไฟล์ ({cacheInfo[user.id].renders.sizeMb} MB)</span>
                            <span className="text-violet-300/80">Media Retention · อ่านอย่างเดียว</span>
                            {cacheInfo[user.id].openTickets > 0 && (
                              <span className="text-orange-400">{cacheInfo[user.id].openTickets} ticket เปิดอยู่</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-wrap items-center gap-2">
                        {isActioning || cacheLoading === user.id ? (
                          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                        ) : (
                          <>
                            {/* Plan selector */}
                            {(() => {
                              const ps = PLAN_STYLES[user.plan] ?? PLAN_STYLES.FREE;
                              const Icon = ps.icon;
                              return (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      className={`h-7 inline-flex items-center gap-1.5 rounded-md border-[var(--ui-btn-border)] bg-[var(--ui-btn-bg)] px-2 text-xs font-medium outline-none focus:border-violet-500/50 hover:bg-[var(--ui-btn-bg-hover)] transition-colors cursor-pointer ${ps.text}`}
                                      title="เปลี่ยนแพ็กเกจ"
                                    >
                                      {Icon && <Icon className="h-3 w-3" />}
                                      {ps.label}
                                      <ChevronDown className="h-3 w-3 opacity-60" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    className="min-w-35 border"
                                    style={dropdownStyle}
                                  >
                                    {(["FREE", "PRO", "BUSINESS"] as PlanKey[]).map(opt => {
                                      const ops = PLAN_STYLES[opt];
                                      const Icon = ops.icon;
                                      const isSelected = opt === user.plan;
                                      return (
                                        <DropdownMenuItem
                                          key={opt}
                                          onClick={() => { if (!isSelected) patchUser(user.id, { plan: opt }); }}
                                          className={`gap-2 text-xs cursor-pointer ${ops.text} ${isSelected ? "bg-white/5" : ""} focus:bg-white/10`}
                                        >
                                          {Icon ? <Icon className="h-3 w-3" /> : <span className="h-3 w-3" />}
                                          <span className="flex-1">{ops.label}</span>
                                          {isSelected && <Check className="h-3 w-3 text-emerald-400" />}
                                        </DropdownMenuItem>
                                      );
                                    })}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              );
                            })()}

                            {/* Mark as paid (off-Stripe / bank transfer) — sets a real term + clears trial */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  className="h-7 inline-flex items-center gap-1.5 rounded-md border-[var(--ui-btn-border)] bg-[var(--ui-btn-bg)] px-2 text-xs font-medium text-violet-300 outline-none hover:bg-[var(--ui-btn-bg-hover)] transition-colors cursor-pointer"
                                  title="บันทึกการชำระเงิน (สำหรับลูกค้าโอนเงิน/นอก Stripe) — ตั้งวันหมดอายุและล้างสถานะทดลอง"
                                >
                                  <BadgeDollarSign className="h-3 w-3" style={{ color: VIOLET }} />
                                  บันทึกชำระ
                                  <ChevronDown className="h-3 w-3 opacity-60" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="min-w-44 border"
                                style={dropdownStyle}
                              >
                                {([
                                  { plan: "PRO", days: 365, label: "รายปี" },
                                  { plan: "PRO", days: 30, label: "รายเดือน" },
                                  { plan: "BUSINESS", days: 365, label: "รายปี" },
                                  { plan: "BUSINESS", days: 30, label: "รายเดือน" },
                                ] as const).map((o) => (
                                  <DropdownMenuItem
                                    key={`${o.plan}-${o.days}`}
                                    onClick={() => markPaid(user, o.plan, o.days, o.label)}
                                    className="gap-2 text-xs cursor-pointer text-white/80 focus:bg-white/10"
                                  >
                                    <BadgeDollarSign className="h-3 w-3" style={{ color: VIOLET }} />
                                    <span className="flex-1">{o.plan} · {o.label}</span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>

                            {/* Toggle Admin */}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => patchUser(user.id, { role: user.role === "ADMIN" ? "USER" : "ADMIN" })}
                              className={`h-7 gap-1 text-xs ${
                                user.role === "ADMIN"
                                  ? "text-red-400 hover:text-red-300"
                                  : "text-zinc-400 hover:text-red-400"
                              }`}
                            >
                              <ShieldCheck className="h-3 w-3" />
                              {user.role === "ADMIN" ? "→ User" : "→ Admin"}
                            </Button>

                            {/* Toggle Suspend */}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => patchUser(user.id, { suspended: !user.suspended })}
                              className={`h-7 gap-1 text-xs ${
                                user.suspended
                                  ? "text-green-400 hover:text-green-300"
                                  : "text-red-400 hover:text-red-300"
                              }`}
                            >
                              {user.suspended ? (
                                <>
                                  <CheckCircle2 className="h-3 w-3" />
                                  ปลดล็อกบัญชี
                                </>
                              ) : (
                                <>
                                  <UserX className="h-3 w-3" />
                                  ระงับบัญชี
                                </>
                              )}
                            </Button>

                            {/* Storage is read-only here; lifecycle mutations require reviewed graph/quarantine. */}
                            <Button size="sm" variant="ghost"
                              onClick={() => loadCacheInfo(user.id)}
                              className="h-7 gap-1 text-xs text-zinc-500 hover:text-violet-300"
                              title="ตรวจพื้นที่จัดเก็บแบบอ่านอย่างเดียว — การลบจัดการโดย Media Retention"
                            >
                              <HardDrive className="h-3 w-3" />
                              ตรวจพื้นที่
                            </Button>

                            {/* Delete */}
                            {deleteConfirm === user.id ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-red-400">ยืนยันการลบ?</span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => deleteUser(user.id)}
                                  className="h-7 text-xs text-red-400 hover:text-red-300"
                                >
                                  ลบบัญชี
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setDeleteConfirm(null)}
                                  className="h-7 text-xs text-zinc-400"
                                >
                                  ยกเลิก
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDeleteConfirm(user.id)}
                                className="h-7 gap-1 text-xs text-zinc-600 hover:text-red-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
