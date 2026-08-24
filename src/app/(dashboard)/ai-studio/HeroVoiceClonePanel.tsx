"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Loader2,
  Mic,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";

import { customerApiErrorMessage } from "@/lib/customer-api-error";

type CloneVoice = {
  id: string;
  voiceId: string;
  name: string;
  durationMs: number;
  createdAt: string;
  previewUrl: string;
};

type Props = {
  maxScriptChars: number;
  onJobCreated: (job: unknown) => void;
  onVoicesChanged: () => Promise<void>;
};

const ACCENT = "#8B5CF6";
const REF_MIN_SEC = 5;
const REF_MAX_SEC = 15;
// Leave headroom for MediaRecorder's final chunk so the normalized server-side
// result does not drift a few milliseconds beyond the worker's 15s ceiling.
const REF_AUTO_STOP_SEC = 14.5;

function apiMessage(data: unknown, fallback: string): string {
  return customerApiErrorMessage(data, fallback);
}

async function readAudioDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = document.createElement("audio");
      const timeout = window.setTimeout(() => resolve(null), 8_000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      };
      audio.onerror = () => {
        window.clearTimeout(timeout);
        resolve(null);
      };
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function HeroVoiceClonePanel({ maxScriptChars, onJobCreated, onVoicesChanged }: Props) {
  const [voices, setVoices] = useState<CloneVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [name, setName] = useState("");
  const [refText, setRefText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileDurationSec, setFileDurationSec] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [script, setScript] = useState("");
  const [speed, setSpeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<number | null>(null);

  const loadVoices = useCallback(async () => {
    const response = await fetch("/api/omnivoice/user-voices", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) {
      throw new Error(apiMessage(data, "โหลดเสียงโคลนไม่สำเร็จ"));
    }
    const next = data as CloneVoice[];
    setVoices(next);
    setSelectedVoiceId((current) => next.some((voice) => voice.voiceId === current)
      ? current
      : next[0]?.voiceId ?? "");
  }, []);

  useEffect(() => {
    loadVoices()
      .catch((error) => toast.error(error instanceof Error ? error.message : "โหลดเสียงโคลนไม่สำเร็จ"))
      .finally(() => setLoadingVoices(false));
  }, [loadVoices]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  useEffect(() => () => {
    if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stream.getTracks().forEach((track) => track.stop());
      try { recorder.stop(); } catch {}
    }
  }, []);

  async function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setFileDurationSec(null);
    if (!nextFile) return;
    if (nextFile.size > 15 * 1024 * 1024) {
      toast.error("ไฟล์เสียงใหญ่เกิน 15 MB");
      setFile(null);
      return;
    }
    const duration = await readAudioDuration(nextFile);
    setFileDurationSec(duration);
    if (duration !== null && (duration < REF_MIN_SEC || duration > REF_MAX_SEC)) {
      toast.error(`เลือกเสียงที่ยาว ${REF_MIN_SEC}–${REF_MAX_SEC} วินาที`);
    }
  }

  async function startRecording() {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("เบราว์เซอร์นี้ยังไม่รองรับการอัดเสียง กรุณาเลือกไฟล์เสียงแทน");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      toast.error("เข้าถึงไมโครโฟนไม่ได้ กรุณาอนุญาตการใช้ไมค์แล้วลองใหม่");
      return;
    }

    const preferredMime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
      .find((mime) => MediaRecorder.isTypeSupported(mime));
    const recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onstop = () => {
      if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
      const elapsedSec = (Date.now() - startedAt) / 1_000;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (!blob.size) {
        toast.error("อัดเสียงไม่สำเร็จ กรุณาลองใหม่");
        return;
      }
      const extension = recorder.mimeType.includes("mp4") ? "m4a" : "webm";
      setFile(new File([blob], `hero-voice-reference.${extension}`, { type: blob.type }));
      setFileDurationSec(elapsedSec);
      if (elapsedSec < REF_MIN_SEC) toast.error("เสียงสั้นเกินไป กรุณาอัดอย่างน้อย 5 วินาที");
    };
    setRecordSec(0);
    setRecording(true);
    recorder.start(250);
    recordTimerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1_000;
      setRecordSec(Math.min(elapsed, REF_MAX_SEC));
      if (elapsed >= REF_AUTO_STOP_SEC) stopRecording();
    }, 200);
  }

  async function uploadVoice(event: FormEvent) {
    event.preventDefault();
    if (!file || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("name", name);
      form.set("refText", refText);
      form.set("audio", file);
      form.set("consent", consent ? "true" : "false");
      const response = await fetch("/api/omnivoice/user-voices", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงโคลนไม่สำเร็จ"));
      setName("");
      setRefText("");
      setFile(null);
      setFileDurationSec(null);
      setConsent(false);
      setSelectedVoiceId((data as CloneVoice).voiceId);
      await Promise.all([loadVoices(), onVoicesChanged()]);
      toast.success("บันทึกเสียงโคลนแล้ว พร้อมนำไปสร้างเสียง");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างเสียงโคลนไม่สำเร็จ");
    } finally {
      setUploading(false);
    }
  }

  async function deleteVoice(voice: CloneVoice) {
    if (!window.confirm(`ลบ “${voice.name}” และไฟล์เสียงอ้างอิงออกจากระบบใช่ไหม?`)) return;
    setDeletingId(voice.id);
    try {
      const response = await fetch(`/api/omnivoice/user-voices/${encodeURIComponent(voice.id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "ลบเสียงโคลนไม่สำเร็จ"));
      await Promise.all([loadVoices(), onVoicesChanged()]);
      toast.success("ลบเสียงโคลนและไฟล์อ้างอิงแล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ลบเสียงโคลนไม่สำเร็จ");
    } finally {
      setDeletingId(null);
    }
  }

  async function generateClone(event: FormEvent) {
    event.preventDefault();
    if (!selectedVoiceId || !script.trim() || generating) return;
    setGenerating(true);
    try {
      const response = await fetch("/api/ai-studio/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: script,
          voiceId: selectedVoiceId,
          speed,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "ส่งงานสร้างเสียงโคลนไม่สำเร็จ"));
      onJobCreated(data.job);
      setScript("");
      toast.success("ส่งงานเสียงโคลนเข้า Hero Voice แล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ส่งงานสร้างเสียงโคลนไม่สำเร็จ");
    } finally {
      setGenerating(false);
    }
  }

  const invalidDuration = fileDurationSec !== null
    && (fileDurationSec < REF_MIN_SEC || fileDurationSec > REF_MAX_SEC);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl p-5 md:p-6" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "rgba(139,92,246,.12)", color: "#B9A6FF" }}>
            <Mic className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สร้างเสียงโคลนของฉัน</h2>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
              อัดหรืออัปโหลดเสียงพูดชัดเจน 5–15 วินาที แล้วพิมพ์ข้อความที่พูดให้ตรงคำต่อคำ
            </p>
          </div>
        </div>

        {loadingVoices ? (
          <div className="mt-4 flex h-16 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" style={{ color: ACCENT }} /></div>
        ) : voices.length > 0 ? (
          <ul className="mt-5 grid gap-2" aria-label="เสียงโคลนที่บันทึกไว้">
            {voices.map((voice) => (
              <li key={voice.id} className="grid gap-3 rounded-xl p-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_44px] sm:items-center" style={{ border: "1px solid var(--ui-divider)" }}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>{voice.name}</p>
                  <p className="mt-0.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{(voice.durationMs / 1_000).toFixed(1)} วินาที · ส่วนตัว</p>
                </div>
                <audio controls preload="none" src={voice.previewUrl} className="h-9 w-full" aria-label={`ฟังเสียงอ้างอิง ${voice.name}`} />
                <button
                  type="button"
                  onClick={() => void deleteVoice(voice)}
                  disabled={deletingId === voice.id}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  aria-label={`ลบเสียง ${voice.name}`}
                >
                  {deletingId === voice.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 rounded-xl border border-dashed px-4 py-5 text-center text-xs" style={{ borderColor: "var(--ui-divider)", color: "var(--ui-text-muted)" }}>
            ยังไม่มีเสียงโคลน บันทึกเสียงแรกได้จากแบบฟอร์มด้านล่าง
          </p>
        )}

        <form onSubmit={uploadVoice} className="mt-5 grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="clone-name" className="mb-2 block text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ชื่อเสียง</label>
              <input id="clone-name" value={name} onChange={(event) => setName(event.target.value.slice(0, 60))} placeholder="เช่น เสียงพากย์ของมิว" className="h-11 w-full rounded-xl px-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
            </div>
            <div>
              <label htmlFor="clone-ref-text" className="mb-2 block text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ข้อความที่พูดในไฟล์</label>
              <input id="clone-ref-text" value={refText} onChange={(event) => setRefText(event.target.value.slice(0, 500))} placeholder="ต้องตรงกับเสียงทุกคำ" className="h-11 w-full rounded-xl px-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              onClick={() => recording ? stopRecording() : void startRecording()}
              aria-pressed={recording}
              className="flex min-h-[86px] flex-col items-center justify-center gap-1 rounded-xl px-4 text-center outline-none transition-colors focus:ring-2 focus:ring-violet-500/50"
              style={{ border: `1.5px ${recording ? "solid #EF4444" : "dashed var(--ui-card-border)"}`, background: recording ? "rgba(239,68,68,.08)" : "transparent" }}
            >
              <span className="flex items-center gap-2 text-xs font-semibold" style={{ color: recording ? "#F87171" : "var(--ui-text-primary)" }}>
                {recording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
                {recording ? `กำลังอัด ${recordSec.toFixed(1)} / ${REF_MAX_SEC} วินาที` : "อัดเสียงจากไมโครโฟน"}
              </span>
              <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{recording ? "กดเพื่อหยุดก่อนครบ 15 วินาที" : "พูดต่อเนื่องในห้องเงียบ 5–15 วินาที"}</span>
            </button>

            <label className="flex min-h-[86px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl px-4 text-center outline-none transition-colors focus-within:ring-2 focus-within:ring-violet-500/50" style={{ border: `1.5px dashed ${file ? ACCENT : "var(--ui-card-border)"}`, background: file ? "rgba(139,92,246,.08)" : "transparent" }}>
              <input type="file" accept="audio/*,.m4a" className="sr-only" onChange={(event) => void selectFile(event.target.files?.[0] ?? null)} />
              <span className="flex items-center gap-2 text-xs font-semibold" style={{ color: file ? "#B9A6FF" : "var(--ui-text-primary)" }}>
                <Upload className="h-4 w-4" />{file ? file.name : "เลือกไฟล์เสียง"}
              </span>
              <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · กดเพื่อเปลี่ยน` : "mp3, wav, m4a หรือ webm · ไม่เกิน 15 MB"}</span>
            </label>
          </div>

          {file && (
            <p role="status" className="text-xs font-medium" style={{ color: invalidDuration ? "#F87171" : fileDurationSec === null ? "var(--ui-text-muted)" : "#34D399" }}>
              {fileDurationSec === null
                ? "ระบบจะตรวจความยาวและช่วงเงียบอีกครั้งตอนอัปโหลด"
                : invalidDuration
                  ? `ความยาว ${fileDurationSec.toFixed(1)} วินาที — ต้องอยู่ระหว่าง ${REF_MIN_SEC}–${REF_MAX_SEC} วินาที`
                  : `ความยาว ${fileDurationSec.toFixed(1)} วินาที · พร้อมใช้งาน`}
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-3 rounded-xl p-3 text-xs leading-relaxed" style={{ background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-secondary)" }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-500" />
            <span><strong style={{ color: "var(--ui-text-primary)" }}>ยืนยันว่าฉันเป็นเจ้าของเสียง</strong> หรือได้รับอนุญาตจากเจ้าของเสียงให้ใช้สำหรับการโคลน และจะไม่นำไปใช้หลอกลวงหรือสวมรอย</span>
          </label>

          <button type="submit" disabled={uploading || recording || !file || !name.trim() || refText.trim().length < 8 || !consent || invalidDuration} className="flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-45" style={{ color: "#C9BBFF", border: "1px solid rgba(139,92,246,.45)" }}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {uploading ? "กำลังตรวจและบันทึกเสียง..." : "บันทึกเสียงโคลนแบบส่วนตัว"}
          </button>
        </form>
      </section>

      <section className="rounded-2xl p-5 md:p-6" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "rgba(139,92,246,.12)", color: "#B9A6FF" }}><AudioLines className="h-5 w-5" /></div>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ให้เสียงโคลนพูด</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>งานจะเข้า queue ของ Hero Voice และคิดตามโควตานาทีแพ็กเกจเหมือนเสียงปกติ</p>
          </div>
        </div>

        <form onSubmit={generateClone} className="mt-5 grid gap-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
            <div>
              <label htmlFor="clone-voice-id" className="mb-2 block text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>เสียงโคลน</label>
              <select id="clone-voice-id" value={selectedVoiceId} onChange={(event) => setSelectedVoiceId(event.target.value)} disabled={!voices.length} className="h-11 w-full rounded-xl px-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/50 disabled:opacity-50" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}>
                {!voices.length && <option value="">ยังไม่มีเสียงโคลน</option>}
                {voices.map((voice) => <option key={voice.id} value={voice.voiceId}>{voice.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="clone-speed" className="mb-2 block text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ความเร็ว</label>
              <select id="clone-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="h-11 w-full rounded-xl px-3 text-sm outline-none focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}>
                <option value={0.85}>ช้า · 0.85×</option><option value={1}>ปกติ · 1×</option><option value={1.15}>เร็ว · 1.15×</option><option value={1.3}>เร็วมาก · 1.3×</option>
              </select>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="clone-script" className="text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ข้อความที่ต้องการสร้างเสียง</label>
              <span className="text-[11px] tabular-nums" style={{ color: "var(--ui-text-muted)" }}>{script.length.toLocaleString("th-TH")}/{maxScriptChars.toLocaleString("th-TH")}</span>
            </div>
            <textarea id="clone-script" value={script} onChange={(event) => setScript(event.target.value.slice(0, maxScriptChars))} rows={7} placeholder="พิมพ์ภาษาไทย ภาษาอังกฤษ หรือตัวเลขที่ต้องการให้เสียงโคลนพูด..." className="w-full resize-none rounded-xl px-4 py-3 text-sm leading-7 outline-none focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
          </div>
          <button type="submit" disabled={generating || !voices.length || !selectedVoiceId || !script.trim()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45" style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
            {generating ? "กำลังส่งงาน..." : "สร้างเสียงด้วยเสียงโคลน"}
          </button>
        </form>
      </section>
    </div>
  );
}
