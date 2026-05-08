"use client";

import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Crown,
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
} from "lucide-react";
import { toast } from "sonner";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "USER";
  plan: "FREE" | "PRO";
  suspended: boolean;
  createdAt: string;
  _count: { styles: number; contents: number; videos: number; images: number; supportTickets: number };
}

interface CacheInfo {
  stocks: { count: number; sizeMb: number };
  renders: { count: number; sizeMb: number; protected: number };
  openTickets: number;
}

type ActionLoading = string | null;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<ActionLoading>(null);
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<Record<string, CacheInfo>>({});
  const [cacheLoading, setCacheLoading] = useState<string | null>(null);
  const [clearConfirm, setClearConfirm] = useState<string | null>(null);

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

  async function patchUser(id: string, data: Partial<Pick<AdminUser, "plan" | "role" | "suspended">>) {
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

  async function clearCache(userId: string, includeRenders: boolean) {
    setCacheLoading(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/cache`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeRenders }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast.success(data.message);
      // Reload cache info
      const res2 = await fetch(`/api/admin/users/${userId}/cache`);
      if (res2.ok) setCacheInfo(prev => ({ ...prev, [userId]: await res2.json() }));
    } catch {
      toast.error("เคลียร์แคชไม่สำเร็จ");
    } finally {
      setCacheLoading(null);
      setClearConfirm(null);
    }
  }

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">จัดการผู้ใช้งาน</h1>
            <p className="text-sm text-zinc-400">ผู้ใช้งานทั้งหมด {users.length} ราย</p>
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
            className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-4 text-sm text-white placeholder-zinc-500 outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30"
          />
        </div>

        {/* User Cards */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-zinc-600" />
          </div>
        ) : filtered.length === 0 ? (
          <Card className="border-white/10 bg-white/5">
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
                  className={`border-white/10 bg-white/5 transition-colors ${
                    user.suspended ? "border-red-500/20 bg-red-500/5" : ""
                  }`}
                >
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start gap-3">
                      {/* Avatar */}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-sm font-bold text-purple-300">
                        {user.name.charAt(0).toUpperCase()}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <CardTitle className="text-sm text-white">{user.name}</CardTitle>
                          {/* Plan badge */}
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            user.plan === "PRO"
                              ? "bg-yellow-500/15 text-yellow-400"
                              : "bg-zinc-500/15 text-zinc-400"
                          }`}>
                            {user.plan === "PRO" && <Crown className="h-3 w-3" />}
                            {user.plan}
                          </span>
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
                        <p className="mt-0.5 text-xs text-zinc-500">{user.email}</p>
                        <p className="mt-0.5 text-xs text-zinc-600">
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
                        {/* Cache info row */}
                        {cacheInfo[user.id] && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                            <span className="flex items-center gap-1">
                              <HardDrive className="h-3 w-3 text-zinc-600" />
                              Stock: {cacheInfo[user.id].stocks.count} ไฟล์ ({cacheInfo[user.id].stocks.sizeMb} MB)
                            </span>
                            <span>Render: {cacheInfo[user.id].renders.count} ไฟล์ ({cacheInfo[user.id].renders.sizeMb} MB)</span>
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
                            {/* Toggle Plan */}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => patchUser(user.id, { plan: user.plan === "PRO" ? "FREE" : "PRO" })}
                              className={`h-7 gap-1 text-xs ${
                                user.plan === "PRO"
                                  ? "text-yellow-400 hover:text-yellow-300"
                                  : "text-zinc-400 hover:text-yellow-400"
                              }`}
                            >
                              <Crown className="h-3 w-3" />
                              {user.plan === "PRO" ? "→ Free" : "→ Pro"}
                            </Button>

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

                            {/* Cache */}
                            {clearConfirm === user.id ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-orange-400">เคลียร์ stock เท่านั้น?</span>
                                <Button size="sm" variant="ghost" onClick={() => clearCache(user.id, false)}
                                  className="h-7 text-xs text-orange-400 hover:text-orange-300">Stock</Button>
                                <Button size="sm" variant="ghost" onClick={() => clearCache(user.id, true)}
                                  className="h-7 text-xs text-red-400 hover:text-red-300">Stock+Render</Button>
                                <Button size="sm" variant="ghost" onClick={() => setClearConfirm(null)}
                                  className="h-7 text-xs text-zinc-400">ยกเลิก</Button>
                              </div>
                            ) : (
                              <Button size="sm" variant="ghost"
                                onClick={() => { loadCacheInfo(user.id); setClearConfirm(user.id); }}
                                className="h-7 gap-1 text-xs text-zinc-500 hover:text-orange-400"
                                title="เช็คและเคลียร์แคช"
                              >
                                <HardDrive className="h-3 w-3" />
                                แคช
                              </Button>
                            )}

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
    </DashboardLayout>
  );
}
