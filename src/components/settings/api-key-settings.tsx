"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, Eye, EyeOff, FlaskConical, Trash2, ExternalLink, ChevronDown, ChevronUp, Sparkles } from "lucide-react";

interface ApiKeys {
  geminiKey?: string;
  heygenKey?: string;
  elevenlabsKey?: string;
  pexelsKey?: string;
  pixabayKey?: string;
  kieKey?: string;
  unsplashKey?: string;
  flickrKey?: string;
}
type KeyType = "gemini" | "heygen" | "elevenlabs" | "pexels" | "pixabay" | "kie" | "unsplash" | "flickr";
type TestResult = { ok: boolean; message: string } | null;

const KEY_CONFIG: { id: keyof ApiKeys; keyType: KeyType; label: string; placeholder: string; description: string; link?: string; adminOnly?: boolean }[] = [
  { id: "geminiKey",     keyType: "gemini",     label: "Gemini API Key",     placeholder: "AIza... หรือ AQ.",          description: "Google Gemini — ใช้สำหรับเสียง, ถอดซับ, keyword และ AI หลัก แนะนำผูกบัตร Google เพื่อเพิ่มโควต้า",   link: "https://aistudio.google.com/app/apikey" },
  { id: "heygenKey",     keyType: "heygen",     label: "HeyGen API Key",     placeholder: "Enter your HeyGen key",    description: "Avatar video creation",                      link: "https://app.heygen.com/settings?nav=API" },
  { id: "elevenlabsKey", keyType: "elevenlabs", label: "ElevenLabs API Key", placeholder: "Enter your ElevenLabs key",description: "Voice synthesis & cloning",                  link: "https://elevenlabs.io/app/settings/api-keys" },
  { id: "pexelsKey",     keyType: "pexels",     label: "Pexels API Key",     placeholder: "Enter your Pexels key",    description: "Stock video (Pexels)",                       link: "https://www.pexels.com/api/" },
  { id: "pixabayKey",    keyType: "pixabay",    label: "Pixabay API Key",    placeholder: "12345678-abcdef...",        description: "Stock video fallback (Pixabay)",             link: "https://pixabay.com/api/docs/" },
  // AI Image-to-Video (kie.ai) — ทดลองภายใน admin เท่านั้น (ซ่อนจาก user ทั่วไป)
  { id: "kieKey",        keyType: "kie",        label: "kie.ai API Key",        placeholder: "Enter your kie.ai key",   description: "AI Image-to-Video (GPT Image + Kling) — admin only", link: "https://kie.ai/api-key", adminOnly: true },
  // Auto Mix fallback image source — ทดลองภายใน admin เท่านั้น (ซ่อนจาก user ทั่วไป)
  { id: "unsplashKey",   keyType: "unsplash",   label: "Unsplash Access Key",   placeholder: "Enter your Unsplash Access Key", description: "Auto Mix fallback photo source (Ken Burns) — admin only", link: "https://unsplash.com/oauth/applications", adminOnly: true },
  { id: "flickrKey",     keyType: "flickr",     label: "Flickr API Key",        placeholder: "Enter your Flickr API key", description: "Auto Mix fallback photo source — Creative Commons (Ken Burns) — admin only", link: "https://www.flickr.com/services/apps/create/apply/", adminOnly: true },
];

const EMPTY_RESULTS: Record<KeyType, TestResult> = { gemini: null, heygen: null, elevenlabs: null, pexels: null, pixabay: null, kie: null, unsplash: null, flickr: null };

