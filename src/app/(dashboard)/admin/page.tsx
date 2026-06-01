"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Users, Crown, Ban, FileText, Video, Images, UserPlus, CalendarDays,
  ArrowRight, Loader2, Ticket, CheckCircle2, Clock, Send, ChevronDown, ChevronUp,
  Trash2, HardDrive, ShieldCheck, AlertTriangle, Music, Upload, X,
  CreditCard, Key, Eye, EyeOff, Tag, Plus, GripVertical, Zap, Building2,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface AdminStats {
  totalUsers: number; freeUsers: number; paidUsers: number; suspendedUsers: number;
  totalContents: number; totalVideos: number; totalImages: number; newToday: number; newThisWeek: number;
}

interface CleanupInfo {
  renders: {
    total: { count: number; sizeMb: number };
    older1d: { count: number; sizeMb: number };
    older3d: { count: number; sizeMb: number };
    older7d: { count: number; sizeMb: number };
  };
  stocks: { older1d: { count: number; sizeMb: number } };
  tmp: { sizeMb: number; count: number };
  protectedCount: number;
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

// ── PlanEditor: visual feature list editor ────────────────────────────────
function PlanEditor({
  label, accent, icon, price, onPriceChange, features, onFeaturesChange,
}: {
  label: string;
  accent: "cyan" | "violet" | "zinc";
  icon: React.ReactNode;
  price: string;
  onPriceChange: (v: string) => void;
  features: string;
  onFeaturesChange: (v: string) => void;
}) {
  const items = features.split("|").map(f => f.trim()).filter(Boolean);
  const [newFeature, setNewFeature] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");

  const palette = {
    cyan:   { border: "border-cyan-500/25",   bg: "bg-cyan-500/5",   focus: "focus:border-cyan-500/60",   text: "text-cyan-400",   check: "#22d3ee", iconBg: "bg-cyan-500/15",   addBg: "hsl(190 100% 50% / 0.12)", addBorder: "hsl(190 100% 50% / 0.3)" },
    violet: { border: "border-violet-500/25", bg: "bg-violet-500/5", focus: "focus:border-violet-500/60", text: "text-violet-400", check: "#a78bfa", iconBg: "bg-violet-500/15", addBg: "hsl(252 83% 57% / 0.12)",  addBorder: "hsl(252 83% 57% / 0.3)" },
    zinc:   { border: "border-zinc-500/20",   bg: "bg-zinc-500/5",   focus: "focus:border-zinc-400/60",   text: "text-zinc-300",   check: "#a1a1aa", iconBg: "bg-zinc-500/15",   addBg: "hsl(0 0% 60% / 0.10)",     addBorder: "hsl(0 0% 60% / 0.25)" },
  }[accent];

  const borderColor = palette.border;
  const bgColor = palette.bg;
  const focusBorder = palette.focus;
  const accentText = palette.text;
  const checkColor = palette.check;
  const addBg = palette.addBg;
  const addBorder = palette.addBorder;
  const iconBg = palette.iconBg;

  function setItems(next: string[]) {
    onFeaturesChange(next.join("|"));
  }

  function removeItem(i: number) {
    setItems(items.filter((_, idx) => idx !== i));
  }

  function addItem() {
    const v = newFeature.trim();
    if (!v) return;
    setItems([...items, v]);
    setNewFeature("");
  }

  function startEdit(i: number) {
    setEditIdx(i);
    setEditVal(items[i]);
  }

  function commitEdit() {
    if (editIdx === null) return;
    const next = [...items];
    next[editIdx] = editVal.trim();
    setItems(next.filter(Boolean));
    setEditIdx(null);
  }

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} p-4 space-y-4`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${iconBg}`}>
          {icon}
        </div>
        <span className={`text-sm font-semibold ${accentText}`}>{label} Plan</span>
        {accent === "cyan" && <span className="ml-auto text-xs text-zinc-500">แนะนำ</span>}
        {accent === "zinc" && <span className="ml-auto text-xs text-zinc-500">เริ่มต้น</span>}
      </div>

      {/* Price */}
      <div className="flex items-center gap-2">
        <span className="text-2xl font-bold text-white">฿</span>
        <input
          type="number"
          value={price}
          onChange={e => onPriceChange(e.target.value)}
          className={`w-28 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xl font-bold text-white outline-none ${focusBorder}`}
        />
        <span className="text-sm text-zinc-500">/เดือน</span>
      </div>

      {/* Feature list */}
      <div className="space-y-1.5">
        {items.map((f, i) => (
          <div key={i} className="group flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: checkColor }} />
            {editIdx === i ? (
              <input
                autoFocus
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditIdx(null); }}
                className={`flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-xs text-white outline-none ${focusBorder}`}
              />
            ) : (
              <span
                onClick={() => startEdit(i)}
                className="flex-1 cursor-text text-sm text-zinc-200 hover:text-white transition-colors"
              >
                {f}
              </span>
            )}
            <button
              onClick={() => removeItem(i)}
              className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-red-500/20 text-zinc-500 hover:text-red-400"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Add feature */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newFeature}
          onChange={e => setNewFeature(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addItem()}
          placeholder="เพิ่ม feature..."
          className={`flex-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-white placeholder-zinc-600 outline-none ${focusBorder}`}
        />
        <button
          onClick={addItem}
          disabled={!newFeature.trim()}
          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-30"
          style={{ background: addBg, border: `1px solid ${addBorder}`, color: checkColor }}
        >
          <Plus className="h-3.5 w-3.5" /> เพิ่ม
        </button>
      </div>
    </div>
  );
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

  // Settings state
  const [supportEmail, setSupportEmail] = useState("");
  const [supportEmailInput, setSupportEmailInput] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);

  // Stripe settings
  const [stripePublishableKey, setStripePublishableKey] = useState("");
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState("");
  const [stripePricePro, setStripePricePro] = useState("");
  const [stripePriceBusiness, setStripePriceBusiness] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [savingStripe, setSavingStripe] = useState(false);

  // Plan config
  const [planFreePrice, setPlanFreePrice] = useState("0");
  const [planFreeFeatures, setPlanFreeFeatures] = useState("2 คลิป/เดือน|ความยาววิดีโอสูงสุด 2 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 3 วัน|สร้างคอนเทนต์ด้วย AI (จำกัด 5 ชิ้น)|ใช้ Gemini API key ของตัวเอง|Font พื้นฐานเท่านั้น");
  const [planProPrice, setPlanProPrice] = useState("599");
  const [planProFeatures, setPlanProFeatures] = useState("100 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 6 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 7 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Support ทาง Email — ทีมงานตอบสนองภายใน 48 ชั่วโมง");
  const [planBusinessPrice, setPlanBusinessPrice] = useState("990");
  const [planBusinessFeatures, setPlanBusinessFeatures] = useState("300 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 10 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 14 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Priority Support — ทีมงานตอบสนองภายใน 24 ชั่วโมง|เหมาะสำหรับทีมงานและองค์กรธุรกิจ");
  const [savingPlans, setSavingPlans] = useState(false);

  async function loadSettings() {
    try {
      const res = await fetch("/api/admin/settings");
      const d = await res.json();
      if (d.support_email) { setSupportEmail(d.support_email); setSupportEmailInput(d.support_email); }
      if (d.stripe_publishable_key) setStripePublishableKey(d.stripe_publishable_key);
      if (d.stripe_secret_key) setStripeSecretKey(d.stripe_secret_key);
      if (d.stripe_webhook_secret) setStripeWebhookSecret(d.stripe_webhook_secret);
      if (d.stripe_price_pro) setStripePricePro(d.stripe_price_pro);
      if (d.stripe_price_business) setStripePriceBusiness(d.stripe_price_business);
      if (d.plan_free_price) setPlanFreePrice(d.plan_free_price);
      if (d.plan_free_features) setPlanFreeFeatures(d.plan_free_features);
      if (d.plan_pro_price) setPlanProPrice(d.plan_pro_price);
      if (d.plan_pro_features) setPlanProFeatures(d.plan_pro_features);
      if (d.plan_business_price) setPlanBusinessPrice(d.plan_business_price);
      if (d.plan_business_features) setPlanBusinessFeatures(d.plan_business_features);
    } catch {}
  }

  async function saveSupportEmail() {
    if (!supportEmailInput.trim()) return;
    setSavingEmail(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ support_email: supportEmailInput.trim() }),
      });
      if (res.ok) { setSupportEmail(supportEmailInput.trim()); toast.success("บันทึก Support Email แล้ว"); }
      else toast.error("บันทึกไม่สำเร็จ");
    } catch { toast.error("เกิดข้อผิดพลาด"); }
    finally { setSavingEmail(false); }
  }

  async function saveStripeSettings() {
    setSavingStripe(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stripe_publishable_key: stripePublishableKey.trim(),
          stripe_secret_key: stripeSecretKey.trim(),
          stripe_webhook_secret: stripeWebhookSecret.trim(),
          stripe_price_pro: stripePricePro.trim(),
          stripe_price_business: stripePriceBusiness.trim(),
        }),
      });
      if (res.ok) toast.success("บันทึก Stripe Settings แล้ว");
      else toast.error("บันทึกไม่สำเร็จ");
    } catch { toast.error("เกิดข้อผิดพลาด"); }
    finally { setSavingStripe(false); }
  }

  async function savePlanSettings() {
    setSavingPlans(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_free_price: planFreePrice,
          plan_free_features: planFreeFeatures,
          plan_pro_price: planProPrice,
          plan_pro_features: planProFeatures,
          plan_business_price: planBusinessPrice,
          plan_business_features: planBusinessFeatures,
        }),
      });
      if (res.ok) toast.success("บันทึก Plan Settings แล้ว");
      else toast.error("บันทึกไม่สำเร็จ");
    } catch { toast.error("เกิดข้อผิดพลาด"); }
    finally { setSavingPlans(false); }
  }

  // Music library
  interface MusicTrack { id: string; title: string; filename: string; duration: number | null; createdAt: string; }
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicUploading, setMusicUploading] = useState(false);
  const [newMusicTitle, setNewMusicTitle] = useState("");

  async function loadTracks() {
    setMusicLoading(true);
    try {
      const res = await fetch("/api/admin/music");
      const data = await res.json();
      if (data.tracks) setTracks(data.tracks);
    } catch { /* silent — Music table may not exist yet on this environment */ }
    finally { setMusicLoading(false); }
  }

  async function uploadTrack(file: File) {
    const fallbackTitle = file.name.replace(/\.[^.]+$/, "");
    const title = newMusicTitle.trim() || fallbackTitle;
    setMusicUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      const res = await fetch("/api/admin/music", { method: "POST", body: fd });
      const data = await res.json();
      if (data.track) { setTracks(prev => [data.track, ...prev]); setNewMusicTitle(""); toast.success("อัปโหลดเพลงสำเร็จ"); }
      else toast.error(data.error ?? "อัปโหลดไม่สำเร็จ");
    } catch { toast.error("อัปโหลดไม่สำเร็จ"); }
    finally { setMusicUploading(false); }
  }

  async function deleteTrack(id: string) {
    if (!confirm("ลบเพลงนี้?")) return;
    try {
      await fetch(`/api/admin/music/${id}`, { method: "DELETE" });
      setTracks(prev => prev.filter(t => t.id !== id));
      toast.success("ลบเพลงแล้ว");
    } catch { toast.error("ลบไม่สำเร็จ"); }
  }

  // Disk cleanup
  const [cleanupInfo, setCleanupInfo] = useState<CleanupInfo | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanDays, setCleanDays] = useState(3);
  const [includeStocks, setIncludeStocks] = useState(false);
  const [includeTmp, setIncludeTmp] = useState(false);
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);

  function loadCleanupInfo() {
    setCleanupLoading(true);
    fetch("/api/admin/cleanup")
      .then(r => r.json())
      .then(d => setCleanupInfo(d))
      .catch(() => {})
      .finally(() => setCleanupLoading(false));
  }

  async function runCleanup() {
    setCleaning(true);
    setShowCleanConfirm(false);
    try {
      const res = await fetch("/api/admin/cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ olderThanDays: cleanDays, includeStocks, includeTmp }),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(d.message);
        loadCleanupInfo();
      } else {
        toast.error(d.error ?? "ลบไม่สำเร็จ");
      }
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    fetch("/api/admin/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
    loadCleanupInfo();
    loadTracks();
    loadSettings();
  }, []);

  // Fetch tickets — `silent` skips the loading spinner so background polling
  // doesn't make the list flicker. Latest data always wins (DB is the source
  // of truth), so tickets created via the web/n8n flow appear automatically.
  const fetchTickets = useCallback(async (silent = false) => {
    if (!silent) setTicketsLoading(true);
    try {
      const r = await fetch(`/api/admin/support?status=${ticketFilter}`, { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d)) setTickets(d);
    } catch { /* keep current list on transient errors */ }
    finally { if (!silent) setTicketsLoading(false); }
  }, [ticketFilter]);

  // Initial load + re-load when the filter changes
  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // Real-time-ish: poll every 15s while the tab is visible (pauses in background)
  useEffect(() => {
    const POLL_MS = 15_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => fetchTickets(true), POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { fetchTickets(true); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchTickets]);

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
    <>
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
                  {loading ? <div className="dash-skeleton h-9 w-24 rounded-lg" /> : (
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
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="dash-skeleton h-16 rounded-xl" />
              ))}
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

        {/* Disk Cleanup */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-orange-400" />
              จัดการพื้นที่ดิสก์
            </h2>
            <button onClick={loadCleanupInfo} disabled={cleanupLoading}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1">
              {cleanupLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 -rotate-90" />}
              รีเฟรช
            </button>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 space-y-5">
            {/* Stats row */}
            {/* /renders stats */}
            <div>
              <p className="text-xs text-zinc-500 mb-2 font-semibold uppercase tracking-wider">/renders (วิดีโอ render)</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "ทั้งหมด", val: cleanupInfo?.renders.total, color: "zinc" },
                  { label: "เกิน 1 วัน", val: cleanupInfo?.renders.older1d, color: "yellow" },
                  { label: "เกิน 3 วัน", val: cleanupInfo?.renders.older3d, color: "orange" },
                  { label: "เกิน 7 วัน", val: cleanupInfo?.renders.older7d, color: "red" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
                    <p className="text-xs text-zinc-500 mb-1">{label}</p>
                    {cleanupLoading ? (
                      <div className="dash-skeleton h-5 w-12 rounded mx-auto" />
                    ) : (
                      <>
                        <p className={`text-xl font-bold ${color === "red" ? "text-red-400" : color === "orange" ? "text-orange-400" : color === "yellow" ? "text-yellow-400" : "text-zinc-300"}`}>
                          {val?.sizeMb ?? 0} MB
                        </p>
                        <p className="text-[10px] text-zinc-600">{val?.count ?? 0} ไฟล์</p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* /tmp stats */}
            <div>
              <p className="text-xs text-zinc-500 mb-2 font-semibold uppercase tracking-wider">/tmp (Remotion temp files)</p>
              <div className="rounded-xl bg-white/5 border border-white/10 p-3 flex items-center gap-4">
                {cleanupLoading ? (
                  <div className="dash-skeleton h-6 w-full rounded" />
                ) : (
                  <>
                    <div>
                      <p className={`text-2xl font-bold ${(cleanupInfo?.tmp.sizeMb ?? 0) > 1000 ? "text-red-400" : (cleanupInfo?.tmp.sizeMb ?? 0) > 500 ? "text-orange-400" : "text-zinc-300"}`}>
                        {cleanupInfo?.tmp.sizeMb ?? 0} MB
                      </p>
                      <p className="text-[10px] text-zinc-600">{cleanupInfo?.tmp.count ?? 0} temp folders</p>
                    </div>
                    <p className="text-xs text-zinc-500 flex-1">
                      remotion-webpack-bundle, react-motion-render, puppeteer_dev_chrome_profile
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Gallery protection notice */}
            <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: "hsl(140 60% 50% / 0.06)", border: "1px solid hsl(140 60% 50% / 0.2)" }}>
              <ShieldCheck className="h-4 w-4 text-green-400 shrink-0" />
              <span className="text-green-400/80">
                ไฟล์ที่บันทึกใน Gallery จะ<strong className="text-green-400"> ไม่ถูกลบ</strong> เด็ดขาด
                {cleanupInfo && ` (ปกป้องอยู่ ${cleanupInfo.protectedCount} ไฟล์)`}
              </span>
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">ลบไฟล์เกิน</span>
                <div className="flex gap-1">
                  {[1, 3, 7].map(d => (
                    <button key={d} onClick={() => setCleanDays(d)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${cleanDays === d ? "bg-orange-500/30 text-orange-300 border border-orange-500/40" : "bg-white/5 text-zinc-500 border border-white/10 hover:text-zinc-300"}`}>
                      {d} วัน
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={includeStocks} onChange={e => setIncludeStocks(e.target.checked)}
                  className="accent-orange-500 h-3.5 w-3.5" />
                <span className="text-xs text-zinc-400">รวม /stocks (stock video cache)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={includeTmp} onChange={e => setIncludeTmp(e.target.checked)}
                  className="accent-red-500 h-3.5 w-3.5" />
                <span className="text-xs text-zinc-400">
                  รวม /tmp Remotion temp
                  {cleanupInfo?.tmp.sizeMb ? <span className="text-red-400 font-semibold ml-1">({cleanupInfo.tmp.sizeMb} MB)</span> : ""}
                </span>
              </label>
            </div>

            {/* Confirm / Delete button */}
            {!showCleanConfirm ? (
              <button onClick={() => setShowCleanConfirm(true)} disabled={cleaning || cleanupLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40"
                style={{ background: "hsl(14 90% 50% / 0.2)", border: "1px solid hsl(14 90% 50% / 0.4)" }}>
                <Trash2 className="h-4 w-4" />
                ลบไฟล์เก่าที่ไม่ใช้
              </button>
            ) : (
              <div className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{ background: "hsl(14 90% 50% / 0.1)", border: "1px solid hsl(14 90% 50% / 0.3)" }}>
                <AlertTriangle className="h-4 w-4 text-orange-400 shrink-0" />
                <p className="text-xs text-orange-300 flex-1">
                  ยืนยันลบไฟล์ใน /renders ที่เก่ากว่า {cleanDays} วัน
                  {includeStocks ? " + /stocks" : ""} ?
                </p>
                <button onClick={runCleanup} disabled={cleaning}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500/80 hover:bg-red-500 transition-all flex items-center gap-1.5">
                  {cleaning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  ยืนยัน
                </button>
                <button onClick={() => setShowCleanConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                  ยกเลิก
                </button>
              </div>
            )}
          </div>
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

        {/* ── Music Library ─────────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Music className="h-4 w-4 text-purple-400" />
            <h2 className="text-sm font-semibold text-white">Music Library</h2>
            <span className="ml-auto text-xs text-zinc-500">{tracks.length} เพลง</span>
          </div>

          {/* Upload form */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="ชื่อเพลง"
              value={newMusicTitle}
              onChange={e => setNewMusicTitle(e.target.value)}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
            />
            <label className={`flex cursor-pointer items-center gap-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-sm font-medium text-purple-300 transition hover:bg-purple-500/20 ${musicUploading ? "opacity-50 pointer-events-none" : ""}`}>
              {musicUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {musicUploading ? "กำลังอัปโหลด..." : "อัปโหลดเพลง"}
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadTrack(f); e.target.value = ""; }} />
            </label>
          </div>

          {/* Track list */}
          {musicLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="dash-skeleton h-12 rounded-lg" />
              ))}
            </div>
          ) : tracks.length === 0 ? (
            <p className="text-sm text-zinc-500">ยังไม่มีเพลง — อัปโหลดเพลงแรก</p>
          ) : (
            <div className="space-y-2">
              {tracks.map(t => (
                <div key={t.id} className="rounded-lg border border-white/8 bg-white/3 px-3 py-2 space-y-1.5">
                  <div className="flex items-center gap-3">
                    <Music className="h-3.5 w-3.5 shrink-0 text-purple-400/60" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{t.title}</p>
                      <p className="truncate text-[10px] text-zinc-500">{t.filename}</p>
                    </div>
                    <button onClick={() => deleteTrack(t.id)}
                      className="rounded p-1 text-zinc-500 transition hover:bg-red-500/15 hover:text-red-400">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <audio controls src={`/music/${t.filename}`} className="h-8 w-full opacity-80" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Stripe Payment Settings ─────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-white">Stripe Payment</h2>
            </div>
            <button onClick={() => setShowSecrets(s => !s)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              {showSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showSecrets ? "ซ่อน" : "แสดง"} keys
            </button>
          </div>

          <div className="grid gap-3">
            {/* Publishable Key */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Publishable Key <span className="text-zinc-600">(pk_live_... / pk_test_...)</span></label>
              <input type={showSecrets ? "text" : "password"} value={stripePublishableKey}
                onChange={e => setStripePublishableKey(e.target.value)}
                placeholder="pk_live_xxxx"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Secret Key */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Secret Key <span className="text-zinc-600">(sk_live_... / sk_test_...)</span></label>
              <input type={showSecrets ? "text" : "password"} value={stripeSecretKey}
                onChange={e => setStripeSecretKey(e.target.value)}
                placeholder="sk_live_xxxx"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Webhook Secret */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Webhook Secret <span className="text-zinc-600">(whsec_...)</span></label>
              <input type={showSecrets ? "text" : "password"} value={stripeWebhookSecret}
                onChange={e => setStripeWebhookSecret(e.target.value)}
                placeholder="whsec_xxxx"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Price IDs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Price ID — Pro</label>
                <input type="text" value={stripePricePro}
                  onChange={e => setStripePricePro(e.target.value)}
                  placeholder="price_xxxx"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Price ID — Business</label>
                <input type="text" value={stripePriceBusiness}
                  onChange={e => setStripePriceBusiness(e.target.value)}
                  placeholder="price_xxxx"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={saveStripeSettings} disabled={savingStripe}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, hsl(252 83% 50%), hsl(280 80% 50%))" }}>
              {savingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              บันทึก Stripe
            </button>
          </div>
        </div>

        {/* ── Plan Config ──────────────────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Plan Configuration</h2>
          </div>

          <div className="grid gap-4 lg:grid-cols-3 sm:grid-cols-2">
            {/* ── Free Plan Card ── */}
            <PlanEditor
              label="Free"
              accent="zinc"
              icon={<Zap className="h-4 w-4 text-zinc-400" />}
              price={planFreePrice}
              onPriceChange={setPlanFreePrice}
              features={planFreeFeatures}
              onFeaturesChange={setPlanFreeFeatures}
            />
            {/* ── Pro Plan Card ── */}
            <PlanEditor
              label="Pro"
              accent="cyan"
              icon={<Crown className="h-4 w-4 text-cyan-400" />}
              price={planProPrice}
              onPriceChange={setPlanProPrice}
              features={planProFeatures}
              onFeaturesChange={setPlanProFeatures}
            />
            {/* ── Business Plan Card ── */}
            <PlanEditor
              label="Business"
              accent="violet"
              icon={<Building2 className="h-4 w-4 text-violet-400" />}
              price={planBusinessPrice}
              onPriceChange={setPlanBusinessPrice}
              features={planBusinessFeatures}
              onFeaturesChange={setPlanBusinessFeatures}
            />
          </div>

          <div className="flex justify-end">
            <button onClick={savePlanSettings} disabled={savingPlans}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, hsl(190 100% 40%), hsl(220 100% 50%))" }}>
              {savingPlans ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              บันทึก Plans
            </button>
          </div>
        </div>

        {/* ── Support Email Settings ───────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Send className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Support Email</h2>
          </div>
          <p className="text-xs text-zinc-500">
            อีเมลที่รับแจ้ง support ticket ใหม่ — ใส่หลายอีเมลได้ คั่นด้วย comma เช่น <span className="font-mono text-zinc-400">a@mail.com, b@mail.com</span>
          </p>
          <div className="flex flex-col gap-2">
            <textarea
              rows={3}
              value={supportEmailInput}
              onChange={e => setSupportEmailInput(e.target.value)}
              placeholder={"admin@example.com, support@example.com"}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 resize-none font-mono"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-600">
                {supportEmailInput.split(",").map(e => e.trim()).filter(Boolean).length} อีเมล
              </span>
              <button
                onClick={saveSupportEmail}
                disabled={savingEmail || !supportEmailInput.trim() || supportEmailInput.trim() === supportEmail}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 40%), hsl(220 100% 50%))" }}>
                {savingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                บันทึก
              </button>
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
