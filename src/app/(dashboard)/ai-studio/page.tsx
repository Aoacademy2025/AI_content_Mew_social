"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AudioLines,
  Check,
  Cloud,
  Coins,
  Copy,
  Download,
  ImageIcon,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Server,
  Sparkles,
  Square,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { heroVoicesForLanguage, heroVoiceCatalogsAreIdentical } from "@/lib/hero-voice-language";
import { customerGenerationErrorCopy } from "@/lib/customer-generation-error";
import { customerApiErrorMessage } from "@/lib/customer-api-error";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";

type StudioSelectOption = { value: string; label: string; sublabel?: string; disabled?: boolean };

function StudioSelect({ id, value, onValueChange, options, placeholder, triggerClassName }: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: StudioSelectOption[];
  placeholder?: string;
  triggerClassName?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange}>
      <SelectTrigger
        id={id}
        className={`w-full rounded-xl border-0 px-4 shadow-none transition-colors focus:ring-2 focus:ring-violet-500/50 ${triggerClassName ?? "h-12"}`}
        style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className="rounded-xl shadow-xl"
        style={{ background: "var(--ui-card-bg-2)", borderColor: "var(--ui-card-border)", color: "var(--ui-text-primary)" }}
      >
        {options.map((option) => (
          // ใช้ Radix primitive ตรงๆ เพราะ sublabel ต้องอยู่นอก ItemText —
          // ไม่งั้นบรีฟจะโผล่บนปุ่ม trigger ตอนเลือกด้วย
          <SelectPrimitive.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="relative flex w-full cursor-default select-none flex-col items-start rounded-lg py-2 pl-3 pr-8 text-sm outline-none focus:bg-violet-500/15 focus:text-[#C9BBFF] data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <span className="absolute right-2 top-2.5 flex h-3.5 w-3.5 items-center justify-center">
              <SelectPrimitive.ItemIndicator>
                <Check className="h-4 w-4" />
              </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            {option.sublabel && (
              <span className="mt-0.5 text-[11px] leading-tight" style={{ color: "var(--ui-text-muted)" }}>
                {option.sublabel}
              </span>
            )}
          </SelectPrimitive.Item>
        ))}
      </SelectContent>
    </Select>
  );
}

type StudioMode = "image" | "voice" | "cloning";
type ImageEngine = "runpod" | "cloud";
type ImageModel = {
  id: string;
  label: string;
  description: string;
  credits: number;
  available: boolean;
  engine: ImageEngine;
  provider: string;
  providerModel: string;
  providerRoute: string;
  unavailableCode: string | null;
};
type Catalog = {
  imageModels: ImageModel[];
  voice: { available: boolean; backend?: "runpod" | "hostinger"; cloning?: boolean; maxDurationSec: number; maxScriptChars: number };
  plan: string;
  balance: { granted: number; promotional: number; purchased: number; total: number };
};
type Voice = { voice_id: string; desc: string; instruct: string; language?: string | null; brief?: string; preview_url: string };
type CloneVoice = { id: string; voiceId: string; name: string; refText: string; durationMs: number; createdAt: string };
type StudioJob = {
  id: string;
  kind: "image" | "voice";
  provider: string;
  model: string;
  providerModel: string | null;
  providerRoute: string | null;
  quoteVersion: string | null;
  status: string;
  inputPreview: string | null;
  inputText: string | null;
  input: Record<string, unknown> | null;
  voiceResult: {
    voiceUrl: string;
    audioDurationMs: number;
  } | null;
  outputUrl: string | null;
  creditCost: number;
  chargeState: string;
  errorCode: string | null;
  errorMessage: string | null;
  delayTimeMs: number | null;
  executionTimeMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  mediaExpiresAt: string | null;
};

const ACCENT = "#8B5CF6";
const IMAGE_STYLES = [
  ["photoreal", "ภาพถ่ายสมจริง"],
  ["cinematic", "ภาพยนตร์"],
  ["editorial", "Editorial"],
  ["illustration", "ภาพวาด"],
  ["product", "สินค้า Studio"],
] as const;
const ASPECTS = ["1:1", "4:5", "9:16", "16:9"] as const;
const ACTIVE_JOB_STATUS = new Set(["queued", "in_progress"]);
const IMAGE_ENGINES: ReadonlyArray<{
  id: ImageEngine;
  label: string;
  description: string;
  Icon: typeof Server;
}> = [
  { id: "runpod", label: "RunPod AI", description: "Open models บน GPU RunPod", Icon: Server },
  { id: "cloud", label: "Cloud API", description: "GPT และโมเดล provider API", Icon: Cloud },
];

function apiMessage(data: unknown, fallback: string): string {
  return customerApiErrorMessage(data, fallback);
}

// ขอบเขตความยาวเสียงอ้างอิงสำหรับโคลน — ต้องตรงกับ MIN_REF_MS/MAX_REF_MS ฝั่ง server
const REF_MIN_SEC = 5;
const REF_MAX_SEC = 30;

/** วัดความยาวไฟล์เสียงฝั่ง browser (คืน null ถ้าวัดไม่ได้ — ให้ server ตัดสินแทน) */
function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const done = (value: number | null) => { URL.revokeObjectURL(url); resolve(value); };
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) return done(audio.duration);
      // webm ที่อัดจากไมค์มักรายงาน Infinity — seek ไกลๆ ให้ browser คำนวณของจริง
      audio.currentTime = 1e7;
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        done(Number.isFinite(audio.duration) ? audio.duration : null);
      };
    };
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

function formatJobTime(iso: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** แถบเล่นเสียงกลางของ AI Studio — ใช้แทน <audio controls> ดิบของเบราว์เซอร์ที่
 *  คุมสไตล์ไม่ได้และหน้าตาต่างกันในแต่ละเบราว์เซอร์
 *
 *  ใช้ preload="metadata" (ไม่ใช่ "none") เพื่อให้รู้ความยาวไฟล์ตั้งแต่แรก —
 *  ต้นเหตุที่แถบเดิมค้างอยู่ที่ "0:00 / 0:00" จนกว่าจะกดเล่น */
function AudioBar({ src, dense = false }: { src: string; dense?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  // เปลี่ยนไฟล์ → รีเซ็ตสถานะ ไม่ให้ค้างเวลา/ตำแหน่งของไฟล์ก่อนหน้า
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setDuration(0);
    setFailed(false);
  }, [src]);

  function ratioFromClientX(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function seekTo(ratio: number) {
    setProgress(ratio);
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    }
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
      toast.error("เล่นเสียงไม่สำเร็จ");
    }
  }

  const elapsed = duration * progress;

  return (
    <div
      className={`flex items-center gap-2.5 rounded-full ${dense ? "px-2 py-1.5" : "px-3 py-2"}`}
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      <button
        type="button"
        onClick={() => void togglePlay()}
        disabled={failed}
        aria-label={playing ? "หยุด" : "เล่น"}
        className={`grid shrink-0 place-items-center rounded-full transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 ${dense ? "h-7 w-7" : "h-8 w-8"}`}
        style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", outlineColor: ACCENT }}
      >
        {playing
          ? <Pause className={dense ? "h-3 w-3 text-white" : "h-3.5 w-3.5 text-white"} aria-hidden="true" />
          : <Play className={dense ? "ml-0.5 h-3 w-3 text-white" : "ml-0.5 h-3.5 w-3.5 text-white"} aria-hidden="true" />}
      </button>

      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ui-text-secondary)" }}>
        {formatClock(elapsed)}
      </span>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={failed ? -1 : 0}
        aria-label="ตำแหน่งเสียง"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onPointerDown={(event) => {
          if (event.button !== 0 || failed) return;
          event.preventDefault();
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekTo(ratioFromClientX(event.clientX));
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          seekTo(ratioFromClientX(event.clientX));
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
          seekTo(ratioFromClientX(event.clientX));
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
          if (!step || failed) return;
          event.preventDefault();
          seekTo(Math.min(1, Math.max(0, progress + step)));
        }}
        className="group relative h-4 min-w-0 flex-1 cursor-pointer touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: ACCENT }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full" style={{ background: "var(--ui-card-border)" }}>
          <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: ACCENT }} />
        </div>
        {/* หัวจับ — โผล่ตอน hover/focus เท่านั้น ให้แถบดูสะอาดตอนอยู่เฉย ๆ */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{ left: `calc(${progress * 100}% - 5px)`, background: ACCENT }}
        />
      </div>

      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ui-text-muted)" }}>
        {failed ? "โหลดไม่ได้" : formatClock(duration)}
      </span>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value)) setDuration(value);
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (audio.duration && !draggingRef.current) setProgress(audio.currentTime / audio.duration);
        }}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => { setFailed(true); setPlaying(false); }}
      />
    </div>
  );
}

