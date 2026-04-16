"use client";

import { useState } from "react";
import { Loader2, Key, ExternalLink, Eye, EyeOff, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";

export type RequiredKeyType = "openai" | "gemini" | "elevenlabs" | "heygen" | "pexels" | "pixabay";

const KEY_META: Record<RequiredKeyType, {
  label: string;
  field: string;
  placeholder: string;
  link: string;
  hint: string;
}> = {
  openai:     { label: "OpenAI API Key",     field: "openaiKey",     placeholder: "sk-proj-...",                link: "https://platform.openai.com/api-keys",            hint: "ใช้สำหรับ Keywords, Split-phrases, Transcribe" },
  gemini:     { label: "Gemini API Key",     field: "geminiKey",     placeholder: "AIza...",                    link: "https://aistudio.google.com/app/apikey",          hint: "Google Gemini — ใช้แทน OpenAI ได้" },
  elevenlabs: { label: "ElevenLabs API Key", field: "elevenlabsKey", placeholder: "Enter your ElevenLabs key", link: "https://elevenlabs.io/app/settings/api-keys",     hint: "ใช้สำหรับ TTS Voice synthesis" },
  heygen:     { label: "HeyGen API Key",     field: "heygenKey",     placeholder: "Enter your HeyGen key",     link: "https://app.heygen.com/settings?nav=API",         hint: "ใช้สำหรับสร้าง Avatar video" },
  pexels:     { label: "Pexels API Key",     field: "pexelsKey",     placeholder: "Enter your Pexels key",     link: "https://www.pexels.com/api/",                     hint: "ใช้สำหรับดาวน์โหลด Stock video" },
  pixabay:    { label: "Pixabay API Key",    field: "pixabayKey",    placeholder: "12345678-abcdef...",         link: "https://pixabay.com/api/docs/",                   hint: "ใช้สำหรับดาวน์โหลด Stock video (fallback)" },
};

interface ApiKeyModalProps {
  keyType: RequiredKeyType;
  onClose: () => void;
  onSaved: () => void; // callback to retry the action after saving
}

export function ApiKeyModal({ keyType, onClose, onSaved }: ApiKeyModalProps) {
  const meta = KEY_META[keyType];
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/user/api-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [meta.field]: value.trim() }),
      });
      if (!res.ok) throw new Error();
      toast.success(`บันทึก ${meta.label} แล้ว`);
      onClose();
      onSaved();
    } catch {
      toast.error("บันทึก key ไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-2xl"
        style={{ background: "hsl(221 39% 9%)", border: "1px solid hsl(220 30% 18%)" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid hsl(220 30% 14%)", background: "hsl(190 100% 50% / 0.04)" }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.25)" }}>
              <Key className="h-4 w-4 text-cyan-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">ต้องการ API Key</p>
              <p className="text-[10px] text-white/40">{meta.hint}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-white/70">{meta.label}</label>
              <a href={meta.link} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] text-cyan-400/60 hover:text-cyan-400 transition-colors">
                <ExternalLink className="h-3 w-3" /> Get key
              </a>
            </div>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSave()}
                placeholder={meta.placeholder}
                autoFocus
                className="w-full rounded-xl px-4 py-3 pr-10 text-sm font-mono text-white placeholder:text-white/20 outline-none focus:ring-1 focus:ring-cyan-500/40"
                style={{ background: "hsl(222 47% 7%)", border: "1px solid hsl(220 30% 18%)" }}
              />
              <button type="button" onClick={() => setShow(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={onClose}
              className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white/40 hover:text-white/70 transition-colors"
              style={{ background: "hsl(220 30% 13%)", border: "1px solid hsl(220 30% 18%)" }}>
              ยกเลิก
            </button>
            <button onClick={handleSave} disabled={!value.trim() || saving}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-40 transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, hsl(190 100% 42%), hsl(230 100% 55%))" }}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              บันทึกและลองใหม่
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const VALID_KEYS = new Set<RequiredKeyType>(["openai","gemini","elevenlabs","heygen","pexels","pixabay"]);

/**
 * ตรวจสอบ API response data หรือ error message แล้ว return keyType ที่ต้องการ
 * Priority: data.missingKey field (explicit) > keyword matching in error string
 */
export function detectMissingKeyType(
  errorMessageOrData: string | Record<string, unknown>
): RequiredKeyType | null {
  // If given a JSON object (parsed response body), check missingKey field first
  if (typeof errorMessageOrData === "object" && errorMessageOrData !== null) {
    const mk = errorMessageOrData.missingKey;
    if (typeof mk === "string" && VALID_KEYS.has(mk as RequiredKeyType)) {
      return mk as RequiredKeyType;
    }
    // Fall through to check error string inside the object
    const msg = String(errorMessageOrData.error ?? "").toLowerCase();
    return detectFromString(msg);
  }
  return detectFromString(String(errorMessageOrData).toLowerCase());
}

function detectFromString(msg: string): RequiredKeyType | null {
  if (msg.includes("openai"))     return "openai";
  if (msg.includes("gemini"))     return "gemini";
  if (msg.includes("elevenlabs")) return "elevenlabs";
  if (msg.includes("heygen"))     return "heygen";
  if (msg.includes("pexels"))     return "pexels";
  if (msg.includes("pixabay"))    return "pixabay";
  return null;
}
