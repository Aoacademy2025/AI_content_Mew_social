"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, Eye, EyeOff, FlaskConical, Trash2, ExternalLink } from "lucide-react";

interface ApiKeys {
  openaiKey?: string;
  geminiKey?: string;
  heygenKey?: string;
  elevenlabsKey?: string;
  pexelsKey?: string;
  pixabayKey?: string;
}
type KeyType = "openai" | "gemini" | "heygen" | "elevenlabs" | "pexels" | "pixabay";
type TestResult = { ok: boolean; message: string } | null;

const KEY_CONFIG: { id: keyof ApiKeys; keyType: KeyType; label: string; placeholder: string; description: string; link?: string }[] = [
  { id: "openaiKey",     keyType: "openai",     label: "OpenAI API Key",     placeholder: "sk-proj-...",               description: "Content, subtitles & style generation",     link: "https://platform.openai.com/api-keys" },
  { id: "geminiKey",     keyType: "gemini",     label: "Gemini API Key",     placeholder: "AIza...",                   description: "Google Gemini — สามารถใช้แทน OpenAI ได้ในทุกฟังก์ชัน",   link: "https://aistudio.google.com/app/apikey" },
  { id: "heygenKey",     keyType: "heygen",     label: "HeyGen API Key",     placeholder: "Enter your HeyGen key",    description: "Avatar video creation",                      link: "https://app.heygen.com/settings?nav=API" },
  { id: "elevenlabsKey", keyType: "elevenlabs", label: "ElevenLabs API Key", placeholder: "Enter your ElevenLabs key",description: "Voice synthesis & cloning",                  link: "https://elevenlabs.io/app/settings/api-keys" },
  { id: "pexelsKey",     keyType: "pexels",     label: "Pexels API Key",     placeholder: "Enter your Pexels key",    description: "Stock video (Pexels)",                       link: "https://www.pexels.com/api/" },
  { id: "pixabayKey",    keyType: "pixabay",    label: "Pixabay API Key",    placeholder: "12345678-abcdef...",        description: "Stock video fallback (Pixabay)",             link: "https://pixabay.com/api/docs/" },
];

const EMPTY_RESULTS: Record<KeyType, TestResult> = { openai: null, gemini: null, heygen: null, elevenlabs: null, pexels: null, pixabay: null };

export function ApiKeySettings() {
  const [loading, setLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testingKey, setTestingKey] = useState<KeyType | null>(null);
  const [testResults, setTestResults] = useState<Record<KeyType, TestResult>>({ ...EMPTY_RESULTS });
  const [dirty, setDirty] = useState(false);

  useEffect(() => { fetchApiKeys(); }, []);

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
      {KEY_CONFIG.map((cfg) => {
        const result = testResults[cfg.keyType];
        const isTesting = testingKey === cfg.keyType;
        const set = isSet(cfg.id);
        return (
          <div key={cfg.id} className="space-y-2">
            <div className="flex items-center justify-between">
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
              {result?.ok && <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 className="h-3.5 w-3.5" /> Verified</span>}
              {result && !result.ok && <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="h-3.5 w-3.5" /> {result.message}</span>}
            </div>
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
