"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Check,
  Cloud,
  Coins,
  Download,
  ImageIcon,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { customerGenerationErrorCopy } from "@/lib/customer-generation-error";
import { customerApiErrorMessage } from "@/lib/customer-api-error";
import HeroVoiceClonePanel from "./HeroVoiceClonePanel";

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
  voice: { available: boolean; cloning: boolean; maxDurationSec: number; maxScriptChars: number };
  plan: string;
  balance: { granted: number; promotional: number; purchased: number; total: number };
};
type Voice = { voice_id: string; desc: string; instruct: string; preview_url: string };
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

function formatJobTime(iso: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
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
  const engineLabel = job.kind === "voice"
    ? "Hero Voice"
    : job.provider === "runpod" ? "RunPod AI" : "Cloud API";
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
        <audio controls preload="none" src={job.outputUrl} className="mb-3 w-full" />
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
          <p className="line-clamp-2 text-sm font-medium leading-relaxed" style={{ color: "var(--ui-text-primary)" }}>
            {job.inputPreview || (job.kind === "voice" ? "เสียงจาก Hero Voice" : "AI artwork")}
          </p>
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
  const [voiceId, setVoiceId] = useState("");
  const [script, setScript] = useState("");
  const [speed, setSpeed] = useState(1);

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
    const response = await fetch("/api/omnivoice/voices", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) throw new Error(apiMessage(data, "โหลดรายการเสียงไม่สำเร็จ"));
    setVoices(data as Voice[]);
    setVoiceId((current) => (data as Voice[]).some((voice) => voice.voice_id === current)
      ? current
      : (data[0] as Voice | undefined)?.voice_id ?? "");
  }, []);

  useEffect(() => {
    if (!catalog?.voice.available) return;
    loadVoices().catch((error) => toast.error(error instanceof Error ? error.message : "โหลดรายการเสียงไม่สำเร็จ"));
  }, [catalog?.voice.available, loadVoices]);

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
      setScript("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างเสียงไม่สำเร็จ");
    } finally {
      setSubmitting(false);
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
              สร้างภาพ สร้างเสียง และจัดการเสียงโคลนส่วนตัวจากพื้นที่เดียว
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
                    <select id="image-model" value={model} onChange={(event) => setModel(event.target.value)} className="h-12 w-full rounded-xl px-4 text-sm outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}>
                      {engineModels.map((item) => (
                        <option key={item.id} value={item.id} disabled={!item.available}>
                          {item.label} · {item.credits} เครดิต{item.available
                            ? ""
                            : item.unavailableCode === "COST_POLICY_BLOCKED"
                              ? " · ต้นทุนเกินเพดาน"
                              : " · ยังไม่เชื่อม"}
                        </option>
                      ))}
                    </select>
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
                      <textarea id="voice-script" value={script} onChange={(event) => setScript(event.target.value.slice(0, catalog.voice.maxScriptChars))} rows={10} placeholder="วางสคริปต์ภาษาไทยที่ต้องการสร้างเสียง..." className="w-full resize-none rounded-2xl px-5 py-4 text-[15px] leading-7 outline-none transition-shadow focus:ring-2 focus:ring-violet-500/50" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }} />
                      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: "var(--ui-divider)" }}><div className="h-full rounded-full transition-transform" style={{ width: `${scriptRatio}%`, background: scriptRatio > 90 ? "#FBBF24" : ACCENT }} /></div>
                      <p className="mt-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>คาดการณ์ประมาณ {estimatedVoiceMinutes.toFixed(1)} นาที · ระบบจะแบ่งสคริปต์ส่ง GPU และรวมเสียงให้อัตโนมัติ</p>
                    </div>

                    <div className="grid gap-6 md:grid-cols-[1fr_180px]">
                      <div>
                        <label htmlFor="voice-id" className="mb-2 block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>เสียง</label>
                        <select id="voice-id" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} className="h-12 w-full rounded-xl px-4 text-sm outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}>
                          {voices.map((voice) => <option key={voice.voice_id} value={voice.voice_id}>{voice.desc || voice.voice_id}</option>)}
                        </select>
                        {voices.find((voice) => voice.voice_id === voiceId)?.preview_url && <audio className="mt-3 h-9 w-full" controls preload="none" src={voices.find((voice) => voice.voice_id === voiceId)!.preview_url} />}
                      </div>
                      <div>
                        <label htmlFor="voice-speed" className="mb-2 block text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ความเร็ว</label>
                        <select id="voice-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="h-12 w-full rounded-xl px-4 text-sm outline-none" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-primary)" }}>
                          <option value={0.85}>ช้า · 0.85×</option><option value={1}>ปกติ · 1×</option><option value={1.15}>เร็ว · 1.15×</option><option value={1.3}>เร็วมาก · 1.3×</option>
                        </select>
                      </div>
                    </div>

                    <button type="submit" disabled={submitting || !script.trim() || !voiceId} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45" style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}สร้างเสียง Hero Voice
                    </button>
                  </>
                )}
              </form>
            ) : (
              <HeroVoiceClonePanel
                maxScriptChars={catalog?.voice.maxScriptChars ?? 500}
                onVoicesChanged={loadVoices}
                onJobCreated={(created) => {
                  const job = created as StudioJob;
                  setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
                }}
              />
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
