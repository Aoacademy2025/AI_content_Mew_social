"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCheck,
  Trash2,
  Video,
  AlertTriangle,
  TrendingUp,
  UserPlus,
  ShieldAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Notification {
  id: string;
  type: "VIDEO_COMPLETED" | "VIDEO_FAILED" | "LIMIT_WARNING" | "LIMIT_REACHED" | "NEW_USER" | "ERROR_SYSTEM";
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

function typeIcon(type: Notification["type"]) {
  switch (type) {
    case "VIDEO_COMPLETED": return <Video className="h-4 w-4 text-cyan-400" />;
    case "VIDEO_FAILED":    return <AlertTriangle className="h-4 w-4 text-red-400" />;
    case "LIMIT_WARNING":   return <TrendingUp className="h-4 w-4 text-amber-400" />;
    case "LIMIT_REACHED":   return <AlertTriangle className="h-4 w-4 text-orange-400" />;
    case "NEW_USER":        return <UserPlus className="h-4 w-4 text-purple-400" />;
    case "ERROR_SYSTEM":    return <ShieldAlert className="h-4 w-4 text-red-500" />;
  }
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อกี้";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const unread = notifications.filter((n) => !n.read).length;

  // Fetch on mount + every 30s
  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, 30000);
    return () => clearInterval(id);
  }, []);

  // Close panel on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function fetchNotifications() {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) setNotifications(await res.json());
    } catch {
      // network error or dev server not ready — fail silently
    } finally {
      setLoading(false);
    }
  }

  async function markAllRead() {
    await fetch("/api/notifications", { method: "PATCH" });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function clearAll() {
    await fetch("/api/notifications", { method: "DELETE" });
    setNotifications([]);
  }

  async function dismissOne(id: string) {
    await fetch(`/api/notifications/${id}`, { method: "DELETE" });
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  async function markOneRead(id: string) {
    await fetch(`/api/notifications/${id}`, { method: "PATCH" });
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => { setOpen((v) => !v); if (!open) fetchNotifications(); }}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors hover:bg-white/10"
        style={{ color: "var(--ui-sidebar-text)" }}
        aria-label="การแจ้งเตือน"
      >
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-cyan-500 text-[9px] font-bold text-white leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-2xl shadow-2xl overflow-hidden"
          style={{ background: "hsl(222 25% 14%)", border: "1px solid hsl(220 20% 22%)" }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "hsl(220 20% 22%)" }}>
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-white">การแจ้งเตือน</span>
              {unread > 0 && (
                <span className="flex h-5 items-center rounded-full bg-cyan-500/20 px-1.5 text-[10px] font-bold text-cyan-400">
                  {unread} ใหม่
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <button onClick={markAllRead} title="อ่านทั้งหมด"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors">
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
              )}
              {notifications.length > 0 && (
                <button onClick={clearAll} title="ลบทั้งหมด"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="max-h-96 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-zinc-500 text-sm">
                กำลังโหลด...
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Bell className="h-8 w-8 text-zinc-700" />
                <p className="text-sm text-zinc-500">ไม่มีการแจ้งเตือน</p>
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => markOneRead(n.id)}
                  className={cn(
                    "group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-white/5",
                    !n.read && "bg-cyan-500/5"
                  )}
                  style={{ borderBottom: "1px solid hsl(220 20% 18%)" }}
                >
                  {/* Icon */}
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: "hsl(220 20% 18%)" }}>
                    {typeIcon(n.type)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-xs font-semibold", n.read ? "text-zinc-300" : "text-white")}>
                      {n.title}
                    </p>
                    {n.type === "ERROR_SYSTEM" ? (
                      <pre className="mt-0.5 text-[10px] text-red-400/80 leading-relaxed whitespace-pre-wrap break-all line-clamp-4 font-mono">
                        {n.body}
                      </pre>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-zinc-400 leading-relaxed line-clamp-2">
                        {n.body}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] text-zinc-600">{timeAgo(n.createdAt)}</p>
                  </div>

                  {/* Unread dot + dismiss */}
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {!n.read && (
                      <span className="h-2 w-2 rounded-full bg-cyan-400" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); dismissOne(n.id); }}
                      className="hidden group-hover:flex h-5 w-5 items-center justify-center rounded text-zinc-600 hover:text-zinc-300 transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