function JobState({ job }: { job: StudioJob }) {
  if (job.status === "completed") {
    return <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-400"><Check className="h-3 w-3" />เสร็จแล้ว</span>;
  }
  if (job.status === "failed") {
    return <span className="text-[11px] font-medium text-red-400">
      {job.kind === "voice"
        ? "สร้างเสียงไม่สำเร็จ"
        : job.chargeState === "refunded" ? "สร้างภาพไม่สำเร็จ · คืนเครดิตแล้ว" : "สร้างภาพไม่สำเร็จ"}
    </span>;
  }
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium text-amber-300">
      <Loader2 className="h-3 w-3 animate-spin" />
      {job.status === "queued" ? (job.provider === "runpod" ? "รอ GPU" : "รอ Cloud API") : "กำลังสร้าง"}
    </span>
  );
}

function ResultItem({ job }: { job: StudioJob }) {
  const [expanded, setExpanded] = useState(false);
  const engineLabel = job.kind === "voice"
    ? "Hero Voice"
    : job.provider === "runpod" ? "RunPod AI" : "Cloud API";
  const inputText = job.inputText || job.inputPreview || "";
  const expandable = inputText.length > 80;

  const copyInputText = async () => {
    try {
      await navigator.clipboard.writeText(inputText);
      toast.success(job.kind === "voice" ? "คัดลอกสคริปต์แล้ว" : "คัดลอก prompt แล้ว");
    } catch {
      toast.error("คัดลอกไม่สำเร็จ");
    }
  };
  return (
    <article className="group overflow-hidden border-b py-5 first:pt-0" style={{ borderColor: "var(--ui-divider)" }}>
      {job.kind === "image" && job.outputUrl ? (
        <div className="relative mb-3 overflow-hidden rounded-xl bg-black/15">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={job.outputUrl} alt={job.inputPreview || "AI generated artwork"} className="aspect-square w-full object-cover" />
          <a
            href={job.outputUrl}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-lg bg-black/70 text-white opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            aria-label="เปิดภาพเพื่อดาวน์โหลด"
          >
            <Download className="h-4 w-4" />
          </a>
        </div>
      ) : job.kind === "voice" && job.outputUrl ? (
        <div className="mb-3"><AudioBar src={job.outputUrl} /></div>
      ) : ACTIVE_JOB_STATUS.has(job.status) ? (
        <div className="mb-3 flex aspect-[16/8] items-center justify-center rounded-xl" style={{ background: "var(--ui-badge-neutral-bg)" }}>
          <div className="text-center">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" style={{ color: ACCENT }} />
            <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
              {job.kind === "voice"
                ? "Hero Voice กำลังเตรียม GPU"
                : job.provider === "runpod" ? "RunPod AI กำลังเตรียม GPU" : "Cloud API กำลังสร้างภาพ"}
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`${expanded ? "" : "line-clamp-2 "}whitespace-pre-wrap text-sm font-medium leading-relaxed${expandable ? " cursor-pointer" : ""}`}
            style={{ color: "var(--ui-text-primary)" }}
            onClick={expandable ? () => setExpanded((current) => !current) : undefined}
          >
            {inputText || (job.kind === "voice" ? "เสียงจาก Hero Voice" : "AI artwork")}
          </p>
          {(expandable || inputText) && (
            <div className="mt-1 flex items-center gap-3">
              {expandable && (
                <button
                  type="button"
                  className="text-[11px] font-medium hover:underline"
                  style={{ color: ACCENT }}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? "ย่อ" : "ดูเพิ่มเติม"}
                </button>
              )}
              {inputText && (
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] hover:underline"
                  style={{ color: "var(--ui-text-muted)" }}
                  onClick={copyInputText}
                >
                  <Copy className="h-3 w-3" />คัดลอก
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
            {formatJobTime(job.createdAt)} · {engineLabel} · {job.providerModel || job.model}
          </p>
        </div>
        <JobState job={job} />
      </div>
      {job.status === "failed" && (
        <p className="mt-2 text-xs leading-relaxed text-red-300/80">{customerGenerationErrorCopy(job)}</p>
      )}
    </article>
  );
}

function CompareSlot({ label, sublabel, job, error, waiting, idle = false }: {
  label: string;
  sublabel: string;
  job: StudioJob | null;
  error: string | null;
  waiting: boolean;
  idle?: boolean;
}) {
  return (
    <div className="rounded-xl p-3" style={{ border: "1px solid var(--ui-divider)" }}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>{label}</p>
          <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{sublabel}</p>
        </div>
        {job ? <JobState job={job} /> : error ? (
          <span className="text-[11px] font-medium text-red-400">ไม่สำเร็จ</span>
        ) : waiting ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-300">
            <Loader2 className="h-3 w-3 animate-spin" />กำลังส่ง
          </span>
        ) : null}
      </div>
      {job?.outputUrl ? (
        <div className="mt-2"><AudioBar src={job.outputUrl} /></div>
      ) : error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-red-300/80">{error}</p>
      ) : (
        <p className="mt-2 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
          {idle ? "ยังไม่ได้สร้าง — ผลเสียงจะขึ้นตรงนี้" : "รอผลเสียง..."}
        </p>
      )}
      {job?.status === "completed" && typeof job.executionTimeMs === "number" && (
        <p className="mt-1 text-[10px] tabular-nums" style={{ color: "var(--ui-text-muted)" }}>
          ใช้เวลาสังเคราะห์ {(job.executionTimeMs / 1000).toFixed(1)} วิ
          {job.delayTimeMs ? ` · รอคิว ${(job.delayTimeMs / 1000).toFixed(1)} วิ` : ""}
        </p>
      )}
    </div>
  );
}

const VOICE_WAVE_BAR_COUNT = 80;

// ภาพลวงตาคลื่นเสียง (fallback) — ใช้เฉพาะตอนถอด waveform จริงจากไฟล์ไม่สำเร็จ (เช่น
// decodeAudioData ไม่รองรับฟอร์แมต) กันไม่ให้ผู้ใช้เห็นแถบว่างเปล่า
const VOICE_WAVE_FALLBACK_HEIGHTS = Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, i) => {
  const wave = Math.sin(i * 0.7) * 0.5 + Math.sin(i * 0.31) * 0.35 + Math.sin(i * 1.7) * 0.15;
  return Math.round(30 + (wave + 1) * 32);
});

// แคชผล waveform ที่ถอดแล้วต่อเสียง (module-level กันถอดซ้ำเวลาสลับไปมาเสียงเดิม)
const voiceWaveformCache = new Map<string, number[]>();
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudioContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedAudioContext = new Ctor();
  }
  return sharedAudioContext;
}

/** เฉลี่ยกำลังเสียง (RMS) ทีละช่วงของไฟล์จริง แล้ว normalize เป็น % ความสูง 12–100
 * — คลื่นที่ได้มาจากเนื้อเสียงจริงในไฟล์ ไม่ใช่ลวดลายสุ่ม */
function computeWaveformPeaks(buffer: AudioBuffer, barCount: number): number[] {
  const channel = buffer.getChannelData(0);
  const samplesPerBar = Math.max(1, Math.floor(channel.length / barCount));
  const rawPeaks: number[] = [];
  let max = 0;
  for (let i = 0; i < barCount; i++) {
    const start = i * samplesPerBar;
    const end = Math.min(channel.length, start + samplesPerBar);
    let sumSquares = 0;
    for (let j = start; j < end; j++) sumSquares += channel[j] * channel[j];
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    rawPeaks.push(rms);
    if (rms > max) max = rms;
  }
  const floor = 12;
  return rawPeaks.map((peak) => (max > 0 ? Math.round(floor + (peak / max) * (100 - floor)) : floor));
}

/** ปุ่มฟังเสียงตัวอย่างของเสียงที่เลือกอยู่ในดรอปดาวน์ — แทนแถบ <audio controls> ดิบของเบราว์เซอร์
 * ด้วยปุ่มเล่น + waveform ที่ถอดจากเนื้อเสียงจริงในไฟล์ (Web Audio API) และไฮไลต์ตามตำแหน่งเล่นจริง
 * เล่นด้วย playbackRate = speed ที่เลือกไว้ ให้ฟังตัวอย่างได้ใกล้เคียงกับเสียงที่จะสร้างจริง */
