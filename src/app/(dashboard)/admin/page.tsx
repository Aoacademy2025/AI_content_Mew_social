"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Users, Crown, Ban, FileText, Video, Images, UserPlus, CalendarDays,
  ArrowRight, Loader2, Ticket, CheckCircle2, Clock, Send, ChevronDown, ChevronUp,
  Trash2, HardDrive, ShieldCheck, AlertTriangle, Music, Upload, X,
  CreditCard, Key, Eye, EyeOff, Tag, Plus, GripVertical, Zap, Building2,
  Bug, Lightbulb, SearchCheck, Maximize2, ClipboardCheck, Save, Languages, BarChart3,
} from "lucide-react";
import { toast } from "sonner";
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
  // Honest revenue split (see /api/admin/stats + src/lib/revenue-cohorts.ts)
  payingTotal: number; trialActive: number; compedPaid: number; mrr: number; lapsedPayers: number;
  payingCanceling?: number; mrrAtRisk?: number;
}

// Admin section tabs — grouped so the page is navigable instead of one long scroll.
type AdminTab = "overview" | "support" | "storage" | "billing" | "content";
const ADMIN_TABS: Array<{ id: AdminTab; label: string; icon: React.ElementType }> = [
  { id: "overview", label: "ภาพรวม",       icon: BarChart3 },
  { id: "support",  label: "Support",       icon: Ticket },
  { id: "storage",  label: "พื้นที่ดิสก์", icon: HardDrive },
  { id: "billing",  label: "การเงิน & แผน", icon: CreditCard },
  { id: "content",  label: "เพลง",          icon: Music },
];

