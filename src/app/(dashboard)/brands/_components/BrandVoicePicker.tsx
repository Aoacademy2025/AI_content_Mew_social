"use client";
import { useEffect, useState } from "react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { BrandPayload } from "./types";

type Voice = { voice_id: string; name: string; preview_url?: string | null };
export function BrandVoicePicker({ value, disabled, onChange }: { value: BrandPayload["voice"]; disabled: boolean; onChange: (voice: BrandPayload["voice"]) => void }) {
  const [catalog, setCatalog] = useState<{ provider: string; voices: Voice[] }>({ provider: "", voices: [] });
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (value.provider === "gemini") return;
    const controller = new AbortController();
    fetch(value.provider === "elevenlabs" ? "/api/elevenlabs/voices" : "/api/omnivoice/voices", { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("โหลดรายชื่อเสียงไม่สำเร็จ เสียงที่บันทึกไว้ยังคงเดิม"); return response.json(); })
      .then((body) => { const items = Array.isArray(body) ? body : body.voices; setCatalog({ provider: value.provider, voices: Array.isArray(items) ? items.flatMap((v) => typeof v?.voice_id === "string" && typeof (v.name ?? v.desc) === "string" ? [{ voice_id: v.voice_id, name: v.name ?? v.desc, preview_url: typeof v.preview_url === "string" ? v.preview_url : null }] : []) : [] }); setError(null); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "โหลดเสียงไม่สำเร็จ"); });
    return () => controller.abort();
  }, [value.provider, reload]);
  const voices: Voice[] = value.provider === "gemini" ? GEMINI_VOICES.map((v) => ({ voice_id: v.id, name: v.label })) : catalog.provider === value.provider ? catalog.voices : [];
  const selected = voices.find((voice) => voice.voice_id === value.voiceId);
  const missing = !!value.voiceId && !selected;
  const preview = selected?.preview_url;
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">แหล่งเสียง<select value={value.provider} disabled={disabled} onChange={(event) => onChange({ provider: event.target.value, voiceId: null })} className="mt-2 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"><option value="gemini">เสียง AI</option><option value="elevenlabs">ElevenLabs</option><option value="omnivoice">Hero AI Voice</option></select></label>
      <label className="text-sm">เสียงบรรยาย<select value={value.voiceId ?? ""} disabled={disabled} onChange={(event) => onChange({ ...value, voiceId: event.target.value || null })} className="mt-2 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"><option value="">ใช้ค่าเริ่มต้นบัญชี</option>{missing && <option value={value.voiceId!}>เสียงที่บันทึกไว้</option>}{voices.map((voice) => <option key={voice.voice_id} value={voice.voice_id}>{voice.name}</option>)}</select></label>
    </div>
    {value.provider !== "gemini" && error && <p role="status" className="text-xs leading-5 text-muted-foreground">{error} <button type="button" disabled={disabled} onClick={() => setReload((n) => n + 1)} className="underline underline-offset-4">ลองโหลดอีกครั้ง</button></p>}
    {preview && (preview.startsWith("/api/") || preview.startsWith("https://")) && <audio controls preload="none" src={preview} className="max-w-full" aria-label={`ฟังตัวอย่าง ${selected?.name}`} />}
    <p className="text-xs leading-5 text-muted-foreground">ใช้เป็นค่าเริ่มต้นของคลิปใหม่ เปลี่ยนเสียงรายคลิปได้</p>
  </div>;
}