function VoicePreviewPlayer({ voice, speed }: { voice: Voice | undefined; speed: number }) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [waveform, setWaveform] = useState<number[] | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  // ระหว่างลาก ต้องไม่ให้ ontimeupdate ของ audio เขียนทับตำแหน่งที่นิ้วชี้อยู่ —
  // ใช้ ref (ไม่ใช่ state) เพราะ handler ที่ผูกไว้กับ audio อ่านค่า ณ เวลาที่ event ยิงจริง
  const draggingRef = useRef(false);

  useEffect(() => {
    // เปลี่ยนเสียงที่เลือก → เลิกเล่นตัวเก่าทันที กัน UI ค้างว่า "กำลังเล่น" เสียงที่ไม่ตรงกับที่โชว์
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setLoading(false);
    setProgress(0);
    setWaveform(voice ? voiceWaveformCache.get(voice.voice_id) ?? null : null);

    if (!voice) return;
    const cached = voiceWaveformCache.get(voice.voice_id);
    if (cached) return;

    let cancelled = false;
    (async () => {
      try {
        const ctx = getSharedAudioContext();
        if (!ctx) return;
        const response = await fetch(voice.preview_url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        if (cancelled) return;
        const peaks = computeWaveformPeaks(audioBuffer, VOICE_WAVE_BAR_COUNT);
        voiceWaveformCache.set(voice.voice_id, peaks);
        setWaveform(peaks);
      } catch (error) {
        // ถอด waveform จริงไม่สำเร็จ — ปล่อยให้ fallback ลวดลายคงที่แสดงแทนเงียบ ๆ ไม่รบกวนผู้ใช้
        console.warn("[voice-preview] decode waveform failed:", error instanceof Error ? error.message : error);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ตั้งใจ depend แค่ voice_id: `voice`
    // เป็น object ใหม่ทุก render จาก voices.find() ของ parent ถ้า depend ทั้ง object จะรันซ้ำทุก render
  }, [voice?.voice_id]);

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  // เปลี่ยนความเร็วระหว่างกำลังเล่นอยู่ → ปรับ playbackRate ของตัวที่เล่นอยู่ทันที ไม่ต้องกดเล่นใหม่
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  /** สร้าง <audio> ตัวใหม่พร้อม handler ครบ แล้วผูกเป็นตัวที่กำลังใช้งาน */
  function createAudio() {
    const audio = new Audio(voice!.preview_url);
    audio.playbackRate = speed;
    audioRef.current = audio;
    audio.ontimeupdate = () => {
      // กำลังลากอยู่ → ตำแหน่งบนจอมาจากนิ้ว ไม่ใช่จาก audio
      if (audioRef.current === audio && audio.duration && !draggingRef.current) {
        setProgress(audio.currentTime / audio.duration);
      }
    };
    audio.onended = () => { if (audioRef.current === audio) { setPlaying(false); setProgress(0); } };
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      setLoading(false);
      setPlaying(false);
      toast.error("เล่นเสียงตัวอย่างไม่สำเร็จ");
    };
    return audio;
  }

  function ratioFromClientX(clientX: number): number {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  /** เลื่อนไปยังตำแหน่ง ratio (0-1). `autoplay` = ปล่อยนิ้วแล้วให้เล่นต่อจากจุดนั้นเลย */
  async function seekTo(ratio: number, autoplay: boolean) {
    if (!voice) return;
    setProgress(ratio);
    const audio = audioRef.current ?? createAudio();
    // ยังไม่มี metadata → ยังไม่รู้ duration, ตั้ง currentTime ตอนนี้ไม่มีผล รอ event ก่อน
    const applyTime = () => { if (audio.duration) audio.currentTime = ratio * audio.duration; };
    if (audio.readyState >= 1) applyTime();
    else audio.addEventListener("loadedmetadata", applyTime, { once: true });

    if (!autoplay || !audio.paused) return;
    try {
      await audio.play();
      if (audioRef.current === audio) setPlaying(true);
    } catch {
      if (audioRef.current === audio) setPlaying(false);
    }
  }

  async function togglePlay() {
    if (!voice) return;
    if (playing && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }
    audioRef.current?.pause();
    setPlaying(false);
    const audio = createAudio();
    setLoading(true);
    try {
      await audio.play();
      if (audioRef.current === audio) setPlaying(true);
    } catch {
      if (audioRef.current === audio) {
        setPlaying(false);
        toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองอีกครั้ง");
      }
    } finally {
      if (audioRef.current === audio) setLoading(false);
    }
  }

  if (!voice?.preview_url) return null;
  const bars = waveform ?? VOICE_WAVE_FALLBACK_HEIGHTS;

  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl p-2.5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
        <Mic className="h-4 w-4 text-white" aria-hidden="true" />
      </span>
      <div
        ref={waveRef}
        role="slider"
        tabIndex={0}
        aria-label="ตำแหน่งเสียงตัวอย่าง"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={`${Math.round(progress * 100)}%`}
        onPointerDown={(event) => {
          // ปุ่มซ้าย/นิ้วเท่านั้น — กันคลิกขวาเปิดเมนูแล้วกระโดดตำแหน่ง
          if (event.button !== 0) return;
          event.preventDefault();
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          void seekTo(ratioFromClientX(event.clientX), false);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          void seekTo(ratioFromClientX(event.clientX), false);
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
          // ปล่อยนิ้วแล้วเล่นต่อจากจุดที่เลือก — คลิกเฉย ๆ ก็เริ่มเล่นจากจุดนั้นได้เลย
          void seekTo(ratioFromClientX(event.clientX), true);
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
          if (!step) return;
          event.preventDefault();
          void seekTo(Math.min(1, Math.max(0, progress + step)), false);
        }}
        className="flex h-5 flex-1 cursor-pointer items-end gap-px touch-none focus-visible:outline-2 focus-visible:outline-offset-4 rounded-sm"
        style={{ outlineColor: ACCENT }}
      >
        {bars.map((height, index) => {
          // ไฮไลต์ตามตำแหน่งเสมอ ไม่ใช่เฉพาะตอนเล่น — หยุดหรือลากค้างไว้ก็ยังเห็นว่าอยู่ตรงไหน
          const played = index / bars.length <= progress;
          return (
            <span
              key={index}
              aria-hidden="true"
              className="pointer-events-none min-w-0 flex-1 rounded-full transition-colors"
              style={{
                height: `${height}%`,
                background: played ? ACCENT : "var(--ui-card-border)",
              }}
            />
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => void togglePlay()}
        aria-label={`${playing ? "หยุดเสียงตัวอย่าง" : "ฟังเสียงตัวอย่าง"} ${voice.desc || voice.voice_id}`}
        aria-busy={loading}
        disabled={loading}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          background: playing ? "rgba(139,92,246,.18)" : "rgba(255,255,255,.06)",
          color: playing ? "#B9A2FF" : "var(--ui-text-secondary)",
          outlineColor: ACCENT,
        }}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : playing ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
        {playing ? "หยุด" : "ฟังเลย"}
      </button>
    </div>
  );
}


/** ตัวเล่นไฟล์อ้างอิงในแท็บโคลนเสียง — ใช้ภาษาภาพเดียวกับ VoicePreviewPlayer
 *  (waveform ถอดจากไฟล์จริง + คลิก/ลากเลื่อนได้) แทน <audio controls> ดิบของเบราว์เซอร์
 *  ที่หน้าตาไม่เข้ากับส่วนอื่นของหน้าและคุมสไตล์ไม่ได้ */
function CloneRefPlayer({ file, url, onRemove }: { file: File; url: string; onRemove: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [waveform, setWaveform] = useState<number[] | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // ไฟล์เปลี่ยน → รีเซ็ตทุกอย่างแล้วถอด waveform ของไฟล์ใหม่
  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setProgress(0);
    setDuration(0);
    setWaveform(null);

    let cancelled = false;
    (async () => {
      try {
        const ctx = getSharedAudioContext();
        if (!ctx) return;
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        if (cancelled) return;
        setWaveform(computeWaveformPeaks(buffer, VOICE_WAVE_BAR_COUNT));
        setDuration(buffer.duration);
      } catch {
        // ฟอร์แมตที่ decodeAudioData ไม่รองรับ — ใช้ลวดลาย fallback และอ่าน duration
        // จาก <audio> แทน ไม่ต้องรบกวนผู้ใช้
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  function createAudio() {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onloadedmetadata = () => {
      if (audioRef.current === audio && Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.ontimeupdate = () => {
      if (audioRef.current === audio && audio.duration && !draggingRef.current) {
        setProgress(audio.currentTime / audio.duration);
      }
    };
    audio.onended = () => { if (audioRef.current === audio) { setPlaying(false); setProgress(0); } };
    return audio;
  }

  function ratioFromClientX(clientX: number): number {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  async function seekTo(ratio: number, autoplay: boolean) {
    setProgress(ratio);
    const audio = audioRef.current ?? createAudio();
    const applyTime = () => { if (audio.duration) audio.currentTime = ratio * audio.duration; };
    if (audio.readyState >= 1) applyTime();
    else audio.addEventListener("loadedmetadata", applyTime, { once: true });
    if (!autoplay || !audio.paused) return;
    try {
      await audio.play();
      if (audioRef.current === audio) setPlaying(true);
    } catch {
      if (audioRef.current === audio) setPlaying(false);
    }
  }

  async function togglePlay() {
    const current = audioRef.current;
    if (playing && current && !current.paused) {
      current.pause();
      setPlaying(false);
      return;
    }
    const audio = current ?? createAudio();
    try {
      await audio.play();
      if (audioRef.current === audio) setPlaying(true);
    } catch {
      toast.error("เล่นเสียงไม่สำเร็จ");
    }
  }

  const bars = waveform ?? VOICE_WAVE_FALLBACK_HEIGHTS;
  const elapsed = duration * progress;

  return (
    <div
      className="flex items-center gap-3 rounded-2xl p-3"
      style={{ background: "var(--ui-card-bg)", border: `1px solid ${ACCENT}33` }}
    >
      <button
        type="button"
        onClick={() => void togglePlay()}
        aria-label={playing ? "หยุดเสียงอ้างอิง" : "เล่นเสียงอ้างอิง"}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", outlineColor: ACCENT }}
      >
        {playing
          ? <Pause className="h-4 w-4 text-white" aria-hidden="true" />
          : <Play className="ml-0.5 h-4 w-4 text-white" aria-hidden="true" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[11px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>
            เสียงอ้างอิงที่จะใช้โคลน
          </p>
          <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--ui-text-muted)" }}>
            {formatClock(elapsed)} / {formatClock(duration)}
          </span>
        </div>
        <div
          ref={waveRef}
          role="slider"
          tabIndex={0}
          aria-label="ตำแหน่งเสียงอ้างอิง"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            draggingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            void seekTo(ratioFromClientX(event.clientX), false);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            void seekTo(ratioFromClientX(event.clientX), false);
          }}
          onPointerUp={(event) => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void seekTo(ratioFromClientX(event.clientX), true);
          }}
          onPointerCancel={() => { draggingRef.current = false; }}
          onKeyDown={(event) => {
            const step = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
            if (!step) return;
            event.preventDefault();
            void seekTo(Math.min(1, Math.max(0, progress + step)), false);
          }}
          className="mt-1.5 flex h-6 cursor-pointer touch-none items-end gap-px rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
          style={{ outlineColor: ACCENT }}
        >
          {bars.map((height, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="pointer-events-none min-w-0 flex-1 rounded-full transition-colors"
              style={{
                height: `${height}%`,
                background: index / bars.length <= progress ? ACCENT : "var(--ui-card-border)",
              }}
            />
          ))}
        </div>
        <p className="mt-1 truncate text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{file.name}</p>
      </div>

      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 self-start rounded-lg px-2 py-1 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/10 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        เอาออก
      </button>
    </div>
  );
}

export default function AiStudioPage() {
  const [mode, setMode] = useState<StudioMode>("image");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [imageEngine, setImageEngine] = useState<ImageEngine>("runpod");
  const [model, setModel] = useState("z-image-turbo");
  const [style, setStyle] = useState<(typeof IMAGE_STYLES)[number][0]>("photoreal");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECTS)[number]>("4:5");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string>("");
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const [script, setScript] = useState("");
  // 1.0× อ่านไทยเร็วเกินธรรมชาติ (~20 ตัวอักษร/วินาที วัดจาก worker จริง) —
  // 0.85× ให้จังหวะที่ฟังสบายกว่าเป็นค่าเริ่มต้น
  const [speed, setSpeed] = useState(0.85);
  // ภาษาที่ให้เสียงอ่าน: ไทย (ผ่าน normalizer ไทยตามปกติ) หรือ ลาว (ส่งดิบให้
  // server อ่านด้วย language=Lao) — ลาวรองรับเฉพาะ backend hostinger ตอนนี้
  const [voiceLanguage, setVoiceLanguage] = useState<"th" | "lo">("th");
  // คลังเสียงของภาษาที่เลือกอยู่ — ไทยเปิดครบ, ลาวตัดเสียงสำเนียงต่างชาติออก
  const languageVoices = useMemo(() => heroVoicesForLanguage(voices, voiceLanguage), [voices, voiceLanguage]);
  // แคตตาล็อกยังไม่กำกับภาษาให้เสียงตัวไหนเลย → ทั้งสองคลังเป็นชุดเดียวกัน
  const sharedCatalog = useMemo(() => heroVoiceCatalogsAreIdentical(voices), [voices]);
  // durable queue (RunPod) ไม่รับพารามิเตอร์ language เลย — ถ้าปล่อยให้เลือกลาวได้
  // จะได้เสียงไทยกลับมาเงียบ ๆ โดยผู้ใช้ไม่รู้ตัว จึงล็อกไว้ที่ไทยจนกว่าจะรองรับจริง
  const laoSupported = (catalog?.voice.backend ?? "runpod") !== "runpod";

  useEffect(() => {
    if (laoSupported) return;
    setVoiceLanguage("th");
    setCloneLanguage("th");
  }, [laoSupported]);

  // สลับภาษาแล้วเสียงที่เลือกค้างอยู่อาจไม่มีในคลังใหม่ → เด้งไปเสียงแรกของคลังนั้น
  // ไม่งั้น dropdown โชว์ค่าว่างแต่ state ยังถือ voice_id เดิม แล้วกดสร้างได้เสียงผิดคลัง
  useEffect(() => {
    if (!languageVoices.length) return;
    setVoiceId((current) =>
      languageVoices.some((voice) => voice.voice_id === current) ? current : languageVoices[0].voice_id,
    );
  }, [languageVoices]);
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[] | null>(null);
  const [cloneVoiceId, setCloneVoiceId] = useState("");
  const [cloningScript, setCloningScript] = useState("");
  const [cloneLanguage, setCloneLanguage] = useState<"th" | "lo">("th");
  const [cloneName, setCloneName] = useState("");
  const [cloneRefText, setCloneRefText] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneFileDurationSec, setCloneFileDurationSec] = useState<number | null>(null);
  const [cloneFileUrl, setCloneFileUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const [cloneSubmitting, setCloneSubmitting] = useState(false);
  // แท็บโคลนเสียงใช้เอนจินเดียว (OmniVoice) — ผลล่าสุดเก็บใน state นี้
  // (ตัว job อัปเดตผ่าน polling ปกติ)
  type CloneRun = { jobId: string | null; error: string | null };
  const [omniRun, setOmniRun] = useState<CloneRun | null>(null);
  const [omniSubmitting, setOmniSubmitting] = useState(false);

  const loadCatalog = useCallback(async () => {
    const response = await fetch("/api/ai-studio/catalog", { cache: "no-store" });
    if (!response.ok) throw new Error("โหลดข้อมูล AI Studio ไม่สำเร็จ");
    const data = await response.json() as Catalog;
    setCatalog(data);
    setModel((current) => data.imageModels.some((item) => item.id === current)
      ? current
      : data.imageModels.find((item) => item.engine === "runpod" && item.available)?.id
        ?? data.imageModels.find((item) => item.engine === "runpod")?.id
        ?? current);
  }, []);

  const loadJobs = useCallback(async () => {
    const response = await fetch("/api/ai-studio/jobs", { cache: "no-store" });
    if (!response.ok) throw new Error("โหลดประวัติไม่สำเร็จ");
    const data = await response.json() as { jobs: StudioJob[]; balance: Catalog["balance"] };
    setJobs(data.jobs);
    setCatalog((current) => current ? { ...current, balance: data.balance } : current);
  }, []);

  useEffect(() => {
    Promise.all([loadCatalog(), loadJobs()])
      .catch((error) => toast.error(error instanceof Error ? error.message : "เปิด AI Studio ไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [loadCatalog, loadJobs]);

  const loadVoices = useCallback(async () => {
    setVoicesLoading(true);
    try {
      const response = await fetch("/api/omnivoice/voices", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) throw new Error(apiMessage(data, "โหลดรายการเสียงไม่สำเร็จ"));
      setVoices(data as Voice[]);
      setVoicesError("");
      setVoiceId((current) => current || (data[0] as Voice | undefined)?.voice_id || "");
    } catch (error) {
      // เก็บ error ไว้แสดงพร้อมปุ่มลองใหม่ — เดิมโยน toast อย่างเดียวแล้วทิ้ง dropdown
      // ว่างค้างไว้ ผู้ใช้ต้องรีเฟรชทั้งหน้าถึงจะได้รายการเสียงกลับมา
      setVoicesError(error instanceof Error ? error.message : "โหลดรายการเสียงไม่สำเร็จ");
      throw error;
    } finally {
      setVoicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (catalog?.voice.available) {
      loadVoices().catch((error) => toast.error(error instanceof Error ? error.message : "โหลดรายการเสียงไม่สำเร็จ"));
    }
    // เสียงโคลนของผู้ใช้ — โหลดเมื่อแท็บโคลนเปิดให้บัญชีนี้
    if (!catalog?.voice.cloning) return;
    fetch("/api/omnivoice/user-voices", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (!Array.isArray(data)) return;
        setCloneVoices(data as CloneVoice[]);
        setCloneVoiceId((current) => current || (data[0] as CloneVoice | undefined)?.voiceId || "");
      })
      .catch(() => {});
  }, [catalog?.voice.available, catalog?.voice.cloning, loadVoices]);

  const activeKey = useMemo(
    () => jobs.filter((job) => ACTIVE_JOB_STATUS.has(job.status)).map((job) => job.id).join(","),
    [jobs],
  );

  useEffect(() => {
    if (!activeKey) return;
    let stopped = false;
    const ids = activeKey.split(",");
    async function poll() {
      const updates = await Promise.all(ids.map(async (id) => {
        try {
          const response = await fetch(`/api/ai-studio/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
          if (!response.ok) return null;
          const data = await response.json() as { job?: StudioJob };
          return data.job ?? null;
        } catch { return null; }
      }));
      if (stopped) return;
      const valid = updates.filter((job): job is StudioJob => Boolean(job));
      if (valid.length) {
        const byId = new Map(valid.map((job) => [job.id, job]));
        setJobs((current) => current.map((job) => byId.get(job.id) ?? job));
        if (valid.some((job) => !ACTIVE_JOB_STATUS.has(job.status))) void loadCatalog();
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeKey, loadCatalog]);

  const engineModels = useMemo(
    () => catalog?.imageModels.filter((item) => item.engine === imageEngine) ?? [],
    [catalog?.imageModels, imageEngine],
  );
  const selectedModel = engineModels.find((item) => item.id === model);
  const scriptRatio = Math.min(100, ((script.length || 0) / Math.max(1, catalog?.voice.maxScriptChars ?? 1)) * 100);
  const estimatedVoiceMinutes = script.replace(/\s+/g, "").length / (14 * 60);

  async function submitImage(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !selectedModel?.available) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/ai-studio/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          engine: imageEngine,
          model,
          style,
          aspectRatio,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "ส่งงานสร้างภาพไม่สำเร็จ"));
      const job = data.job as StudioJob;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (data.balance !== undefined) {
        setCatalog((current) => current ? { ...current, balance: { ...current.balance, total: Number(data.balance) } } : current);
      }
      toast.success("ส่งงานสร้างภาพแล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างภาพไม่สำเร็จ");
      void loadCatalog();
    } finally {
      setSubmitting(false);
    }
  }

  function selectImageEngine(nextEngine: ImageEngine) {
    setImageEngine(nextEngine);
    const candidates = catalog?.imageModels.filter((item) => item.engine === nextEngine) ?? [];
    const nextModel = candidates.find((item) => item.available) ?? candidates[0];
    if (nextModel) setModel(nextModel.id);
  }

  async function submitVoice(event: FormEvent) {
    event.preventDefault();
    if (!script.trim() || !voiceId) return;
    setSubmitting(true);
    try {
      // hostinger/local backend ไม่มี durable queue — ใช้ route synchronous ที่
      // บันทึกประวัติเข้า AI Studio ให้อยู่แล้ว (studio: true)
      const durable = (catalog?.voice.backend ?? "runpod") === "runpod";
      // เสียงโคลน (user_*) วิ่งผ่าน route เดียวกับเสียง stock — ฝั่ง server
      // โหลด ref audio ของเสียงนั้นแล้วยิง OmniVoice /clone ให้เอง
      if (durable) {
        const response = await fetch("/api/ai-studio/voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: script,
            voiceId,
            speed,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงไม่สำเร็จ"));
        const job = data.job as StudioJob;
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        toast.success(job.status === "completed" ? "สร้างเสียงสำเร็จ" : "ส่งงานสร้างเสียงแล้ว");
      } else {
        const response = await fetch("/api/videos/tts-omnivoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: script, voiceId, speed, studio: true, language: voiceLanguage }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงไม่สำเร็จ"));
        await loadJobs().catch(() => {});
        toast.success("สร้างเสียงสำเร็จ");
      }
      setScript("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างเสียงไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  }

  async function selectCloneFile(file: File | null) {
    setCloneFile(file);
    setCloneFileDurationSec(null);
    if (!file) return;
    const duration = await readAudioDuration(file);
    setCloneFileDurationSec(duration);
    if (duration !== null && duration < REF_MIN_SEC) {
      toast.error(`ไฟล์เสียงยาว ${duration.toFixed(1)} วิ — ต้องพูดต่อเนื่องอย่างน้อย ${REF_MIN_SEC} วินาที`);
    } else if (duration !== null && duration > REF_MAX_SEC) {
      toast.error(`ไฟล์เสียงยาว ${duration.toFixed(0)} วิ — ยาวเกิน ${REF_MAX_SEC} วินาที ตัดช่วงที่พูดชัด ๆ มา 10-20 วิพอ`);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  async function startRecording() {
    if (recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("เข้าถึงไมโครโฟนไม่ได้ — อนุญาตการใช้ไมค์ในเบราว์เซอร์ก่อน");
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      if (recordTimerRef.current !== null) { window.clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (!blob.size) { toast.error("อัดเสียงไม่สำเร็จ ลองใหม่อีกครั้ง"); return; }
      const file = new File([blob], `mic-recording-${Date.now()}.webm`, { type: blob.type });
      setCloneFile(file);
      // ใช้เวลาที่จับเองเป็นความยาว (webm จากไมค์วัดจาก metadata ไม่ค่อยได้)
      setCloneFileDurationSec(elapsedSec);
      if (elapsedSec < REF_MIN_SEC) {
        toast.error(`อัดได้ ${elapsedSec.toFixed(1)} วิ — สั้นเกินไป ต้องพูดต่อเนื่องอย่างน้อย ${REF_MIN_SEC} วินาที`);
      }
    };
    recorderRef.current = recorder;
    setRecordSec(0);
    setRecording(true);
    recorder.start();
    recordTimerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setRecordSec(elapsed);
      if (elapsed >= REF_MAX_SEC) stopRecording(); // ครบเพดาน 30 วิ หยุดให้อัตโนมัติ
    }, 200);
  }

  // URL สำหรับฟังไฟล์อ้างอิงก่อนโคลน — ครอบคลุมทั้งเสียงที่อัดจากไมค์และไฟล์ที่อัปโหลด
  // เพราะทั้งสองทางลงที่ cloneFile ตัวเดียวกัน สร้าง/คืน object URL ตามอายุของไฟล์
  // (ไม่ revoke = memory leak สะสมทุกครั้งที่เลือกไฟล์ใหม่)
  useEffect(() => {
    if (!cloneFile) { setCloneFileUrl(null); return; }
    const url = URL.createObjectURL(cloneFile);
    setCloneFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cloneFile]);

  // เก็บกวาดตอนออกจากหน้า — ไมค์ต้องไม่ค้างเปิด
  useEffect(() => () => {
    if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stream.getTracks().forEach((track) => track.stop());
      try { recorder.stop(); } catch {}
    }
  }, []);

  async function submitCloneVoice(event: FormEvent) {
    event.preventDefault();
    if (!cloneFile || cloneSubmitting) return;
    setCloneSubmitting(true);
    try {
      const form = new FormData();
      form.set("name", cloneName);
      form.set("refText", cloneRefText);
      form.set("audio", cloneFile);
      const response = await fetch("/api/omnivoice/user-voices", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงโคลนไม่สำเร็จ"));
      setCloneVoices((current) => [data as CloneVoice, ...(current ?? [])]);
      setCloneName("");
      setCloneRefText("");
      setCloneFile(null);
      setCloneFileDurationSec(null);
      setCloneVoiceId((data as CloneVoice).voiceId);
      // ให้เสียงโคลนใหม่โผล่ใน dropdown ของแท็บ "สร้างเสียง" ทันทีด้วย
      await loadVoices().catch(() => {});
      const autoTranscribed = (data as { autoTranscribed?: boolean }).autoTranscribed;
      const refCheck = (data as { refCheck?: { similarity: number; heard: string; warning: boolean } | null }).refCheck;
      if (autoTranscribed) {
        toast.success(`สร้างเสียงโคลนแล้ว — ระบบถอดข้อความอัตโนมัติว่า: "${(data as CloneVoice).refText.slice(0, 120)}"`, { duration: 10_000 });
      } else if (refCheck?.warning) {
        toast.warning(
          `ข้อความกำกับไม่ตรงกับเสียงในไฟล์ (ตรงกัน ~${Math.round(refCheck.similarity * 100)}%) — เสียงโคลนอาจเพี้ยน `
          + `ระบบได้ยินว่า: "${refCheck.heard.slice(0, 120)}" ถ้าไม่ตรงที่ตั้งใจ แนะนำลบแล้วอัปใหม่ให้ข้อความตรงคำต่อคำ`,
          { duration: 15_000 },
        );
      } else {
        toast.success("สร้างเสียงโคลนแล้ว — เลือกใช้ได้ทั้งแท็บโคลนเสียงและสร้างเสียง");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างเสียงโคลนไม่สำเร็จ");
    } finally {
      setCloneSubmitting(false);
    }
  }

  // ยิงเสียงโคลนด้วย OmniVoice
  async function runCloneEngine() {
    if (!cloningScript.trim() || !cloneVoiceId) return;
    const setRun = setOmniRun;
    const setBusy = setOmniSubmitting;
    setBusy(true);
    setRun({ jobId: null, error: null });
    try {
      // เหมือนแท็บสร้างเสียง: durable queue มีเฉพาะ RunPod — hostinger/local ต้องใช้
      // route synchronous ไม่งั้นจะเด้ง OMNIVOICE_DURABLE_BACKEND_UNSUPPORTED (409)
      const durable = (catalog?.voice.backend ?? "runpod") === "runpod";
      if (durable) {
        // Hero Voice (OmniVoice) — durable route: ได้ job เร็ว แล้ว polling ปกติตามต่อ
        const response = await fetch("/api/ai-studio/voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cloningScript, voiceId: cloneVoiceId, speed, language: cloneLanguage, idempotencyKey: crypto.randomUUID() }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงไม่สำเร็จ"));
        const job = data.job as StudioJob;
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        setRun({ jobId: job.id, error: null });
      } else {
        // synchronous — เสร็จแล้วค่อยตอบ พร้อม studioJob ที่บันทึกประวัติไว้ให้แล้ว
        const response = await fetch("/api/videos/tts-omnivoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cloningScript, voiceId: cloneVoiceId, speed, studio: true, language: cloneLanguage }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(apiMessage(data, "สร้างเสียงไม่สำเร็จ"));
        // route นี้คืน studioJob เป็น projection แค่ { id, status, outputUrl } ไม่ใช่ StudioJob
        // เต็มใบ — ยัดลง jobs ตรง ๆ ไม่ได้ (executionTimeMs หายไปแล้วการ์ดผลจะโชว์
        // "ใช้เวลาสังเคราะห์ NaN วิ") จึงดึงประวัติเต็มจาก /jobs มาทับแทน
        const created = (data as { studioJob?: { id: string } | null }).studioJob ?? null;
        await loadJobs().catch(() => {});
        setRun({ jobId: created?.id ?? null, error: null });
      }
    } catch (error) {
      setRun({ jobId: null, error: error instanceof Error ? error.message : "สร้างเสียงไม่สำเร็จ" });
    } finally {
      setBusy(false);
    }
  }

  async function removeCloneVoice(id: string) {
    try {
      const response = await fetch(`/api/omnivoice/user-voices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("ลบเสียงโคลนไม่สำเร็จ");
      setCloneVoices((current) => (current ?? []).filter((voice) => voice.id !== id));
      await loadVoices().catch(() => {});
      toast.success("ลบเสียงโคลนแล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ลบเสียงโคลนไม่สำเร็จ");
    }
  }

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="mx-auto max-w-[1380px] px-4 pb-16 pt-5 md:px-7 md:pt-8">
        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: "#B9A6FF" }}>
              HERO AI · Creative Workbench
            </p>
            <h1 className="text-3xl font-bold tracking-tight md:text-[42px]" style={{ color: "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>
              AI Studio
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
              สร้างภาพประกอบแบบไม่มีตัวหนังสือ และสร้างเสียงยาวตามแพ็กเกจจากพื้นที่เดียว
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-full px-4 py-2.5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
            <Coins className="h-4 w-4" style={{ color: "#F6C85F" }} />
            <div>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--ui-text-muted)" }}>เครดิตภาพ</p>
              <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--ui-text-primary)" }}>{catalog?.balance.total ?? "—"}</p>
            </div>
          </div>
        </header>

        <div className="mb-6 inline-flex rounded-xl p-1" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)" }}>
          {([
            ["image", "สร้างภาพ", ImageIcon],
            ["voice", "สร้างเสียง", AudioLines],
            ...(catalog?.voice.cloning ? [["cloning", "โคลนเสียง", WandSparkles]] as const : []),
          ] as ReadonlyArray<readonly [StudioMode, string, typeof ImageIcon]>).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className="flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors"
              style={{
                background: mode === value ? "var(--ui-card-bg)" : "transparent",
                color: mode === value ? "var(--ui-text-primary)" : "var(--ui-text-muted)",
                boxShadow: mode === value ? "0 1px 8px rgba(0,0,0,.12)" : "none",
              }}
            >
              <Icon className="h-4 w-4" style={{ color: mode === value ? ACCENT : undefined }} />
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_360px]">
          <section>
            {loading ? (
              <div className="flex min-h-[420px] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: ACCENT }} /></div>
            ) : mode === "image" ? (
              <form onSubmit={submitImage} className="space-y-7">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="image-prompt" className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>อยากได้ภาพอะไร</label>
                    <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{prompt.length}/1,500</span>
                  </div>
                  <textarea
                    id="image-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value.slice(0, 1500))}
                    rows={7}
                    placeholder="เช่น เจ้าของร้านกาแฟกำลังเตรียมเมล็ดกาแฟในร้านสไตล์อบอุ่น แสงเช้า มีพื้นที่ว่างด้านขวาสำหรับนำไปจัดวางข้อความภายหลัง"
                    className="w-full resize-none rounded-2xl px-5 py-4 text-[15px] leading-relaxed outline-none transition-shadow focus:ring-2 focus:ring-violet-500/50"
                    style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}
                  />
                  <div className="mt-2 flex items-start gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: ACCENT }} />
                    ระบบเติมคำสั่งห้ามตัวหนังสือ โลโก้ ป้าย และลายน้ำทุกภาษาให้อัตโนมัติ
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ระบบสร้างภาพ</p>
                      <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>เลือกเส้นทางก่อนเลือกโมเดล ระบบจะไม่สลับข้ามกัน</p>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {IMAGE_ENGINES.map(({ id, label, description, Icon }) => {
                      const active = imageEngine === id;
                      const readyCount = catalog?.imageModels.filter((item) => item.engine === id && item.available).length ?? 0;
                      const accent = id === "runpod" ? "#A78BFA" : "#F0B45A";
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => selectImageEngine(id)}
                          aria-pressed={active}
                          className="flex min-h-[74px] items-center gap-3 rounded-xl px-4 text-left transition-colors"
                          style={{
                            background: active ? (id === "runpod" ? "rgba(139,92,246,.12)" : "rgba(217,145,42,.10)") : "var(--ui-card-bg)",
                            border: active ? `1px solid ${accent}` : "1px solid var(--ui-card-border)",
                          }}
                        >
                          <Icon className="h-5 w-5 shrink-0" style={{ color: active ? accent : "var(--ui-text-muted)" }} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>{label}</span>
                            <span className="mt-0.5 block text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{description}</span>
                          </span>
                          <span className="text-[10px] font-medium" style={{ color: readyCount > 0 ? accent : "var(--ui-text-muted)" }}>
                            {readyCount > 0 ? `พร้อม ${readyCount}` : "ยังไม่เปิด"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>รูปแบบภาพ</p>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {IMAGE_STYLES.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setStyle(value)}
                        className="min-h-11 rounded-xl px-4 text-left text-sm transition-colors"
                        style={{
                          background: style === value ? "rgba(139,92,246,.12)" : "var(--ui-card-bg)",
                          border: style === value ? "1px solid rgba(139,92,246,.55)" : "1px solid var(--ui-card-border)",
                          color: style === value ? "#C9BBFF" : "var(--ui-text-secondary)",
                        }}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <label htmlFor="image-model" className="mb-2 block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>คุณภาพ</label>
                    <StudioSelect
                      id="image-model"
                      value={model}
                      onValueChange={setModel}
                      options={engineModels.map((item) => ({
                        value: item.id,
                        disabled: !item.available,
                        label: `${item.label} · ${item.credits} เครดิต${item.available
                          ? ""
                          : item.unavailableCode === "COST_POLICY_BLOCKED"
                            ? " · ต้นทุนเกินเพดาน"
                            : " · ยังไม่เชื่อม"}`,
                      }))}
                    />
                    <p className="mt-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>{selectedModel?.description}</p>
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>อัตราส่วน</p>
                    <div className="grid grid-cols-4 gap-2">
                      {ASPECTS.map((value) => (
                        <button key={value} type="button" onClick={() => setAspectRatio(value)} className="h-12 rounded-xl text-xs font-medium" style={{ background: aspectRatio === value ? "rgba(139,92,246,.12)" : "var(--ui-card-bg)", border: aspectRatio === value ? "1px solid rgba(139,92,246,.55)" : "1px solid var(--ui-card-border)", color: aspectRatio === value ? "#C9BBFF" : "var(--ui-text-muted)" }}>{value}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <button type="submit" disabled={submitting || !prompt.trim() || !selectedModel?.available} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45" style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
                  สร้างด้วย {imageEngine === "runpod" ? "RunPod AI" : "Cloud API"} · {selectedModel?.credits ?? 0} เครดิต
                </button>
                <p className="text-center text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  งานนี้ใช้เฉพาะ {imageEngine === "runpod" ? "RunPod AI" : "Cloud API"} หากไม่สำเร็จระบบจะคืนเครดิตและไม่ส่งต่อไปอีก Engine
                </p>
              </form>
            ) : mode === "voice" ? (
              <form onSubmit={submitVoice} className="space-y-7">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3" style={{ background: "rgba(139,92,246,.08)", border: "1px solid rgba(139,92,246,.24)" }}>
                  <p className="text-sm font-medium" style={{ color: "var(--ui-text-primary)" }}>{catalog?.plan} · ยาวสุด {(catalog?.voice.maxDurationSec ?? 0) / 60} นาทีต่อเสียง</p>
                  <p className="text-xs" style={{ color: "#B9A6FF" }}>คิดตามโควตานาทีแพ็กเกจ</p>
                </div>

                {!catalog?.voice.available ? (
                  <div className="rounded-2xl border border-dashed p-10 text-center" style={{ borderColor: "var(--ui-card-border)" }}>
                    <AudioLines className="mx-auto mb-3 h-6 w-6" style={{ color: "var(--ui-text-muted)" }} />
                    <p className="text-sm" style={{ color: "var(--ui-text-secondary)" }}>Hero Voice ยังไม่เปิดให้บัญชีนี้</p>
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <label htmlFor="voice-script" className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สคริปต์เสียง</label>
                        <span className="text-[11px]" style={{ color: scriptRatio > 90 ? "#FBBF24" : "var(--ui-text-muted)" }}>{script.length.toLocaleString("th-TH")}/{catalog.voice.maxScriptChars.toLocaleString("th-TH")}</span>
                      </div>
                      <textarea id="voice-script" value={script} onChange={(event) => setScript(event.target.value.slice(0, catalog.voice.maxScriptChars))} rows={10} placeholder={voiceLanguage === "lo" ? "ວາງສະຄຣິບພາສາລາວທີ່ຕ້ອງການສ້າງສຽງ..." : "วางสคริปต์ภาษาไทยที่ต้องการสร้างเสียง..."} className="w-full resize-none rounded-2xl px-5 py-4 text-[15px] leading-7 outline-none transition-shadow focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
                      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: "var(--ui-divider)" }}><div className="h-full rounded-full transition-transform" style={{ width: `${scriptRatio}%`, background: scriptRatio > 90 ? "#FBBF24" : ACCENT }} /></div>
                      <p className="mt-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>คาดการณ์ประมาณ {estimatedVoiceMinutes.toFixed(1)} นาที · ระบบจะแบ่งสคริปต์ส่ง GPU และรวมเสียงให้อัตโนมัติ</p>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ภาษาที่อ่าน</label>
                      <div className="inline-flex rounded-xl p-1" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)" }}>
                        {([["th", "🇹🇭 ไทย"], ["lo", "🇱🇦 ลาว"]] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setVoiceLanguage(value)}
                            className="flex min-h-9 items-center gap-1 rounded-lg px-4 text-sm font-medium transition-colors"
                            style={{
                              background: voiceLanguage === value ? "var(--ui-card-bg)" : "transparent",
                              color: voiceLanguage === value ? "var(--ui-text-primary)" : "var(--ui-text-muted)",
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {voiceLanguage === "lo" && (
                        <p className="mt-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                          {sharedCatalog
                            ? "วางสคริปต์อักษรลาวได้เลย — ยังไม่มีเสียงลาวเฉพาะในคลัง ระบบใช้เสียงเดิมอ่านเป็นภาษาลาวให้"
                            : "วางสคริปต์อักษรลาวได้เลย — คลังนี้เป็นเสียงสำหรับภาษาลาวโดยเฉพาะ"}
                        </p>
                      )}
                    </div>

                    <div className="grid gap-6 md:grid-cols-[1fr_180px]">
                      <div>
                        <div className="mb-2 flex items-baseline justify-between gap-2">
                          <label htmlFor="voice-id" className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>เสียง</label>
                          <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
                            {voices.length === 0
                              ? (voicesLoading ? "กำลังโหลด…" : "ยังไม่มีรายการเสียง")
                              : sharedCatalog
                                ? `ใช้ร่วมกันทุกภาษา · ${languageVoices.length} เสียง`
                                : `คลังเสียง${voiceLanguage === "lo" ? "ลาว" : "ไทย"} · ${languageVoices.length} เสียง`}
                          </span>
                        </div>
                        {voices.length === 0 && voicesError ? (
                          // โหลดรายการเสียงไม่สำเร็จ — ให้กดลองใหม่ได้ตรงนี้ ไม่ต้องรีเฟรชทั้งหน้า
                          <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5" style={{ background: "#EF44440F", border: "1px solid #EF444433" }}>
                            <span className="min-w-0 text-[11px] leading-relaxed text-red-300">{voicesError}</span>
                            <button
                              type="button"
                              onClick={() => void loadVoices().catch(() => {})}
                              disabled={voicesLoading}
                              className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold text-violet-300 transition-colors hover:bg-violet-500/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                              {voicesLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
                              ลองใหม่
                            </button>
                          </div>
                        ) : (
                          <>
                            <StudioSelect
                              id="voice-id"
                              value={voiceId}
                              onValueChange={setVoiceId}
                              placeholder={voicesLoading ? "กำลังโหลดรายการเสียง…" : "เลือกเสียง"}
                              options={languageVoices.map((voice) => ({ value: voice.voice_id, label: voice.desc || voice.voice_id, sublabel: voice.brief }))}
                            />
                            <VoicePreviewPlayer voice={languageVoices.find((voice) => voice.voice_id === voiceId)} speed={speed} />
                          </>
                        )}
                      </div>
                      <div>
                        <label htmlFor="voice-speed" className="mb-2 block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ความเร็ว</label>
                        <StudioSelect
                          id="voice-speed"
                          value={String(speed)}
                          onValueChange={(value) => setSpeed(Number(value))}
                          options={[{ value: "0.85", label: "ช้า" }, { value: "1", label: "ปกติ" }, { value: "1.15", label: "เร็ว" }]}
                        />
                      </div>
                    </div>

                    <button type="submit" disabled={submitting || !script.trim() || !voiceId} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45" style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}สร้างเสียง Hero Voice
                    </button>

                  </>
                )}
              </form>
            ) : null}
            {!loading && mode === "cloning" && (
              <div className="space-y-6">
                <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
                  <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>🎙 เสียงโคลนของฉัน <span className="text-[10px] font-normal" style={{ color: "var(--ui-text-muted)" }}>(OmniVoice)</span></p>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
                    อัปไฟล์เสียงพูดชัด ๆ 5–30 วินาที (mp3/wav/m4a) — ระบบจะเลียนเสียงนี้ตอนสร้างเสียงพูด เว้นข้อความว่างไว้ได้ ระบบจะถอดข้อความในไฟล์ให้อัตโนมัติ (หรือพิมพ์เองให้ตรงเป๊ะถ้าอยากคุมเอง)
                  </p>
                  {cloneVoices !== null && cloneVoices.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {cloneVoices.map((voice) => (
                        <li key={voice.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2" style={{ border: "1px solid var(--ui-divider)" }}>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>{voice.name}</p>
                            <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{(voice.durationMs / 1000).toFixed(1)} วิ</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <div className="w-52 max-w-full"><AudioBar dense src={`/api/omnivoice/user-voices/${encodeURIComponent(voice.id)}`} /></div>
                            <button type="button" onClick={() => removeCloneVoice(voice.id)} className="text-[11px] text-red-400 hover:underline">ลบ</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 grid gap-3">
                    <input value={cloneName} onChange={(event) => setCloneName(event.target.value.slice(0, 60))} placeholder="ชื่อเสียง เช่น เสียงพากย์ของฉัน" className="h-10 w-full rounded-xl px-3 text-sm outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
                    <textarea value={cloneRefText} onChange={(event) => setCloneRefText(event.target.value.slice(0, 500))} rows={2} placeholder="พิมพ์ข้อความที่พูดในไฟล์เสียง (ต้องตรงคำต่อคำ) — เว้นว่างได้ ระบบจะถอดให้อัตโนมัติ" className="w-full resize-none rounded-xl px-3 py-2 text-sm outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
                    <div className="grid gap-2 md:grid-cols-2">
                      {/* อัดเสียงสดจากไมค์ — จับเวลา + หยุดเองที่เพดาน 30 วิ */}
                      <button
                        type="button"
                        onClick={() => (recording ? stopRecording() : void startRecording())}
                        className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl px-4 py-3 text-center transition-colors"
                        style={{
                          border: `1.5px ${recording ? "solid #EF4444" : "dashed var(--ui-card-border)"}`,
                          background: recording ? "#EF444414" : "transparent",
                        }}
                      >
                        <span className="flex items-center gap-2 text-xs font-semibold" style={{ color: recording ? "#EF4444" : "var(--ui-text-primary)" }}>
                          {recording ? <Square className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
                          {recording ? `กำลังอัด ${recordSec.toFixed(0)} / ${REF_MAX_SEC} วิ — แตะเพื่อหยุด` : "อัดเสียงจากไมค์"}
                        </span>
                        <span className="text-[10px]" style={{ color: recording ? "#EF4444" : "var(--ui-text-muted)" }}>
                          {recording ? "พูดข้อความที่พิมพ์ไว้ด้านบนให้ครบ" : `พูดต่อเนื่อง ${REF_MIN_SEC}–${REF_MAX_SEC} วิ (แนะนำ 10–20 วิ)`}
                        </span>
                      </button>
                      <label
                        className="flex min-h-[72px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl px-4 py-3 text-center transition-colors"
                        style={{
                          border: `1.5px dashed ${cloneFile ? ACCENT : "var(--ui-card-border)"}`,
                          background: cloneFile ? `${ACCENT}12` : "transparent",
                        }}
                      >
                        <input type="file" accept="audio/*,.m4a" className="hidden" onChange={(event) => void selectCloneFile(event.target.files?.[0] ?? null)} />
                        <span className="flex items-center gap-2 text-xs font-semibold" style={{ color: cloneFile ? ACCENT : "var(--ui-text-primary)" }}>
                          <AudioLines className="h-4 w-4" />
                          {cloneFile ? cloneFile.name : "หรือเลือกไฟล์เสียง"}
                        </span>
                        <span className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
                          {cloneFile ? `${(cloneFile.size / (1024 * 1024)).toFixed(2)} MB · แตะเพื่อเปลี่ยนไฟล์` : `mp3 / wav / m4a / webm · ${REF_MIN_SEC}–${REF_MAX_SEC} วินาที`}
                        </span>
                      </label>
                    </div>
                    {cloneFile && cloneFileDurationSec !== null && (() => {
                      // สถานะความยาวไฟล์อ้างอิง — แยกสี/ไอคอน/คำอธิบายจากค่าเดียว
                      // เพื่อไม่ให้เงื่อนไขซ้ำสามที่เหมือนเวอร์ชันข้อความลอย ๆ เดิม
                      const tooShort = cloneFileDurationSec < REF_MIN_SEC;
                      const tooLong = cloneFileDurationSec > REF_MAX_SEC;
                      const invalid = tooShort || tooLong;
                      const tone = invalid ? "#EF4444" : "#34D399";
                      return (
                        <div
                          className="flex items-center gap-2.5 rounded-xl px-3 py-2"
                          style={{ background: `${tone}0F`, border: `1px solid ${tone}33` }}
                        >
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full" style={{ background: `${tone}22` }}>
                            {invalid
                              ? <AlertTriangle className="h-3 w-3" style={{ color: tone }} aria-hidden="true" />
                              : <Check className="h-3 w-3" style={{ color: tone }} aria-hidden="true" />}
                          </span>
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold tabular-nums" style={{ color: tone }}>
                              ความยาวเสียง {cloneFileDurationSec.toFixed(1)} วินาที
                              {invalid ? "" : " · พร้อมใช้โคลน"}
                            </p>
                            {invalid && (
                              <p className="text-[10px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
                                {tooShort
                                  ? `สั้นเกินไป — ต้องพูดต่อเนื่องอย่างน้อย ${REF_MIN_SEC} วินาที`
                                  : `ยาวเกิน ${REF_MAX_SEC} วินาที — ตัดช่วงที่พูดชัด ๆ มา 10–20 วินาทีพอ`}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {cloneFile && cloneFileUrl && (
                      <CloneRefPlayer file={cloneFile} url={cloneFileUrl} onRemove={() => void selectCloneFile(null)} />
                    )}
                    <button
                      type="button"
                      onClick={submitCloneVoice}
                      disabled={
                        cloneSubmitting || recording || !cloneFile || !cloneName.trim()
                        || (cloneFileDurationSec !== null && (cloneFileDurationSec < REF_MIN_SEC || cloneFileDurationSec > REF_MAX_SEC))
                      }
                      className="flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                      style={{ color: ACCENT, border: `1px solid ${ACCENT}66` }}
                    >
                      {cloneSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                      {cloneSubmitting ? "กำลังสร้างเสียงโคลน..." : "สร้างเสียงโคลน"}
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
                  <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ให้เสียงโคลนพูด</p>
                  <div className="mt-3 grid gap-3">
                    <StudioSelect
                      value={cloneVoiceId}
                      onValueChange={setCloneVoiceId}
                      placeholder="— เลือกเสียงโคลน —"
                      triggerClassName="h-11"
                      options={(cloneVoices ?? []).map((voice) => ({ value: voice.voiceId, label: voice.name }))}
                    />
                    <div>
                      <span className="mb-1 block text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ภาษาที่ให้พูด</span>
                      <div role="radiogroup" aria-label="ภาษาที่เสียงโคลนพูด" className="inline-flex rounded-xl p-1" style={{ background: "var(--ui-badge-neutral-bg)", border: "1px solid var(--ui-card-border)" }}>
                        {([["th", "🇹🇭 ไทย"], ["lo", "🇱🇦 ลาว"]] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={cloneLanguage === value}
                            disabled={value === "lo" && !laoSupported}
                            title={value === "lo" && !laoSupported ? "backend ปัจจุบันยังไม่รองรับภาษาลาว" : undefined}
                            onClick={() => setCloneLanguage(value)}
                            className="min-h-9 rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{
                              background: cloneLanguage === value ? "var(--ui-card-bg)" : "transparent",
                              color: cloneLanguage === value ? "var(--ui-text-primary)" : "var(--ui-text-muted)",
                              outlineColor: ACCENT,
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
                        {laoSupported
                          ? "เสียงโคลนพูดได้ทั้งสองภาษา — เลือกให้ตรงกับข้อความด้านล่าง ไม่งั้นโมเดลจะเดาภาษาเองแล้วออกเสียงผิดสำเนียง"
                          : "backend ปัจจุบัน (RunPod) ยังไม่รองรับภาษาลาว — สลับไป Hero Voice แบบ local ถึงจะเลือกได้"}
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>ข้อความ</span>
                        <span className="text-[11px]" style={{ color: cloningScript.length > 450 ? "#FBBF24" : "var(--ui-text-muted)" }}>{cloningScript.length}/500</span>
                      </div>
                      <textarea value={cloningScript} onChange={(event) => setCloningScript(event.target.value.slice(0, 500))} rows={5} placeholder={cloneLanguage === "lo" ? "ພິມຂໍ້ຄວາມສັ້ນໆ ທີ່ຢາກໃຫ້ສຽງໂຄລນເວົ້າ..." : "พิมพ์ข้อความสั้น ๆ ที่อยากให้เสียงโคลนพูด..."} className="w-full resize-none rounded-xl px-3 py-2 text-sm leading-6 outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
                    </div>
                    <StudioSelect
                      value={String(speed)}
                      onValueChange={(value) => setSpeed(Number(value))}
                      triggerClassName="h-11"
                      options={[{ value: "0.85", label: "ช้า" }, { value: "1", label: "ปกติ" }, { value: "1.15", label: "เร็ว" }]}
                    />
                    <button
                      type="button"
                      onClick={() => void runCloneEngine()}
                      disabled={omniSubmitting || !cloningScript.trim() || !cloneVoiceId}
                      className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                      style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}
                    >
                      {omniSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}
                      สร้างเสียงโคลน
                    </button>
                    <CompareSlot
                      label="Hero Voice (Omni)"
                      sublabel="OmniVoice"
                      job={omniRun?.jobId ? jobs.find((job) => job.id === omniRun.jobId) ?? null : null}
                      error={omniRun?.error ?? null}
                      waiting={omniSubmitting}
                      idle={!omniRun}
                    />
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="lg:border-l lg:pl-7" style={{ borderColor: "var(--ui-divider)" }}>
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ผลงานล่าสุด</p>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>ภาพและเสียงจาก AI Studio</p>
              </div>
              <button type="button" onClick={() => void loadJobs()} className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ border: "1px solid var(--ui-card-border)", color: "var(--ui-text-muted)" }} aria-label="รีเฟรช"><RefreshCw className="h-4 w-4" /></button>
            </div>
            {jobs.length ? jobs.slice(0, 12).map((job) => (
              <ResultItem key={job.id} job={job} />
            )) : (
              <div className="rounded-2xl border border-dashed px-6 py-12 text-center" style={{ borderColor: "var(--ui-card-border)" }}>
                <Sparkles className="mx-auto mb-3 h-5 w-5" style={{ color: ACCENT }} />
                <p className="text-sm" style={{ color: "var(--ui-text-secondary)" }}>ผลงานแรกจะปรากฏตรงนี้</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
