"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Loader2, ExternalLink, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { KEY_TIERS, computeKeyStatus, type KeyId } from "@/lib/key-tiers";
import { ApiKeyField } from "@/components/onboarding/ApiKeyField";
import { fetchMe } from "@/lib/use-me";

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

const EMPTY_RESULTS: Record<KeyType, TestResult> = { gemini: null, heygen: null, elevenlabs: null, pexels: null, pixabay: null, kie: null, unsplash: null, flickr: null };

export function ApiKeySettings() {
  const [loading, setLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [testingKey, setTestingKey] = useState<KeyType | null>(null);
  const [testResults, setTestResults] = useState<Record<KeyType, TestResult>>({ ...EMPTY_RESULTS });
  const [dirty, setDirty] = useState(false);
  const [geminiGuideOpen, setGeminiGuideOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    fetchApiKeys();
    // ช่อง adminOnly โชว์เฉพาะ ADMIN — user ทั่วไปไม่เห็น
    fetchMe().then(d => setIsAdmin(d?.role === "ADMIN")).catch(() => {});
    // managed mode: hide Gemini surfaces when server manages the key
    fetch("/api/user/api-keys/status", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.managed) setManaged(true); })
      .catch(() => {});
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
    const def = KEY_TIERS.find(k => k.apiKeysField === id);
    if (def) setTestResults(prev => ({ ...prev, [def.testKeyType as KeyType]: null }));
  }

  async function handleTestKey(keyType: KeyType) {
    setTestingKey(keyType);
    setTestResults(prev => ({ ...prev, [keyType]: null }));
    try {
      // Save the current value for this key first so the test always reflects what's in the input
      const def = KEY_TIERS.find((k) => k.testKeyType === keyType);
      if (def) {
        const putRes = await fetch("/api/user/api-keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [def.apiKeysField]: apiKeys[def.apiKeysField] ?? "" }) });
        if (!putRes.ok) { setTestResults((prev) => ({ ...prev, [keyType]: { ok: false, message: "บันทึก key ไม่สำเร็จ ลองใหม่อีกครั้ง" } })); setTestingKey(null); return; }
      }
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
      const def = KEY_TIERS.find(k => k.apiKeysField === id);
      if (def) setTestResults(prev => ({ ...prev, [def.testKeyType as KeyType]: null }));
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
      {/* Gemini onboarding guide — collapsible, shown above the Gemini key row (hidden when managed) */}
      {!managed && <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
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
                  className="text-violet-400 underline underline-offset-2 hover:text-violet-300 inline-flex items-center gap-1">
                  aistudio.google.com/apikey <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                เข้า{" "}
                <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer"
                  className="text-violet-400 underline underline-offset-2 hover:text-violet-300 inline-flex items-center gap-1">
                  Cloud Console <ExternalLink className="h-3 w-3" />
                </a>{" "}
                แล้วกด <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 font-mono text-[11px]">Enable</span> Gemini key
              </li>
              <li>
                ถ้าต้องการใช้งานหลายคลิปต่อเนื่อง ให้ผูกบัตร Google ใน project เดียวกับ key เพื่อเพิ่มโควต้า
              </li>
            </ol>
            <div className="rounded-lg bg-violet-500/10 border border-violet-500/25 px-3 py-2 text-[11px] text-violet-100/90 leading-relaxed">
              <span className="font-semibold">แนะนำสำหรับ PRO:</span>{" "}
              ใช้ Gemini key ที่ผูกบัตร Google แล้ว เพราะโควต้าฟรีมีจำกัดและอาจหมดตอนสร้างเสียง ถอดซับ หรือหา keyword
            </div>
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-[11px] text-amber-200/90 leading-relaxed">
              <span className="font-semibold">ถ้า Test ขึ้น "Generative Language API ยังไม่ได้เปิด":</span>{" "}
              เข้า{" "}
              <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer"
                className="text-violet-400 underline underline-offset-2 hover:text-violet-300 inline-flex items-center gap-1">
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
      </div>}

      {(() => {
        const status = computeKeyStatus({
          gemini: isSet("geminiKey"), pexels: isSet("pexelsKey"), pixabay: isSet("pixabayKey"),
          elevenlabs: isSet("elevenlabsKey"), heygen: isSet("heygenKey"),
        }, managed);
        const field = (id: KeyId) => {
          const def = KEY_TIERS.find((k) => k.id === id)!;
          return (
            <ApiKeyField
              key={def.id} def={def}
              value={apiKeys[def.apiKeysField] || ""}
              isSaved={isSet(def.apiKeysField)}
              onChange={(v) => updateKey(def.apiKeysField, v)}
              onTest={() => handleTestKey(def.testKeyType as KeyType)}
              testResult={testResults[def.testKeyType as KeyType]}
              testing={testingKey === (def.testKeyType as KeyType)}
              onDelete={() => handleDelete(def.apiKeysField)}
            />
          );
        };
        return (
          <>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium"
              style={{ color: status.tier1Complete ? "rgb(110 231 183)" : "rgb(252 211 77)" }}>
              {status.tier1Complete ? "✓ พร้อมสร้างวิดีโอ" : "ตั้งค่าจำเป็นให้ครบเพื่อเริ่มสร้างวิดีโอ"}
            </div>

            <div className="text-xs font-semibold uppercase tracking-wide text-violet-200">จำเป็น</div>
            {!managed && field("gemini")}
            {field("pexels")}
            {field("pixabay")}

            <button type="button" onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5">
              <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              ขั้นสูง (ไม่บังคับ) — ไม่ใส่ก็ใช้งานได้
            </button>
            {advancedOpen && (<>{field("elevenlabs")}{field("heygen")}</>)}

            {isAdmin && (
              <>
                <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-fuchsia-200">
                  Admin — แหล่งภาพทดลอง (ซ่อนจาก user)
                </div>
                {field("kie")}
                {field("unsplash")}
                {field("flickr")}
              </>
            )}
          </>
        );
      })()}

      <div className="flex items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--ui-divider)" }}>
        <button type="button" onClick={handleDiscard} disabled={!dirty}
          className="rounded-lg px-4 py-2 text-sm transition-colors hover:opacity-80 disabled:opacity-30"
          style={{ color: "var(--ui-text-muted)" }}>
          Discard
        </button>
        <button type="button" onClick={handleSave} disabled={loading || !dirty}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save Settings
        </button>
      </div>
    </div>
  );
}