export function ApiKeySettings() {
  const [loading, setLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testingKey, setTestingKey] = useState<KeyType | null>(null);
  const [testResults, setTestResults] = useState<Record<KeyType, TestResult>>({ ...EMPTY_RESULTS });
  const [dirty, setDirty] = useState(false);
  const [geminiGuideOpen, setGeminiGuideOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetchApiKeys();
    // ช่อง adminOnly โชว์เฉพาะ ADMIN — user ทั่วไปไม่เห็น
    fetch("/api/user/me").then(r => r.json()).then(d => setIsAdmin(d?.role === "ADMIN")).catch(() => {});
  }, []);

  // Sync ข้ามจุดที่ component นี้ถูกใช้ (popup ใน editor / หน้า Settings) —
  // กลับมาโฟกัสเมื่อไหร่ refetch ใหม่ ถ้าไม่มีการแก้ค้างอยู่ จะได้ไม่ทับของที่พิมพ์
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const onFocus = () => { if (!dirtyRef.current) fetchApiKeys(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function fetchApiKeys() {
    try {
      const res = await fetch("/api/user/api-keys");
      if (res.ok) setApiKeys(await res.json());
    } catch { /* silent */ }
  }

  function isSet(key: keyof ApiKeys) { return !!(apiKeys[key] && String(apiKeys[key]).length > 0); }

  function updateKey(id: keyof ApiKeys, value: string) {
    setApiKeys(prev => ({ ...prev, [id]: value }));
    setDirty(true);
    const cfg = KEY_CONFIG.find(k => k.id === id);
    if (cfg) setTestResults(prev => ({ ...prev, [cfg.keyType]: null }));
  }

  async function handleTestKey(keyType: KeyType) {
    setTestingKey(keyType);
    setTestResults(prev => ({ ...prev, [keyType]: null }));
    try {
      const res = await fetch("/api/user/test-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyType }) });
      const result = await res.json();
      setTestResults(prev => ({ ...prev, [keyType]: result }));
    } catch { setTestResults(prev => ({ ...prev, [keyType]: { ok: false, message: "Connection failed" } })); }
    finally { setTestingKey(null); }
  }

  async function handleDelete(id: keyof ApiKeys) {
    const updated = { ...apiKeys, [id]: "" };
    setApiKeys(updated);
    setDirty(false);
    try {
      const res = await fetch("/api/user/api-keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated) });
      if (!res.ok) throw new Error();
      toast.success("API Key removed");
      const cfg = KEY_CONFIG.find(k => k.id === id);
      if (cfg) setTestResults(prev => ({ ...prev, [cfg.keyType]: null }));
    } catch { toast.error("Failed to remove key"); }
  }

  async function handleSave() {
    setLoading(true);
    try {
      const res = await fetch("/api/user/api-keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(apiKeys) });
      if (!res.ok) throw new Error();
      toast.success("API Keys saved");
      setDirty(false);
      setTestResults({ ...EMPTY_RESULTS });
    } catch { toast.error("Failed to save"); }
    finally { setLoading(false); }
  }

  function handleDiscard() {
    fetchApiKeys();
    setDirty(false);
    setTestResults({ ...EMPTY_RESULTS });
  }

  return (
    <div className="space-y-5">
      {/* Gemini onboarding guide — collapsible, shown above the Gemini key row */}
      <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
        <button type="button" onClick={() => setGeminiGuideOpen(v => !v)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-violet-500/10 transition-colors text-left">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20 border border-violet-500/30 shrink-0">
            <Sparkles className="h-3.5 w-3.5 text-violet-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-violet-200">ตั้งค่า Gemini API Key ให้พร้อมใช้งาน</div>
            <div className="text-[11px] text-violet-300/60 mt-0.5">ใช้สำหรับเสียง, ถอดซับ, keyword และ AI หลักของระบบ</div>
          </div>
          {geminiGuideOpen ? <ChevronUp className="h-4 w-4 text-violet-300/70 shrink-0" /> : <ChevronDown className="h-4 w-4 text-violet-300/70 shrink-0" />}
        </button>
        {geminiGuideOpen && (
          <div className="px-4 pb-4 pt-1 space-y-3 text-[12px] text-slate-300 leading-relaxed">
            <ol className="space-y-2 list-decimal list-inside marker:text-violet-400 marker:font-bold">
              <li>
                สร้าง key ที่{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
                  className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300 inline-flex items-center gap-1">
                  aistudio.google.com/apikey <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                เข้า{" "}
                <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer"
                  className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300 inline-flex items-center gap-1">
                  Cloud Console <ExternalLink className="h-3 w-3" />
                </a>{" "}
                แล้วกด <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 font-mono text-[11px]">Enable</span> Gemini key
              </li>
              <li>
                ถ้าต้องการใช้งานหลายคลิปต่อเนื่อง ให้ผูกบัตร Google ใน project เดียวกับ key เพื่อเพิ่มโควต้า
              </li>
            </ol>
            <div className="rounded-lg bg-cyan-500/10 border border-cyan-500/25 px-3 py-2 text-[11px] text-cyan-100/90 leading-relaxed">
              <span className="font-semibold">แนะนำสำหรับ PRO:</span>{" "}
              ใช้ Gemini key ที่ผูกบัตร Google แล้ว เพราะโควต้าฟรีมีจำกัดและอาจหมดตอนสร้างเสียง ถอดซับ หรือหา keyword
            </div>
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-[11px] text-amber-200/90 leading-relaxed">
              <span className="font-semibold">ถ้า Test ขึ้น "Generative Language API ยังไม่ได้เปิด":</span>{" "}
              เข้า{" "}
              <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer"
                className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300 inline-flex items-center gap-1">
                Google Cloud Console <ExternalLink className="h-3 w-3" />
              </a>{" "}
              → กดปุ่ม <span className="font-mono text-amber-100">Enable</span> → รอ 1-2 นาที แล้วลอง Test ใหม่
            </div>
            <div className="rounded-lg bg-slate-500/10 border border-slate-500/20 px-3 py-2 text-[11px] text-slate-400 leading-relaxed">
              <span className="font-semibold text-slate-300">หมายเหตุ:</span> Gemini TTS เป็น preview model ที่ Google ฝั่ง server ยังไม่ stable —
              ถ้า Test ผ่าน text แต่ TTS fail ทุก model ให้สลับใช้ ElevenLabs สำหรับ voice generation ไปก่อน
            </div>
          </div>
        )}
      </div>

      {KEY_CONFIG.filter(cfg => !cfg.adminOnly || isAdmin).map((cfg) => {
        const result = testResults[cfg.keyType];
        const isTesting = testingKey === cfg.keyType;
        const set = isSet(cfg.id);
        return (
          <div key={cfg.id} className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{cfg.label}</label>
                {cfg.link && (
                  <a href={cfg.link} target="_blank" rel="noopener noreferrer"
                    className="transition-colors hover:text-cyan-400" style={{ color: "var(--ui-text-muted)" }}>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              {set && !result && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-400"
                  style={{ background: "hsl(142 72% 29% / 0.15)", border: "1px solid hsl(142 72% 29% / 0.3)" }}>
                  Active
                </span>
              )}
              {result?.ok && <span className="flex items-start gap-1 text-xs text-green-400"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /> <span className="leading-snug">{result.message}</span></span>}
            </div>
            {/* Error result — given its own row so longer messages wrap readably */}
            {result && !result.ok && (
              <div className="flex items-start gap-1.5 text-xs text-red-400 px-2 py-1.5 rounded-lg bg-red-500/5 border border-red-500/20">
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="leading-snug">{result.message}</span>
              </div>
            )}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKeys[cfg.id] ? "text" : "password"}
                  value={apiKeys[cfg.id] || ""}
                  onChange={e => updateKey(cfg.id, e.target.value)}
                  placeholder={cfg.placeholder}
                  className="border-0 pr-16 font-mono text-xs focus-visible:ring-1 focus-visible:ring-cyan-500/50"
                  style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                  <button type="button" onClick={() => setShowKeys(p => ({ ...p, [cfg.id]: !p[cfg.id] }))}
                    className="transition-colors hover:text-cyan-400" style={{ color: "var(--ui-text-muted)" }}>
                    {showKeys[cfg.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  {set && (
                    <button type="button" onClick={() => handleDelete(cfg.id)}
                      className="transition-colors hover:text-red-400" style={{ color: "var(--ui-text-muted)" }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <button type="button" disabled={!set || isTesting} onClick={() => handleTestKey(cfg.keyType)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all hover:opacity-80 disabled:opacity-30"
                style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}>
                {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                Test
              </button>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--ui-divider)" }}>
        <button type="button" onClick={handleDiscard} disabled={!dirty}
          className="rounded-lg px-4 py-2 text-sm transition-colors hover:opacity-80 disabled:opacity-30"
          style={{ color: "var(--ui-text-muted)" }}>
          Discard
        </button>
        <button type="button" onClick={handleSave} disabled={loading || !dirty}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save Settings
        </button>
      </div>
    </div>
  );
}
