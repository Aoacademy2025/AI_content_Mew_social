"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GEMINI_VOICES, resolveGeminiVoiceId } from "@/lib/gemini-voices";
import { describeVoiceCatalogFailure, shouldFallBackToGemini, type VoiceCatalogFailure } from "@/lib/brand-voice-catalog";
import { VoicePreviewButton } from "@/app/(dashboard)/video-editor/_components/VoicePreviewButton";
import type { TtsProvider } from "@/lib/tts-providers";
import type { BrandPayload } from "./types";

type Voice = { voice_id: string; name: string; meta?: string; preview_url?: string | null };

export function BrandVoicePicker({
  value,
  disabled,
  allowElevenLabs = true,
  onChange,
}: {
  value: BrandPayload["voice"];
  disabled: boolean;
  allowElevenLabs?: boolean;
  onChange: (voice: BrandPayload["voice"]) => void;
}) {
  const [catalog, setCatalog] = useState<{ provider: string; voices: Voice[] }>({ provider: "", voices: [] });
  const [failure, setFailure] = useState<VoiceCatalogFailure | null>(null);
  const [fellBackFrom, setFellBackFrom] = useState<string | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Latest saved voice + change handler without making them effect dependencies:
  // the catalog should refetch when the provider changes or the user retries, not
  // on every voice selection or parent render.
  const latest = useRef({ voiceId: value.voiceId, onChange });
  useEffect(() => { latest.current = { voiceId: value.voiceId, onChange }; });

  useEffect(() => {
    if (value.provider !== "elevenlabs" && value.provider !== "omnivoice") return;
    const provider = value.provider;
    const controller = new AbortController();
    fetch(provider === "elevenlabs" ? "/api/elevenlabs/voices" : "/api/omnivoice/voices", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const described = describeVoiceCatalogFailure({ provider, status: response.status, body });
          if (shouldFallBackToGemini(described, latest.current.voiceId)) {
            // HERO-32: nothing is saved on this provider and the account cannot use it —
            // move the brand to the voice that works instead of showing a dead end.
            setFellBackFrom(described.message);
            setFailure(null);
            latest.current.onChange({ ...value, provider: "gemini", voiceId: null });
            return null;
          }
          setFailure(described);
          return null;
        }
        return body;
      })
      .then((body) => {
        if (body === null) return;
        const items = Array.isArray(body) ? body : body?.voices;
        setCatalog({
          provider,
          voices: Array.isArray(items)
            ? items.flatMap((v) =>
                typeof v?.voice_id === "string" && typeof (v.name ?? v.desc) === "string"
                  ? [{ voice_id: v.voice_id, name: v.name ?? v.desc, preview_url: typeof v.preview_url === "string" ? v.preview_url : null }]
                  : [],
              )
            : [],
        });
        setFailure(null);
        setFellBackFrom(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailure(describeVoiceCatalogFailure({ provider, status: null }));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only on provider switch or explicit retry
  }, [value.provider, reload]);

  const voices: Voice[] = value.provider === "gemini"
    ? GEMINI_VOICES.map((v) => ({ voice_id: v.id, name: `${v.label} — ${v.gender} · ${v.style}` }))
    : catalog.provider === value.provider
      ? catalog.voices
      : [];
  const selected = voices.find((voice) => voice.voice_id === value.voiceId);
  const missing = !!value.voiceId && !selected;
  const ttsProvider: TtsProvider = value.provider === "elevenlabs" || value.provider === "omnivoice" ? value.provider : "gemini";
  const resolvedGeminiId = resolveGeminiVoiceId(value.voiceId ?? undefined);
  const canPreview = ttsProvider === "gemini"
    || (ttsProvider === "elevenlabs" && Boolean(value.voiceId?.trim()))
    || (ttsProvider === "omnivoice" && Boolean(selected?.preview_url));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-foreground">
          แหล่งเสียง
          <select
            value={value.provider}
            disabled={disabled}
            onChange={(event) => {
              setFellBackFrom(null);
              setPlanNotice(null);
              onChange({ ...value, provider: event.target.value, voiceId: null });
            }}
            className="mt-2 block min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="gemini">Gemini AI (ฟรี · ใช้ได้ทันที)</option>
            <option value="omnivoice">Hero AI Voice</option>
            <option value="elevenlabs">
              {allowElevenLabs ? "ElevenLabs" : "ElevenLabs (PRO)"}
            </option>
          </select>
        </label>

        <label className="text-sm font-medium text-foreground">
          เสียงบรรยาย
          <select
            value={value.voiceId ?? ""}
            disabled={disabled}
            onChange={(event) => {
              setPlanNotice(null);
              onChange({ ...value, voiceId: event.target.value || null });
            }}
            className="mt-2 block min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">ใช้ค่าเริ่มต้นบัญชี</option>
            {missing && <option value={value.voiceId!}>เสียงที่บันทึกไว้</option>}
            {voices.map((voice) => (
              <option key={voice.voice_id} value={voice.voice_id}>
                {voice.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Inline listen preview */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/25 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">ฟังตัวอย่างเสียงก่อนบันทึก</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {ttsProvider === "gemini"
              ? `ทดสอบเสียง ${GEMINI_VOICES.find((v) => v.id === resolvedGeminiId)?.label ?? resolvedGeminiId} ทันที ไม่ใช้เครดิตคลิป`
              : canPreview
                ? `ฟังตัวอย่างเสียง ${selected?.name ?? value.voiceId}`
                : "เลือกเสียงด้านบนก่อนเพื่อฟังตัวอย่าง"}
          </p>
        </div>
        {canPreview && (
          <div className="w-full shrink-0 sm:w-[144px]">
            <VoicePreviewButton
              className="mt-0"
              provider={ttsProvider}
              geminiVoiceName={resolvedGeminiId}
              geminiVoiceStyle={value.geminiVoiceStyle ?? "neutral"}
              voiceId={value.voiceId ?? ""}
              omniVoiceId={value.voiceId ?? "voice_01"}
              omniPreviewUrl={selected?.preview_url ?? undefined}
              onPlanError={(msg) => setPlanNotice(msg)}
            />
          </div>
        )}
      </div>

      {planNotice && (
        <p role="status" className="text-xs leading-5 text-amber-400">
          {planNotice}{" "}
          <Link href="/pricing?source=brand_voice" className="font-semibold underline underline-offset-4">
            ดูแผน PRO
          </Link>
        </p>
      )}

      {!allowElevenLabs && value.provider === "elevenlabs" && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          เสียง ElevenLabs ใช้ได้กับแผน PRO ขึ้นไป{" "}
          <Link href="/pricing?source=brand_voice" className="font-semibold text-violet-400 underline underline-offset-4">
            ดูแผนรายเดือน
          </Link>
        </p>
      )}

      {value.provider === "gemini" && fellBackFrom && (
        <p role="status" data-testid="brand-voice-fallback" className="text-xs leading-5 text-muted-foreground">
          สลับเป็น &quot;เสียง AI&quot; ให้แล้ว — {fellBackFrom}
        </p>
      )}

      {value.provider !== "gemini" && failure && (
        <p role="status" data-testid="brand-voice-failure" className="text-xs leading-5 text-muted-foreground">
          {failure.message}
          {failure.action && <> <Link href={failure.action.href} className="underline underline-offset-4">{failure.action.label}</Link></>}
          {failure.retryable && (
            <>{" "}
              <button
                type="button"
                disabled={disabled}
                onClick={() => setReload((n) => n + 1)}
                className="underline underline-offset-4"
              >
                ลองโหลดอีกครั้ง
              </button>
            </>
          )}
        </p>
      )}

      <p className="text-xs leading-5 text-muted-foreground">ใช้เป็นค่าเริ่มต้นของคลิปใหม่ เปลี่ยนเสียงรายคลิปได้</p>
    </div>
  );
}
