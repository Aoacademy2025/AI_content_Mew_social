"use client";

import { useState } from "react";
import { toast } from "sonner";
import { X, ExternalLink, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { requiredKeysFor, ADVANCED_KEYS, KEY_TIERS, type KeyId } from "@/lib/key-tiers";
import { ApiKeyField } from "./ApiKeyField";

type TestResult = { ok: boolean; message: string } | null;

export function KeyOnboardingWizard({
  open, onClose, onComplete, startKeyId, managed = false,
}: { open: boolean; onClose: () => void; onComplete: () => void; startKeyId?: KeyId; managed?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(startKeyId && ADVANCED_KEYS.some((k) => k.id === startKeyId)));

  if (!open) return null;

  function setValue(id: string, v: string) {
    setValues((p) => ({ ...p, [id]: v }));
    setResults((p) => ({ ...p, [id]: null }));
  }

  async function test(id: KeyId, testKeyType: string) {
    setTesting(id);
    try {
      // save first so the server can read the key, then test (test-key reads stored key)
      const putRes = await fetch("/api/user/api-keys", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [KEY_TIERS.find((k) => k.id === id)!.apiKeysField]: values[id] ?? "" }),
      });
      if (!putRes.ok) { setResults((p) => ({ ...p, [id]: { ok: false, message: "บันทึก key ไม่สำเร็จ ลองใหม่อีกครั้ง" } })); return; }
      const res = await fetch("/api/user/test-key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyType: testKeyType }),
      });
      const result = await res.json();
      setResults((p) => ({ ...p, [id]: result }));
    } catch {
      setResults((p) => ({ ...p, [id]: { ok: false, message: "เชื่อมต่อไม่สำเร็จ" } }));
    } finally {
      setTesting(null);
    }
  }

  async function saveAll() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const def of KEY_TIERS) {
        const v = values[def.id];
        if (v != null && v.length > 0) payload[def.apiKeysField] = v;
      }
      if (Object.keys(payload).length > 0) {
        const r = await fetch("/api/user/api-keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error("save failed");
      }
      toast.success("บันทึก API key แล้ว");
      onComplete();
    } catch {
      toast.error("บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    try { await fetch("/api/user/onboarding/dismiss", { method: "POST" }); } catch { /* fail-open */ }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-210 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#0c1018] p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-300" />
            <h2 className="text-lg font-semibold text-white">เริ่มต้นใช้ HERO AI</h2>
          </div>
          <button type="button" onClick={skip} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-sm text-slate-400">ตั้งแค่ 2 อย่างก็เริ่มสร้างวิดีโอได้เลย</p>

        <div className="mt-5 space-y-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-violet-200">จำเป็น</div>
          {requiredKeysFor(managed).map((def) => (
            <ApiKeyField key={def.id} def={def} value={values[def.id] ?? ""} isSaved={false}
              onChange={(v) => setValue(def.id, v)} onTest={() => test(def.id, def.testKeyType)}
              testResult={results[def.id] ?? null} testing={testing === def.id} />
          ))}

          <button type="button" onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5">
            <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            ขั้นสูง (ไม่บังคับ) — ไม่ใส่ก็ใช้งานได้
          </button>
          {showAdvanced && ADVANCED_KEYS.map((def) => (
            <ApiKeyField key={def.id} def={def} value={values[def.id] ?? ""} isSaved={false}
              onChange={(v) => setValue(def.id, v)} onTest={() => test(def.id, def.testKeyType)}
              testResult={results[def.id] ?? null} testing={testing === def.id} />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={skip} className="text-sm text-slate-400 hover:text-white">ข้ามก่อน</button>
          <button type="button" onClick={saveAll} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} บันทึกแล้วเริ่มเลย
          </button>
        </div>
        {!managed && (
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">
            ขอ Gemini key ฟรี <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}
