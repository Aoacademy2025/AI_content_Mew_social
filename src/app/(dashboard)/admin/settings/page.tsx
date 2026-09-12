"use client";

import { useEffect, useState } from "react";
import {
  CreditCard, Eye, EyeOff, Tag, Plus, Zap, Building2, Crown,
  CheckCircle2, Loader2, Send, BarChart3, Save, X,
} from "lucide-react";
import { toast } from "sonner";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
// Flat v2 card surface — inline var(--ui-*), matches settings/dashboard (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

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

export default function AdminSettingsPage() {
  // Settings state
  const [supportEmail, setSupportEmail] = useState("");
  const [supportEmailInput, setSupportEmailInput] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);

  // Stripe settings
  // NOTE: the GET endpoint never returns live secrets in full (SEC-12) — these
  // three inputs hold only a NEW value to write, and start empty. Current status
  // (set / not-set + last4) comes back as a masked sentinel and is tracked
  // separately so the UI can show "ตั้งไว้แล้ว (••••1234)" without ever holding
  // the real secret in browser state.
  type SecretStatus = { set: boolean; last4?: string };
  const UNSET_SECRET: SecretStatus = { set: false };
  const [stripePublishableKey, setStripePublishableKey] = useState("");
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  const [stripeSecretKeyStatus, setStripeSecretKeyStatus] = useState<SecretStatus>(UNSET_SECRET);
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState("");
  const [stripeWebhookSecretStatus, setStripeWebhookSecretStatus] = useState<SecretStatus>(UNSET_SECRET);
  const [stripePricePro, setStripePricePro] = useState("");
  const [stripePriceBusiness, setStripePriceBusiness] = useState("");

  // Server-owned Gemini key (platform automation: loanword miner cron, etc.)
  const [serverGeminiKey, setServerGeminiKey] = useState("");
  const [serverGeminiKeyStatus, setServerGeminiKeyStatus] = useState<SecretStatus>(UNSET_SECRET);
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
  const [costImageHero1k, setCostImageHero1k] = useState("");
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
      // stripe_secret_key / stripe_webhook_secret now come back masked as
      // { set, last4 } — never populate the editable input with them.
      if (d.stripe_secret_key && typeof d.stripe_secret_key === "object") setStripeSecretKeyStatus(d.stripe_secret_key);
      if (d.stripe_webhook_secret && typeof d.stripe_webhook_secret === "object") setStripeWebhookSecretStatus(d.stripe_webhook_secret);
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
      // server_gemini_key is also masked to { set, last4 } — status only.
      if (d.server_gemini_key && typeof d.server_gemini_key === "object") setServerGeminiKeyStatus(d.server_gemini_key);
      // Cost rates
      if (d.cost_render_per_minute) setCostRenderPerMinute(d.cost_render_per_minute);
      if (d.cost_image_hero_1k) setCostImageHero1k(d.cost_image_hero_1k);
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
          cost_image_hero_1k: costImageHero1k,
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
    // Nothing typed = leave the current key untouched (GET no longer echoes it
    // back, so an empty field must NOT be sent — that would wipe the secret).
    const next = serverGeminiKey.trim();
    if (!next) { toast.error("กรอกคีย์ใหม่ก่อนบันทึก"); return; }
    setSavingServerKey(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_gemini_key: next }),
      });
      if (res.ok) {
        toast.success("บันทึก Server Gemini Key แล้ว");
        setServerGeminiKey("");
        await loadSettings();
      } else toast.error("บันทึกไม่สำเร็จ");
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
      // stripe_secret_key / stripe_webhook_secret: only send if the admin
      // actually typed a new value — GET no longer echoes the current secret,
      // so an untouched (empty) field must be omitted, not sent as "".
      const body: Record<string, string> = {
        stripe_publishable_key: stripePublishableKey.trim(),
        stripe_price_pro: stripePricePro.trim(),
        stripe_price_business: stripePriceBusiness.trim(),
      };
      if (stripeSecretKey.trim()) body.stripe_secret_key = stripeSecretKey.trim();
      if (stripeWebhookSecret.trim()) body.stripe_webhook_secret = stripeWebhookSecret.trim();

      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("บันทึก Stripe Settings แล้ว");
        setStripeSecretKey("");
        setStripeWebhookSecret("");
        await loadSettings();
      } else toast.error("บันทึกไม่สำเร็จ");
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

  useEffect(() => {
    loadSettings();
  }, []);

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
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
            {/* Secret Key — value never round-trips from the server (SEC-12); only
                status (set/last4) does. Blank input = keep current on save. */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                Secret Key <span className="text-zinc-600">(sk_live_... / sk_test_...)</span>{" "}
                <span className={stripeSecretKeyStatus.set ? "text-emerald-500" : "text-amber-500"}>
                  {stripeSecretKeyStatus.set ? `· ตั้งไว้แล้ว (••••${stripeSecretKeyStatus.last4})` : "· ยังไม่ได้ตั้งค่า"}
                </span>
              </label>
              <input type={showSecrets ? "text" : "password"} value={stripeSecretKey}
                onChange={e => setStripeSecretKey(e.target.value)}
                placeholder={stripeSecretKeyStatus.set ? "เว้นว่างไว้เพื่อไม่เปลี่ยน หรือกรอกคีย์ใหม่" : "sk_live_xxxx"}
                autoComplete="off"
                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white font-mono placeholder-zinc-600 outline-none focus:border-violet-500/50" />
            </div>
            {/* Webhook Secret — same masked-status pattern as Secret Key above. */}
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">
                Webhook Secret <span className="text-zinc-600">(whsec_...)</span>{" "}
                <span className={stripeWebhookSecretStatus.set ? "text-emerald-500" : "text-amber-500"}>
                  {stripeWebhookSecretStatus.set ? `· ตั้งไว้แล้ว (••••${stripeWebhookSecretStatus.last4})` : "· ยังไม่ได้ตั้งค่า"}
                </span>
              </label>
              <input type={showSecrets ? "text" : "password"} value={stripeWebhookSecret}
                onChange={e => setStripeWebhookSecret(e.target.value)}
                placeholder={stripeWebhookSecretStatus.set ? "เว้นว่างไว้เพื่อไม่เปลี่ยน หรือกรอกคีย์ใหม่" : "whsec_xxxx"}
                autoComplete="off"
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
            <label className="text-xs text-zinc-400 mb-1 block">
              Gemini API Key <span className="text-zinc-600">(AIza...)</span>{" "}
              <span className={serverGeminiKeyStatus.set ? "text-emerald-500" : "text-amber-500"}>
                {serverGeminiKeyStatus.set ? `· ตั้งไว้แล้ว (••••${serverGeminiKeyStatus.last4})` : "· ยังไม่ได้ตั้งค่า"}
              </span>
            </label>
            {/* Value never round-trips from the server (SEC-12) — blank = keep current on save. */}
            <input type={showSecrets ? "text" : "password"} value={serverGeminiKey}
              onChange={e => setServerGeminiKey(e.target.value)}
              placeholder={serverGeminiKeyStatus.set ? "เว้นว่างไว้เพื่อไม่เปลี่ยน หรือกรอกคีย์ใหม่" : "AIzaSyxxxx"}
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
                Hero AI Image · Z-Image RunPod — ฿/รูป
              </label>
              <input
                type="number"
                step="0.0001"
                value={costImageHero1k}
                onChange={e => setCostImageHero1k(e.target.value)}
                placeholder="0.20"
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
      </div>
    </div>
  );
}