// Single stat card — matches the original grid card (byte-identical for non-hero);
// `hero` variant fills violet for the headline "จ่ายจริง" cash metric.
function StatCard({
  title, value, sub, icon: Icon, loading, hero = false,
}: {
  title: string;
  value: number | string;
  sub: string;
  icon: React.ElementType;
  loading: boolean;
  hero?: boolean;
}) {
  return (
    <Card className="shadow-none" style={hero ? { background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` } : cardStyle}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium" style={{ color: hero ? VIOLET_LIGHT : "var(--ui-text-secondary)" }}>{title}</CardTitle>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
          <Icon className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? null : (
          <div className="text-3xl font-bold" style={{ color: hero ? "#fff" : "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>{value}</div>
        )}
        <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>{sub}</p>
      </CardContent>
    </Card>
  );
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

interface StorageHealth {
  checkedAt: string;
  status: "ok" | "warning" | "high" | "critical";
  thresholds: { warning: number; high: number; critical: number };
  disk: {
    mount: string;
    filesystem: string;
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPercent: number;
  };
  directories: Array<{
    key: string;
    label: string;
    path: string;
    exists: boolean;
    sizeMb: number;
    sizeGb: number;
  }>;
}

interface SupportTicket {
  id: string;
  message: string;
  imageName: string | null;
  imageBase64?: string | null;
  imageMimeType: string | null;
  status: "OPEN" | "CLOSED";
  adminReply: string | null;
  category: SupportTicketCategory | null;
  severity: SupportTicketSeverity | null;
  recommendedAction: SupportRecommendation | null;
  auditNote: string | null;
  impactNote: string | null;
  auditedAt: string | null;
  createdAt: string;
  user: { name: string; email: string; plan: string };
}

type SupportTicketCategory = "BUG_CONFIRMED" | "FEATURE_REQUEST" | "USER_CONFUSION" | "NEED_MORE_INFO" | "NOT_A_BUG";
type SupportTicketSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type SupportRecommendation = "FIX" | "ADD_FEATURE" | "NEED_MORE_INFO" | "WONT_FIX" | "MONITOR";

type TriageDraft = {
  category: SupportTicketCategory | "";
  severity: SupportTicketSeverity | "";
  recommendedAction: SupportRecommendation | "";
  auditNote: string;
  impactNote: string;
};

const CATEGORY_OPTIONS: Array<{ value: SupportTicketCategory; label: string; icon: ReactNode }> = [
  { value: "BUG_CONFIRMED", label: "Bug จริง", icon: <Bug className="h-3 w-3" /> },
  { value: "FEATURE_REQUEST", label: "Feature request", icon: <Lightbulb className="h-3 w-3" /> },
  { value: "USER_CONFUSION", label: "User เข้าใจผิด", icon: <SearchCheck className="h-3 w-3" /> },
  { value: "NEED_MORE_INFO", label: "ต้องถามเพิ่ม", icon: <Clock className="h-3 w-3" /> },
  { value: "NOT_A_BUG", label: "ไม่ใช่บัค", icon: <CheckCircle2 className="h-3 w-3" /> },
];

const SEVERITY_OPTIONS: Array<{ value: SupportTicketSeverity; label: string; className: string }> = [
  { value: "LOW", label: "Low", className: "text-zinc-400 border-zinc-500/25 bg-zinc-500/10" },
  { value: "MEDIUM", label: "Medium", className: "text-sky-300 border-sky-500/25 bg-sky-500/10" },
  { value: "HIGH", label: "High", className: "text-orange-300 border-orange-500/25 bg-orange-500/10" },
  { value: "CRITICAL", label: "Critical", className: "text-red-300 border-red-500/30 bg-red-500/10" },
];

const RECOMMENDATION_OPTIONS: Array<{ value: SupportRecommendation; label: string }> = [
  { value: "FIX", label: "เสนอแก้บัค" },
  { value: "ADD_FEATURE", label: "เสนอเพิ่มฟีเจอร์" },
  { value: "NEED_MORE_INFO", label: "ขอข้อมูลเพิ่ม" },
  { value: "WONT_FIX", label: "ไม่ควรทำ" },
  { value: "MONITOR", label: "เฝ้าดูต่อ" },
];

function categoryLabel(value: SupportTicketCategory | null) {
  return CATEGORY_OPTIONS.find(o => o.value === value)?.label ?? null;
}

function severityMeta(value: SupportTicketSeverity | null) {
  return SEVERITY_OPTIONS.find(o => o.value === value) ?? null;
}

function recommendationLabel(value: SupportRecommendation | null) {
  return RECOMMENDATION_OPTIONS.find(o => o.value === value)?.label ?? null;
}

// ── PlanEditor: visual feature list editor ────────────────────────────────
function PlanEditor({
  label, accent, icon, price, onPriceChange, features, onFeaturesChange,
  name, onNameChange, badge, onBadgeChange, tagline, onTaglineChange,
}: {
  label: string;
  accent: "cyan" | "violet" | "zinc";
  icon: React.ReactNode;
  price: string;
  onPriceChange: (v: string) => void;
  features: string;
  onFeaturesChange: (v: string) => void;
  name: string;
  onNameChange: (v: string) => void;
  badge: string;
  onBadgeChange: (v: string) => void;
  tagline: string;
  onTaglineChange: (v: string) => void;
}) {
  const items = features.split("|").map(f => f.trim()).filter(Boolean);
  const [newFeature, setNewFeature] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");

  const palette = {
    // "cyan" key retained so the recommended-badge conditional (accent === "cyan") stays byte-identical; recolored to house violet
    cyan:   { border: "border-violet-500/30", bg: "bg-violet-500/8", focus: "focus:border-violet-500/60", text: "text-violet-300", check: "#B9A6FF", iconBg: "bg-violet-500/15", addBg: "rgba(139,92,246,.14)",      addBorder: "rgba(167,139,250,.45)" },
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

      {/* Name / Badge / Tagline */}
      <div className="space-y-2">
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ชื่อแผน (Name)</span>
          <input
            type="text"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder={label}
            className={`w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-1.5 text-sm text-white placeholder-zinc-600 outline-none ${focusBorder}`}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ป้าย (Badge)</span>
          <input
            type="text"
            value={badge}
            onChange={e => onBadgeChange(e.target.value)}
            placeholder="ไม่มีป้าย"
            className={`w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-1.5 text-sm text-white placeholder-zinc-600 outline-none ${focusBorder}`}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">คำโปรย (Tagline)</span>
          <input
            type="text"
            value={tagline}
            onChange={e => onTaglineChange(e.target.value)}
            placeholder="คำโปรยสั้นๆ..."
            className={`w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-1.5 text-sm text-white placeholder-zinc-600 outline-none ${focusBorder}`}
          />
        </label>
      </div>

      {/* Price */}
      <div className="flex items-center gap-2">
        <span className="text-2xl font-bold text-white">฿</span>
        <input
          type="number"
          value={price}
          onChange={e => onPriceChange(e.target.value)}
          className={`w-28 rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-1.5 text-xl font-bold text-white outline-none ${focusBorder}`}
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
                className={`flex-1 rounded border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-0.5 text-xs text-white outline-none ${focusBorder}`}
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
          className={`flex-1 rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-1.5 text-xs text-white placeholder-zinc-600 outline-none ${focusBorder}`}
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
  const [triageDrafts, setTriageDrafts] = useState<Record<string, TriageDraft>>({});
  const [savingTriage, setSavingTriage] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string | null } | null>(null);

  // Active section tab (grouped nav — see ADMIN_TABS)
  const [tab, setTab] = useState<AdminTab>("overview");

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

  // Server-owned Gemini key (platform automation: loanword miner cron, etc.)
  const [serverGeminiKey, setServerGeminiKey] = useState("");
  const [savingServerKey, setSavingServerKey] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [savingStripe, setSavingStripe] = useState(false);

  // Plan config
  const [planFreePrice, setPlanFreePrice] = useState("0");
  const [planFreeFeatures, setPlanFreeFeatures] = useState("ทดลอง PRO ฟรี 7 วัน|หลังหมดทดลอง: 5 นาที/เดือน · ~5 คลิป|ความยาววิดีโอสูงสุด 2 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 3 วัน|สร้างคอนเทนต์ด้วย AI (จำกัด 5 ชิ้น)|Font พื้นฐานเท่านั้น");
  const [planProPrice, setPlanProPrice] = useState("599");
  const [planProFeatures, setPlanProFeatures] = useState("80 นาที/เดือน · ~80 คลิป|ความยาววิดีโอสูงสุด 6 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 7 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Support ทาง Email — ทีมงานตอบสนองภายใน 48 ชั่วโมง");
  const [planBusinessPrice, setPlanBusinessPrice] = useState("990");
  const [planBusinessFeatures, setPlanBusinessFeatures] = useState("150 นาที/เดือน · ~150 คลิป|ความยาววิดีโอสูงสุด 10 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 14 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Priority Support — ทีมงานตอบสนองภายใน 24 ชั่วโมง|เหมาะสำหรับทีมงานและองค์กรธุรกิจ");
  // Plan presentation (name / badge / tagline) — badge empty = no badge
  const [planFreeName, setPlanFreeName] = useState("");
  const [planProName, setPlanProName] = useState("");
  const [planBusinessName, setPlanBusinessName] = useState("");
  const [planFreeBadge, setPlanFreeBadge] = useState("");
  const [planProBadge, setPlanProBadge] = useState("");
  const [planBusinessBadge, setPlanBusinessBadge] = useState("");
  const [planFreeTagline, setPlanFreeTagline] = useState("");
  const [planProTagline, setPlanProTagline] = useState("");
  const [planBusinessTagline, setPlanBusinessTagline] = useState("");
  const [savingPlans, setSavingPlans] = useState(false);

  // Cost-rate editor state
  const [costRenderPerMinute, setCostRenderPerMinute] = useState("");
  const [costImageFlux1k, setCostImageFlux1k] = useState("");
  const [costImageGpt1k, setCostImageGpt1k] = useState("");
  const [costImageNano1k, setCostImageNano1k] = useState("");
  const [costImageGpt2k, setCostImageGpt2k] = useState("");
  const [costImageNano2k, setCostImageNano2k] = useState("");
  const [costVideoSeedance5s, setCostVideoSeedance5s] = useState("");
  const [costInfraMonthly, setCostInfraMonthly] = useState("");
  const [fxBahtPerUsd, setFxBahtPerUsd] = useState("");
  const [savingCostRates, setSavingCostRates] = useState(false);

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
      // Plan presentation — read raw (empty badge is valid = no badge)
      if (typeof d.plan_free_name === "string") setPlanFreeName(d.plan_free_name);
      if (typeof d.plan_pro_name === "string") setPlanProName(d.plan_pro_name);
      if (typeof d.plan_business_name === "string") setPlanBusinessName(d.plan_business_name);
      if (typeof d.plan_free_badge === "string") setPlanFreeBadge(d.plan_free_badge);
      if (typeof d.plan_pro_badge === "string") setPlanProBadge(d.plan_pro_badge);
      if (typeof d.plan_business_badge === "string") setPlanBusinessBadge(d.plan_business_badge);
      if (typeof d.plan_free_tagline === "string") setPlanFreeTagline(d.plan_free_tagline);
      if (typeof d.plan_pro_tagline === "string") setPlanProTagline(d.plan_pro_tagline);
      if (typeof d.plan_business_tagline === "string") setPlanBusinessTagline(d.plan_business_tagline);
      if (d.server_gemini_key) setServerGeminiKey(d.server_gemini_key);
      // Cost rates
      if (d.cost_render_per_minute) setCostRenderPerMinute(d.cost_render_per_minute);
      if (d.cost_image_flux_1k) setCostImageFlux1k(d.cost_image_flux_1k);
      if (d.cost_image_gpt_1k) setCostImageGpt1k(d.cost_image_gpt_1k);
      if (d.cost_image_nano_1k) setCostImageNano1k(d.cost_image_nano_1k);
      if (d.cost_image_gpt_2k) setCostImageGpt2k(d.cost_image_gpt_2k);
      if (d.cost_image_nano_2k) setCostImageNano2k(d.cost_image_nano_2k);
      if (d.cost_video_seedance_5s) setCostVideoSeedance5s(d.cost_video_seedance_5s);
      if (d.cost_infra_monthly) setCostInfraMonthly(d.cost_infra_monthly);
      if (d.fx_baht_per_usd) setFxBahtPerUsd(d.fx_baht_per_usd);
    } catch {}
  }

  async function saveCostRates() {
    setSavingCostRates(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cost_render_per_minute: costRenderPerMinute,
          cost_image_flux_1k: costImageFlux1k,
          cost_image_gpt_1k: costImageGpt1k,
          cost_image_nano_1k: costImageNano1k,
          cost_image_gpt_2k: costImageGpt2k,
          cost_image_nano_2k: costImageNano2k,
          cost_video_seedance_5s: costVideoSeedance5s,
          cost_infra_monthly: costInfraMonthly,
          fx_baht_per_usd: fxBahtPerUsd,
        }),
      });
      if (res.ok) toast.success("บันทึก Cost Rates แล้ว");
      else toast.error("บันทึกไม่สำเร็จ");
    } catch { toast.error("เกิดข้อผิดพลาด"); }
    finally { setSavingCostRates(false); }
  }

  async function saveServerGeminiKey() {
    setSavingServerKey(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_gemini_key: serverGeminiKey.trim() }),
      });
      if (res.ok) toast.success("บันทึก Server Gemini Key แล้ว");
      else toast.error("บันทึกไม่สำเร็จ");
    } catch { toast.error("เกิดข้อผิดพลาด"); }
    finally { setSavingServerKey(false); }
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
          plan_free_name: planFreeName,
          plan_pro_name: planProName,
          plan_business_name: planBusinessName,
          plan_free_badge: planFreeBadge,
          plan_pro_badge: planProBadge,
          plan_business_badge: planBusinessBadge,
          plan_free_tagline: planFreeTagline,
          plan_pro_tagline: planProTagline,
          plan_business_tagline: planBusinessTagline,
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
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);

  function loadCleanupInfo() {
    setCleanupLoading(true);
    fetch("/api/admin/cleanup")
      .then(r => r.json())
      .then(d => setCleanupInfo(d))
      .catch(() => {})
      .finally(() => setCleanupLoading(false));
  }

  function loadStorageHealth() {
    setStorageLoading(true);
    fetch("/api/admin/storage", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (!d.error) setStorageHealth(d);
      })
      .catch(() => {})
      .finally(() => setStorageLoading(false));
  }

  function refreshStorageInfo() {
    loadStorageHealth();
    loadCleanupInfo();
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
        refreshStorageInfo();
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
    loadStorageHealth();
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

  function draftFromTicket(ticket: SupportTicket): TriageDraft {
    return {
      category: ticket.category ?? "",
      severity: ticket.severity ?? "",
      recommendedAction: ticket.recommendedAction ?? "",
      auditNote: ticket.auditNote ?? "",
      impactNote: ticket.impactNote ?? "",
    };
  }

  function triageDraft(ticket: SupportTicket) {
    return triageDrafts[ticket.id] ?? draftFromTicket(ticket);
  }

  function updateTriageDraft(ticket: SupportTicket, patch: Partial<TriageDraft>) {
    setTriageDrafts(prev => ({
      ...prev,
      [ticket.id]: { ...draftFromTicket(ticket), ...prev[ticket.id], ...patch },
    }));
  }

  async function saveTriage(ticket: SupportTicket) {
    const draft = triageDraft(ticket);
    setSavingTriage(ticket.id);
    try {
      const res = await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId: ticket.id,
          category: draft.category || null,
          severity: draft.severity || null,
          recommendedAction: draft.recommendedAction || null,
          auditNote: draft.auditNote,
          impactNote: draft.impactNote,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "บันทึก audit ไม่สำเร็จ");
        return;
      }
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, ...data.ticket } : t));
      setTriageDrafts(prev => {
        const next = { ...prev };
        delete next[ticket.id];
        return next;
      });
      toast.success("บันทึก audit แล้ว");
    } catch {
      toast.error("บันทึก audit ไม่สำเร็จ");
    } finally {
      setSavingTriage(null);
    }
  }

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

  // ผู้ใช้งาน group — the "Paid" card is replaced by the honest revenue group below.
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

  const storageTone = {
    ok: {
      label: "ปกติ",
      text: "text-green-300",
      border: "border-green-500/25",
      bg: "bg-green-500/8",
      bar: "bg-green-400",
    },
    warning: {
      label: "เฝ้าระวัง",
      text: "text-yellow-300",
      border: "border-yellow-500/30",
      bg: "bg-yellow-500/10",
      bar: "bg-yellow-400",
    },
    high: {
      label: "สูง",
      text: "text-orange-300",
      border: "border-orange-500/35",
      bg: "bg-orange-500/10",
      bar: "bg-orange-400",
    },
    critical: {
      label: "วิกฤต",
      text: "text-red-300",
      border: "border-red-500/40",
      bg: "bg-red-500/12",
      bar: "bg-red-400",
    },
  }[storageHealth?.status ?? "ok"];

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      {imagePreview && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" onClick={() => setImagePreview(null)}>
          <div className="relative max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-zinc-950" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <span className="truncate text-xs text-zinc-400">{imagePreview.name ?? "attachment"}</span>
              <button
                onClick={() => setImagePreview(null)}
                className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="ปิดรูป"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imagePreview.src} alt={imagePreview.name ?? "attachment"} className="max-h-[84vh] w-full object-contain bg-black" />
          </div>
        </div>
      )}
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

        {/* Tab bar — grouped nav (flat pill style, matches settings page) */}
        <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl w-full sm:w-auto sm:inline-flex"
          style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
          {ADMIN_TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all ${active ? "shadow-sm" : "hover:bg-white/5"}`}
                style={active ? {
                  background: VIOLET_GRAD,
                  color: "#fff",
                  boxShadow: "0 4px 12px hsl(258 90% 66% / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
                } : {
                  color: "var(--ui-text-muted)",
                }}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
                {label}
              </button>
            );
          })}
        </div>

        {/* ── Overview tab: Stats ──────────────────────────────────────── */}
        {tab === "overview" && (
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

            {/* รายได้จริง group — honest cash vs trial vs comped */}
            <div>
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: VIOLET_LIGHT }}>รายได้จริง</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard hero title="จ่ายจริง (จ่ายเงินสด)" value={stats?.payingTotal ?? 0} sub={stats?.payingCanceling ? `ใช้งานอยู่ + จ่ายเงินจริง · ${stats.payingCanceling} รอหมดรอบ` : "ใช้งานอยู่ + จ่ายเงินจริง"} icon={Crown} loading={loading} />
                <StatCard title="Trial (ทดลอง)" value={stats?.trialActive ?? 0} sub="ทดลอง PRO ฟรี ยังไม่จ่ายเงิน" icon={Clock} loading={loading} />
                <StatCard title="Comped (แจกสิทธิ์)" value={stats?.compedPaid ?? 0} sub="admin/coupon — เป็นต้นทุน ไม่ใช่รายได้" icon={Tag} loading={loading} />
                <StatCard title="MRR (รายได้/เดือน)" value={`฿${Math.round(stats?.mrr ?? 0).toLocaleString()}`} sub="รายได้ต่อเดือน (annual เฉลี่ยแล้ว)" icon={BarChart3} loading={loading} />
              </div>
              <p className="mt-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                หมายเหตุ: ยอด &quot;บนแผน PRO/BUSINESS&quot; ทั้งหมด {stats?.paidUsers ?? 0} ราย ≈ จ่ายจริง {stats?.payingTotal ?? 0} + Trial {stats?.trialActive ?? 0} + Comped {stats?.compedPaid ?? 0} (ที่เหลือ = รอ cron ปรับสถานะ)
              </p>
            </div>
          </div>
        )}

        {/* ── Support tab ──────────────────────────────────────────────── */}
        {tab === "support" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--ui-text-primary)" }}>
              <Ticket className="h-5 w-5" style={{ color: VIOLET }} />
              Support Tickets
              {tickets.length > 0 && ticketFilter === "OPEN" && (
                <span className="rounded-full text-xs px-2 py-0.5 font-bold" style={{ background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>{tickets.length}</span>
              )}
            </h2>
            {/* Filter tabs */}
            <div className="flex gap-1 rounded-lg p-1" style={cardStyle}>
              {(["OPEN", "CLOSED", "ALL"] as const).map(f => (
                <button key={f} onClick={() => setTicketFilter(f)}
                  className="px-3 py-1 rounded text-xs font-semibold transition-all"
                  style={ticketFilter === f
                    ? { background: VIOLET_GRAD, color: "#fff" }
                    : { color: "var(--ui-text-muted)" }}>
                  {f === "OPEN" ? "เปิด" : f === "CLOSED" ? "ปิดแล้ว" : "ทั้งหมด"}
                </button>
              ))}
            </div>
          </div>

          {ticketsLoading ? null : tickets.length === 0 ? (
            <div className="rounded-2xl flex flex-col items-center justify-center py-12 gap-2" style={cardStyle}>
              <CheckCircle2 className="h-8 w-8 text-green-400/40" />
              <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ไม่มี ticket ที่{ticketFilter === "OPEN" ? "รอดำเนินการ" : "ปิดแล้ว"}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tickets.map(ticket => {
                const expanded = expandedId === ticket.id;
                const imageSrc = ticket.imageBase64
                  ? `data:${ticket.imageMimeType ?? "image/jpeg"};base64,${ticket.imageBase64}`
                  : ticket.imageName
                    ? `/api/admin/support/${encodeURIComponent(ticket.id)}/image`
                    : null;
                const draft = triageDraft(ticket);
                const catLabel = categoryLabel(ticket.category);
                const severity = severityMeta(ticket.severity);
                const recoLabel = recommendationLabel(ticket.recommendedAction);
                return (
                  <div key={ticket.id} className="rounded-2xl overflow-hidden" style={cardStyle}>
                    {/* Ticket header */}
                    <button className="w-full flex items-start gap-4 p-4 text-left hover:bg-white/5 transition-colors"
                      onClick={() => setExpandedId(expanded ? null : ticket.id)}>
                      <div className={`mt-0.5 shrink-0 h-2 w-2 rounded-full ${ticket.status === "OPEN" ? "bg-red-400" : "bg-green-400"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>{ticket.user.name}</span>
                          <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{ticket.user.email}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-secondary)" }}>{ticket.user.plan}</span>
                          <span className="text-[10px] ml-auto" style={{ color: "var(--ui-text-muted)" }}>
                            {new Date(ticket.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-sm mt-1 line-clamp-2" style={{ color: "var(--ui-text-secondary)" }}>{ticket.message}</p>
                        {ticket.adminReply && (
                          <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#34D399" }}>
                            <CheckCircle2 className="h-3 w-3" /> ตอบแล้ว
                          </p>
                        )}
                        {(catLabel || severity || recoLabel) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {catLabel && (
                              <span className="inline-flex items-center gap-1 rounded border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">
                                <ClipboardCheck className="h-3 w-3" /> {catLabel}
                              </span>
                            )}
                            {severity && (
                              <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${severity.className}`}>
                                {severity.label}
                              </span>
                            )}
                            {recoLabel && (
                              <span className="inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--ui-badge-neutral-bg)", borderColor: "var(--ui-badge-neutral-border)", color: "var(--ui-text-secondary)" }}>
                                {recoLabel}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {expanded ? <ChevronUp className="h-4 w-4 text-zinc-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />}
                    </button>

                    {/* Expanded detail */}
                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 pt-4" style={{ borderTop: "1px solid var(--ui-divider)" }}>
                        {/* Message */}
                        <div className="rounded-xl p-3" style={{ background: "var(--ui-card-bg-2)" }}>
                          <p className="text-xs mb-1 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>ปัญหา</p>
                          <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--ui-text-secondary)" }}>{ticket.message}</p>
                        </div>

                        {/* Image attachment */}
                        {imageSrc && (
                          <div className="overflow-hidden rounded-xl" style={{ border: "1px solid var(--ui-divider)" }}>
                            <button
                              type="button"
                              onClick={() => setImagePreview({ src: imageSrc, name: ticket.imageName })}
                              className="group relative block w-full bg-black/30"
                            >
                              <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-medium text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100">
                                <Maximize2 className="h-3 w-3" /> ดูเต็ม
                              </span>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imageSrc}
                              alt={ticket.imageName ?? "attachment"}
                              className="w-full max-h-64 object-contain bg-black/30"
                            />
                            </button>
                            {ticket.imageName && <p className="px-3 py-1 text-[10px] text-zinc-500">{ticket.imageName}</p>}
                          </div>
                        )}

                        {/* Audit */}
                        <div className="rounded-xl p-3" style={{ background: "rgba(139,92,246,.06)", border: "1px solid rgba(167,139,250,.25)" }}>
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <ClipboardCheck className="h-4 w-4" style={{ color: VIOLET_LIGHT }} />
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: VIOLET_LIGHT }}>Ticket Audit</p>
                                <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
                                  {ticket.auditedAt
                                    ? `อัปเดต ${new Date(ticket.auditedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                                    : "ยังไม่ได้ audit"}
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => saveTriage(ticket)}
                              disabled={savingTriage === ticket.id}
                              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-45"
                              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}
                            >
                              {savingTriage === ticket.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                              บันทึก audit
                            </button>
                          </div>

                          <div className="grid gap-2 md:grid-cols-3">
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ประเภท</span>
                              <select
                                value={draft.category}
                                onChange={e => updateTriageDraft(ticket, { category: e.target.value as SupportTicketCategory | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่จัดประเภท</option>
                                {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ความรุนแรง</span>
                              <select
                                value={draft.severity}
                                onChange={e => updateTriageDraft(ticket, { severity: e.target.value as SupportTicketSeverity | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่ประเมิน</option>
                                {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ข้อเสนอ</span>
                              <select
                                value={draft.recommendedAction}
                                onChange={e => updateTriageDraft(ticket, { recommendedAction: e.target.value as SupportRecommendation | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่เสนอ</option>
                                {RECOMMENDATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                          </div>

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">หลักฐาน / วิเคราะห์</span>
                              <textarea
                                value={draft.auditNote}
                                onChange={e => updateTriageDraft(ticket, { auditNote: e.target.value.slice(0, 1200) })}
                                placeholder="เช่น reproduce ได้ไหม, จากรูปเห็น error อะไร, เป็น bug จริงหรือ user เข้าใจผิด"
                                rows={4}
                                className="w-full resize-none rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ผลกระทบ / server spec</span>
                              <textarea
                                value={draft.impactNote}
                                onChange={e => updateTriageDraft(ticket, { impactNote: e.target.value.slice(0, 800) })}
                                placeholder="เช่น กระทบ render, DB, disk, API cost, memory/CPU หรือเสี่ยงกับงานเก่าไหม"
                                rows={4}
                                className="w-full resize-none rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                          </div>
                        </div>

                        {/* Existing reply */}
                        {ticket.adminReply && (
                          <div className="rounded-xl p-3" style={{ background: "rgba(139,92,246,.06)", border: "1px solid rgba(167,139,250,.25)" }}>
                            <p className="text-xs mb-1 font-semibold uppercase tracking-wider" style={{ color: VIOLET_LIGHT }}>คำตอบจากทีมงาน</p>
                            <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--ui-text-secondary)" }}>{ticket.adminReply}</p>
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
                              style={{ background: "var(--ui-input-bg)", border: "1px solid var(--ui-input-border)" }}
                            />
                            <div className="flex gap-2">
                              <button
                                disabled={!replyText[ticket.id]?.trim() || replying === ticket.id}
                                onClick={() => handleReply(ticket.id, false)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 transition-all hover:brightness-110"
                                style={{ background: VIOLET_GRAD, border: "1px solid transparent" }}>
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
        )}

        {/* ── Storage tab ──────────────────────────────────────────────── */}
        {tab === "storage" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--ui-text-primary)" }}>
              <HardDrive className="h-5 w-5" style={{ color: VIOLET }} />
              จัดการพื้นที่ดิสก์
            </h2>
            <button onClick={refreshStorageInfo} disabled={cleanupLoading || storageLoading}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1">
              {cleanupLoading || storageLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 -rotate-90" />}
              รีเฟรช
            </button>
          </div>

          {storageHealth && (
            <div className={`mb-4 rounded-2xl border ${storageTone.border} ${storageTone.bg} p-5`}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <HardDrive className={`h-4 w-4 ${storageTone.text}`} />
                    <span className={`text-sm font-semibold ${storageTone.text}`}>Disk Status: {storageTone.label}</span>
                    <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ background: "var(--ui-badge-neutral-bg)", borderColor: "var(--ui-badge-neutral-border)", color: "var(--ui-text-muted)" }}>
                      alert {storageHealth.thresholds.warning}/{storageHealth.thresholds.high}/{storageHealth.thresholds.critical}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-black/30">
                    <div
                      className={`h-full rounded-full ${storageTone.bar}`}
                      style={{ width: `${Math.min(100, storageHealth.disk.usedPercent)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    ใช้ไป {storageHealth.disk.usedGb}GB จาก {storageHealth.disk.totalGb}GB · เหลือ {storageHealth.disk.availableGb}GB · mount {storageHealth.disk.mount}
                  </p>
                </div>

                <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[520px]">
                  {storageHealth.directories.map(dir => (
                    <div key={dir.key} className="rounded-xl px-3 py-2" style={cardStyle}>
                      <p className="truncate text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{dir.label}</p>
                      <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>{dir.sizeGb >= 1 ? `${dir.sizeGb}GB` : `${dir.sizeMb}MB`}</p>
                    </div>
                  ))}
                </div>
              </div>

              {storageHealth.status !== "ok" && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
                  <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${storageTone.text}`} />
                  <p className={`text-xs ${storageTone.text}`}>
                    พื้นที่ดิสก์เกิน threshold แล้ว ควรตรวจ orphan media, stock cache และไฟล์ render ที่โตผิดปกติก่อนปล่อยให้เกิน 90%
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="rounded-2xl p-5 space-y-5" style={cardStyle}>
            {/* Stats row */}
            {/* /renders stats */}
            <div>
              <p className="text-xs mb-2 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>/renders (วิดีโอ render)</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "ทั้งหมด", val: cleanupInfo?.renders.total, color: "zinc" },
                  { label: "เกิน 1 วัน", val: cleanupInfo?.renders.older1d, color: "yellow" },
                  { label: "เกิน 3 วัน", val: cleanupInfo?.renders.older3d, color: "orange" },
                  { label: "เกิน 7 วัน", val: cleanupInfo?.renders.older7d, color: "red" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="rounded-xl p-3 text-center" style={cardStyle}>
                    <p className="text-xs mb-1" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                    {cleanupLoading ? null : (
                      <>
                        <p className={`text-xl font-bold ${color === "red" ? "text-red-400" : color === "orange" ? "text-orange-400" : color === "yellow" ? "text-yellow-400" : "text-zinc-300"}`}>
                          {val?.sizeMb ?? 0} MB
                        </p>
                        <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{val?.count ?? 0} ไฟล์</p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* /tmp stats */}
            <div>
              <p className="text-xs mb-2 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>/tmp (Remotion temp files)</p>
              <div className="rounded-xl p-3 flex items-center gap-4" style={cardStyle}>
                {cleanupLoading ? null : (
                  <>
                    <div>
                      <p className={`text-2xl font-bold ${(cleanupInfo?.tmp.sizeMb ?? 0) > 1000 ? "text-red-400" : (cleanupInfo?.tmp.sizeMb ?? 0) > 500 ? "text-orange-400" : "text-zinc-300"}`}>
                        {cleanupInfo?.tmp.sizeMb ?? 0} MB
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{cleanupInfo?.tmp.count ?? 0} temp folders</p>
                    </div>
                    <p className="text-xs flex-1" style={{ color: "var(--ui-text-muted)" }}>
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
                      className="px-3 py-1 rounded-lg text-xs font-semibold transition-all border"
                      style={cleanDays === d
                        ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT, borderColor: VIOLET_TILE_BORDER }
                        : { background: "var(--ui-btn-bg)", color: "var(--ui-text-muted)", borderColor: "var(--ui-btn-border)" }}>
                      {d} วัน
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={includeStocks} onChange={e => setIncludeStocks(e.target.checked)}
                  className="accent-[#8B5CF6] h-3.5 w-3.5" />
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
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:brightness-110"
                style={{ background: "hsl(0 75% 55% / 0.2)", border: "1px solid hsl(0 75% 60% / 0.45)" }}>
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
        )}

        {/* ── Overview tab: Quick Actions ──────────────────────────────── */}
        {tab === "overview" && (
        <div>
          <h2 className="mb-4 text-lg font-bold" style={{ color: "var(--ui-text-primary)" }}>Quick Actions</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Link href="/admin/users">
              <Card className="group shadow-none border-[var(--ui-card-border)] bg-[var(--ui-card-bg)] transition-all hover:border-[rgba(167,139,250,0.45)] hover:bg-[rgba(139,92,246,0.06)]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[9px]" style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
                      <Users className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
                    </div>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" style={{ color: "var(--ui-text-muted)" }} />
                  </div>
                  <CardTitle className="mt-2 text-sm" style={{ color: "var(--ui-text-primary)" }}>จัดการผู้ใช้งาน</CardTitle>
                  <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>ดูข้อมูล แก้ไขแผน ระงับ/ปลดล็อกบัญชี และลบผู้ใช้งาน</p>
                </CardHeader>
              </Card>
            </Link>
            <Link href="/admin/loanwords">
              <Card className="group shadow-none border-[var(--ui-card-border)] bg-[var(--ui-card-bg)] transition-all hover:border-[rgba(167,139,250,0.45)] hover:bg-[rgba(139,92,246,0.06)]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[9px]" style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
                      <Languages className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
                    </div>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" style={{ color: "var(--ui-text-muted)" }} />
                  </div>
                  <CardTitle className="mt-2 text-sm" style={{ color: "var(--ui-text-primary)" }}>คำตัดซับ (Loanwords)</CardTitle>
                  <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>จัดการคำยืมที่ระบบกันไม่ให้ตัดผิด — ถอน/แก้/เพิ่ม/คืนค่า</p>
                </CardHeader>
              </Card>
            </Link>
            <Card className="shadow-none" style={cardStyle}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-[9px]" style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
                    <Crown className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
                  </div>
                </div>
                <CardTitle className="mt-2 text-sm" style={{ color: "var(--ui-text-primary)" }}>สถิติแผนการใช้งาน</CardTitle>
                <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  {loading ? "..." : `${stats?.paidUsers ?? 0} แผน PRO/BUSINESS (รวม trial/comp) · ${stats?.freeUsers ?? 0} Free`}
                </p>
              </CardHeader>
            </Card>
          </div>
        </div>
        )}

        {/* ── Content tab: Music Library ───────────────────────────────── */}
        {tab === "content" && (
        <div className="rounded-xl p-5" style={cardStyle}>
          <div className="mb-4 flex items-center gap-2">
            <Music className="h-4 w-4" style={{ color: VIOLET }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Music Library</h2>
            <span className="ml-auto text-xs" style={{ color: "var(--ui-text-muted)" }}>{tracks.length} เพลง</span>
          </div>

          {/* Upload form */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="ชื่อเพลง"
              value={newMusicTitle}
              onChange={e => setNewMusicTitle(e.target.value)}
              className="flex-1 rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <label className={`flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition hover:brightness-110 ${musicUploading ? "opacity-50 pointer-events-none" : ""}`}
              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}>
              {musicUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {musicUploading ? "กำลังอัปโหลด..." : "อัปโหลดเพลง"}
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadTrack(f); e.target.value = ""; }} />
            </label>
          </div>

          {/* Track list */}
          {musicLoading ? null : tracks.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีเพลง — อัปโหลดเพลงแรก</p>
          ) : (
            <div className="space-y-2">
              {tracks.map(t => (
                <div key={t.id} className="rounded-lg px-3 py-2 space-y-1.5" style={cardStyle}>
                  <div className="flex items-center gap-3">
                    <Music className="h-3.5 w-3.5 shrink-0" style={{ color: VIOLET }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" style={{ color: "var(--ui-text-primary)" }}>{t.title}</p>
                      <p className="truncate text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{t.filename}</p>
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
        )}

        {/* ── Billing & Plans tab (Stripe · Server Keys · Plan Config · Support Email · Cost Rates) ── */}
        {tab === "billing" && (
        <div className="space-y-8">
        {/* ── Stripe Payment Settings ─────────────────────────────────── */}
        <div className="rounded-xl p-4 space-y-4" style={cardStyle}>
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
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Secret Key */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Secret Key <span className="text-zinc-600">(sk_live_... / sk_test_...)</span></label>
              <input type={showSecrets ? "text" : "password"} value={stripeSecretKey}
                onChange={e => setStripeSecretKey(e.target.value)}
                placeholder="sk_live_xxxx"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Webhook Secret */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Webhook Secret <span className="text-zinc-600">(whsec_...)</span></label>
              <input type={showSecrets ? "text" : "password"} value={stripeWebhookSecret}
                onChange={e => setStripeWebhookSecret(e.target.value)}
                placeholder="whsec_xxxx"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Price IDs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Price ID — Pro</label>
                <input type="text" value={stripePricePro}
                  onChange={e => setStripePricePro(e.target.value)}
                  placeholder="price_xxxx"
                  className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Price ID — Business</label>
                <input type="text" value={stripePriceBusiness}
                  onChange={e => setStripePriceBusiness(e.target.value)}
                  placeholder="price_xxxx"
                  className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={saveStripeSettings} disabled={savingStripe}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: VIOLET_GRAD }}>
              {savingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              บันทึก Stripe
            </button>
          </div>
        </div>

        {/* ── Server Keys (platform automation) ────────────────────────── */}
        <div className="rounded-xl p-4 space-y-4" style={cardStyle}>
          <div>
            <div className="text-sm font-semibold text-white">Server Gemini Key</div>
            <p className="text-xs text-zinc-500 mt-0.5">คีย์ของบริษัท (ไม่ใช่ของ user) สำหรับงานอัตโนมัติฝั่ง server เช่น ตัวขุดคำตัดซับ (loanword miner) — แสดง/ซ่อนด้วยปุ่ม &quot;keys&quot; ด้านบน</p>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Gemini API Key <span className="text-zinc-600">(AIza...)</span></label>
            <input type={showSecrets ? "text" : "password"} value={serverGeminiKey}
              onChange={e => setServerGeminiKey(e.target.value)}
              placeholder="AIzaSyxxxx"
              autoComplete="off"
              className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
          </div>
          <div className="flex justify-end">
            <button onClick={saveServerGeminiKey} disabled={savingServerKey}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: VIOLET_GRAD }}>
              {savingServerKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              บันทึก Server Key
            </button>
          </div>
        </div>

        {/* ── Plan Config ──────────────────────────────────────────────── */}
        <div className="rounded-xl p-4 space-y-4" style={cardStyle}>
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4" style={{ color: VIOLET }} />
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
              name={planFreeName}
              onNameChange={setPlanFreeName}
              badge={planFreeBadge}
              onBadgeChange={setPlanFreeBadge}
              tagline={planFreeTagline}
              onTaglineChange={setPlanFreeTagline}
            />
            {/* ── Pro Plan Card ── */}
            <PlanEditor
              label="Pro"
              accent="cyan"
              icon={<Crown className="h-4 w-4 text-violet-300" />}
              price={planProPrice}
              onPriceChange={setPlanProPrice}
              features={planProFeatures}
              onFeaturesChange={setPlanProFeatures}
              name={planProName}
              onNameChange={setPlanProName}
              badge={planProBadge}
              onBadgeChange={setPlanProBadge}
              tagline={planProTagline}
              onTaglineChange={setPlanProTagline}
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
              name={planBusinessName}
              onNameChange={setPlanBusinessName}
              badge={planBusinessBadge}
              onBadgeChange={setPlanBusinessBadge}
              tagline={planBusinessTagline}
              onTaglineChange={setPlanBusinessTagline}
            />
          </div>

          <div className="flex justify-end">
            <button onClick={savePlanSettings} disabled={savingPlans}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: VIOLET_GRAD }}>
              {savingPlans ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              บันทึก Plans
            </button>
          </div>
        </div>

        {/* ── Support Email Settings ───────────────────────────────────── */}
        <div className="rounded-xl p-4 space-y-3" style={cardStyle}>
          <div className="flex items-center gap-2 mb-1">
            <Send className="h-4 w-4" style={{ color: VIOLET }} />
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
              className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-violet-500/50 resize-none font-mono"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-600">
                {supportEmailInput.split(",").map(e => e.trim()).filter(Boolean).length} อีเมล
              </span>
              <button
                onClick={saveSupportEmail}
                disabled={savingEmail || !supportEmailInput.trim() || supportEmailInput.trim() === supportEmail}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ background: VIOLET_GRAD }}>
                {savingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                บันทึก
              </button>
            </div>
          </div>
        </div>

        {/* ── Cost-rate Editor ──────────────────────────────────────────── */}
        <div className="rounded-xl p-4 space-y-4" style={cardStyle}>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-violet-400" />
            <h2 className="text-sm font-semibold text-white">Cost Rates (ต้นทุน)</h2>
          </div>
          <p className="text-xs text-zinc-500">
            อัตราต้นทุนที่ใช้คำนวณใน Cost &amp; Margin dashboard — ระบุเป็น <span className="font-mono text-zinc-400">฿</span> ต่อหน่วย; ตัวเลขจาก DB ทับ default ใน code
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                Gemini TTS — ฿/นาที
              </label>
              <input
                type="number"
                step="0.0001"
                value={costRenderPerMinute}
                onChange={e => setCostRenderPerMinute(e.target.value)}
                placeholder="0.014"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Image Flux-2/Pro (ประหยัด) — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageFlux1k}
                onChange={e => setCostImageFlux1k(e.target.value)}
                placeholder="0.90"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Image GPT-Image-2 (มาตรฐาน) — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageGpt1k}
                onChange={e => setCostImageGpt1k(e.target.value)}
                placeholder="1.08"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Image Nano-Banana-2 (ขั้นสูง) — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageNano1k}
                onChange={e => setCostImageNano1k(e.target.value)}
                placeholder="1.44"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Image GPT-4o 4K (สำรอง — ยังไม่ใช้งาน) — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageGpt2k}
                onChange={e => setCostImageGpt2k(e.target.value)}
                placeholder="1.20"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Image Nano 4K (สำรอง — ยังไม่ใช้งาน) — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageNano2k}
                onChange={e => setCostImageNano2k(e.target.value)}
                placeholder="0.30"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                AI Video Seedance 5s — ฿/วิดีโอ (เร็วๆ นี้)
              </label>
              <input
                type="number"
                step="0.0001"
                value={costVideoSeedance5s}
                onChange={e => setCostVideoSeedance5s(e.target.value)}
                placeholder="2.80"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                Infra รายเดือน — ฿/เดือน
              </label>
              <input
                type="number"
                step="1"
                value={costInfraMonthly}
                onChange={e => setCostInfraMonthly(e.target.value)}
                placeholder="2600"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                อัตราแลกเปลี่ยน ฿/USD
              </label>
              <input
                type="number"
                step="0.01"
                value={fxBahtPerUsd}
                onChange={e => setFxBahtPerUsd(e.target.value)}
                placeholder="35"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={saveCostRates}
              disabled={savingCostRates}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: VIOLET_GRAD }}
            >
              {savingCostRates ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              บันทึก Cost Rates
            </button>
          </div>
        </div>
        </div>
        )}

      </div>
    </div>
  );
}
