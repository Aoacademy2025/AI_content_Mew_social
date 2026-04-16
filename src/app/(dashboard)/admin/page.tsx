"use client";

import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Users, Crown, Ban, FileText, Video, Images, UserPlus, CalendarDays,
  ArrowRight, Loader2, Ticket, CheckCircle2, Clock, Send, ChevronDown, ChevronUp,
} from "lucide-react";
import Link from "next/link";

interface AdminStats {
  totalUsers: number; freeUsers: number; paidUsers: number; suspendedUsers: number;
  totalContents: number; totalVideos: number; totalImages: number; newToday: number; newThisWeek: number;
}

interface SupportTicket {
  id: string;
  message: string;
  imageName: string | null;
  imageBase64: string | null;
  status: "OPEN" | "CLOSED";
  adminReply: string | null;
  createdAt: string;
  user: { name: string; email: string; plan: string };
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [ticketFilter, setTicketFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setTicketsLoading(true);
    fetch(`/api/admin/support?status=${ticketFilter}`)
      .then(r => r.json())
      .then(d => setTickets(Array.isArray(d) ? d : []))
      .finally(() => setTicketsLoading(false));
  }, [ticketFilter]);

  async function handleReply(ticketId: string, close: boolean) {
    const reply = replyText[ticketId]?.trim();
    if (!reply && !close) return;
    setReplying(ticketId);
    try {
      const res = await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, reply: reply || undefined, status: close ? "CLOSED" : undefined }),
      });
      if (res.ok) {
        setTickets(prev => prev.map(t => t.id === ticketId
          ? { ...t, adminReply: reply || t.adminReply, status: close ? "CLOSED" : t.status }
          : t
        ));
        setReplyText(prev => ({ ...prev, [ticketId]: "" }));
        if (ticketFilter === "OPEN" && close) {
          setTickets(prev => prev.filter(t => t.id !== ticketId));
        }
      }
    } finally {
      setReplying(null);
    }
  }

  const statCards = [
    { title: "ผู้ใช้งานทั้งหมด",    value: stats?.totalUsers ?? 0,    sub: `+${stats?.newToday ?? 0} รายในวันนี้`,                        icon: Users,        color: "purple" },
    { title: "ผู้ใช้งาน Pro",         value: stats?.paidUsers ?? 0,    sub: `${stats?.freeUsers ?? 0} ผู้ใช้งานระดับ Free`,              icon: Crown,        color: "yellow" },
    { title: "ถูกระงับการใช้งาน",    value: stats?.suspendedUsers ?? 0, sub: "บัญชีที่ถูกระงับการเข้าถึง",                             icon: Ban,          color: "red"    },
    { title: "เนื้อหาทั้งหมด",       value: stats?.totalContents ?? 0,  sub: "รวมจากผู้ใช้งานทุกราย",                                  icon: FileText,     color: "blue"   },
    { title: "วิดีโอทั้งหมด",        value: stats?.totalVideos ?? 0,    sub: "รวมจากผู้ใช้งานทุกราย",                                  icon: Video,        color: "indigo" },
    { title: "รูปภาพทั้งหมด",        value: stats?.totalImages ?? 0,    sub: "รวมจากผู้ใช้งานทุกราย",                                  icon: Images,       color: "pink"   },
    { title: "สมัครใช้งานวันนี้",    value: stats?.newToday ?? 0,       sub: `${stats?.newThisWeek ?? 0} รายใน 7 วันที่ผ่านมา`,       icon: UserPlus,     color: "green"  },
    { title: "สมัครใช้งาน 7 วัน",   value: stats?.newThisWeek ?? 0,    sub: "ย้อนหลัง 1 สัปดาห์",                                    icon: CalendarDays, color: "cyan"   },
  ];

  const colorMap: Record<string, string> = {
    purple: "from-purple-500 to-pink-500", yellow: "from-yellow-500 to-orange-500",
    red: "from-red-500 to-rose-500",       blue: "from-blue-500 to-cyan-500",
    indigo: "from-indigo-500 to-purple-500", pink: "from-pink-500 to-rose-500",
    green: "from-green-500 to-emerald-500",  cyan: "from-cyan-500 to-blue-500",
  };

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-linear-to-br from-red-900/40 via-orange-900/20 to-yellow-900/30 p-8 backdrop-blur-xl">
          <div className="absolute right-0 top-0 h-40 w-40 animate-pulse rounded-full bg-red-500/20 blur-3xl" />
          <div className="relative z-10 flex items-start justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Users className="h-5 w-5 text-red-400" />
                <span className="text-sm font-medium text-red-400">Admin Panel</span>
              </div>
              <p className="text-zinc-300">จัดการระบบและผู้ใช้งานทั้งหมด</p>
            </div>
            <Link href="/admin/users">
              <Button className="gap-2 bg-white/10 text-white hover:bg-white/20">
                <Users className="h-4 w-4" />
                จัดการผู้ใช้งาน
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((card) => {
            const Icon = card.icon;
            return (
              <Card key={card.title} className="border-white/10 bg-white/5">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-zinc-400">{card.title}</CardTitle>
                  <div className={`rounded-lg bg-linear-to-br ${colorMap[card.color]} p-2`}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                </CardHeader>
                <CardContent>
                  {loading ? <Loader2 className="h-7 w-7 animate-spin text-zinc-600" /> : (
                    <div className="text-3xl font-bold text-white">{card.value}</div>
                  )}
                  <p className="mt-1 text-xs text-zinc-500">{card.sub}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Support Tickets */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Ticket className="h-5 w-5 text-cyan-400" />
              Support Tickets
              {tickets.length > 0 && ticketFilter === "OPEN" && (
                <span className="rounded-full bg-red-500/20 text-red-400 text-xs px-2 py-0.5 font-bold">{tickets.length}</span>
              )}
            </h2>
            {/* Filter tabs */}
            <div className="flex gap-1 rounded-lg p-1 bg-white/5 border border-white/10">
              {(["OPEN", "CLOSED", "ALL"] as const).map(f => (
                <button key={f} onClick={() => setTicketFilter(f)}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all ${ticketFilter === f ? "bg-white/15 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {f === "OPEN" ? "เปิด" : f === "CLOSED" ? "ปิดแล้ว" : "ทั้งหมด"}
                </button>
              ))}
            </div>
          </div>

          {ticketsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
            </div>
          ) : tickets.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 flex flex-col items-center justify-center py-12 gap-2">
              <CheckCircle2 className="h-8 w-8 text-green-400/40" />
              <p className="text-sm text-zinc-500">ไม่มี ticket ที่{ticketFilter === "OPEN" ? "รอดำเนินการ" : "ปิดแล้ว"}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tickets.map(ticket => {
                const expanded = expandedId === ticket.id;
                return (
                  <div key={ticket.id} className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
                    {/* Ticket header */}
                    <button className="w-full flex items-start gap-4 p-4 text-left hover:bg-white/5 transition-colors"
                      onClick={() => setExpandedId(expanded ? null : ticket.id)}>
                      <div className={`mt-0.5 shrink-0 h-2 w-2 rounded-full ${ticket.status === "OPEN" ? "bg-red-400" : "bg-green-400"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white truncate">{ticket.user.name}</span>
                          <span className="text-xs text-zinc-500">{ticket.user.email}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-400">{ticket.user.plan}</span>
                          <span className="text-[10px] text-zinc-600 ml-auto">
                            {new Date(ticket.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-400 mt-1 line-clamp-2">{ticket.message}</p>
                        {ticket.adminReply && (
                          <p className="text-xs text-cyan-400/70 mt-1 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" /> ตอบแล้ว
                          </p>
                        )}
                      </div>
                      {expanded ? <ChevronUp className="h-4 w-4 text-zinc-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />}
                    </button>

                    {/* Expanded detail */}
                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-white/10 pt-4">
                        {/* Message */}
                        <div className="rounded-xl bg-white/5 p-3">
                          <p className="text-xs text-zinc-500 mb-1 font-semibold uppercase tracking-wider">ปัญหา</p>
                          <p className="text-sm text-zinc-200 whitespace-pre-wrap">{ticket.message}</p>
                        </div>

                        {/* Image attachment */}
                        {ticket.imageBase64 && (
                          <div className="rounded-xl overflow-hidden border border-white/10">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`data:image/jpeg;base64,${ticket.imageBase64}`}
                              alt={ticket.imageName ?? "attachment"}
                              className="w-full max-h-64 object-contain bg-black/30"
                            />
                            {ticket.imageName && <p className="px-3 py-1 text-[10px] text-zinc-500">{ticket.imageName}</p>}
                          </div>
                        )}

                        {/* Existing reply */}
                        {ticket.adminReply && (
                          <div className="rounded-xl p-3" style={{ background: "hsl(190 100% 50% / 0.06)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
                            <p className="text-xs text-cyan-400/70 mb-1 font-semibold uppercase tracking-wider">คำตอบจากทีมงาน</p>
                            <p className="text-sm text-zinc-200 whitespace-pre-wrap">{ticket.adminReply}</p>
                          </div>
                        )}

                        {/* Reply box */}
                        {ticket.status === "OPEN" && (
                          <div className="space-y-2">
                            <textarea
                              value={replyText[ticket.id] ?? ""}
                              onChange={e => setReplyText(prev => ({ ...prev, [ticket.id]: e.target.value }))}
                              placeholder="พิมพ์คำตอบ..."
                              rows={3}
                              className="w-full rounded-xl px-3 py-2 text-sm text-white placeholder:text-zinc-600 resize-none outline-none"
                              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                            />
                            <div className="flex gap-2">
                              <button
                                disabled={!replyText[ticket.id]?.trim() || replying === ticket.id}
                                onClick={() => handleReply(ticket.id, false)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 transition-all"
                                style={{ background: "hsl(190 100% 50% / 0.15)", border: "1px solid hsl(190 100% 50% / 0.3)" }}>
                                {replying === ticket.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                                ส่งคำตอบ
                              </button>
                              <button
                                disabled={replying === ticket.id}
                                onClick={() => handleReply(ticket.id, true)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 disabled:opacity-40 transition-all hover:bg-white/5"
                                style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
                                <Clock className="h-3 w-3" />
                                {replyText[ticket.id]?.trim() ? "ส่งและปิด" : "ปิด ticket"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Quick Links */}
        <div>
          <h2 className="mb-4 text-lg font-bold text-white">Quick Actions</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Link href="/admin/users">
              <Card className="group border-white/10 bg-white/5 transition-all hover:border-purple-500/40 hover:bg-white/10">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="rounded-lg bg-purple-500/20 p-2.5 ring-1 ring-purple-500/30">
                      <Users className="h-4 w-4 text-purple-400" />
                    </div>
                    <ArrowRight className="h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-1 group-hover:text-zinc-400" />
                  </div>
                  <CardTitle className="mt-2 text-sm text-white">จัดการผู้ใช้งาน</CardTitle>
                  <p className="text-xs text-zinc-500">ดูข้อมูล แก้ไขแผน ระงับ/ปลดล็อกบัญชี และลบผู้ใช้งาน</p>
                </CardHeader>
              </Card>
            </Link>
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="rounded-lg bg-yellow-500/20 p-2.5 ring-1 ring-yellow-500/30">
                    <Crown className="h-4 w-4 text-yellow-400" />
                  </div>
                </div>
                <CardTitle className="mt-2 text-sm text-white">สถิติแผนการใช้งาน</CardTitle>
                <p className="text-xs text-zinc-500">
                  {loading ? "..." : `${stats?.paidUsers ?? 0} Pro · ${stats?.freeUsers ?? 0} Free`}
                </p>
              </CardHeader>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
