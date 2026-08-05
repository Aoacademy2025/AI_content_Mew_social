// T5 (hv-emotion) — ref-hunting + eval-matrix runner against this experiment's
// own staging endpoint (d66lniwmhsjt51, v13 dynref image). NEVER touches
// production (txvrmtzfc8au3b) or any other staging resource.
//
// Modes (run in order; each is idempotent/resumable via run-manifest.json):
//   npx tsx scripts/hv-emotion-run-matrix.ts refhunt   — Step 1 candidate generation
//   npx tsx scripts/hv-emotion-run-matrix.ts matrix    — Step 2 eval matrix (needs refhunt-selection.json)
//
// Progress survives interruption: every completed/failed job is appended to
// run-manifest.json immediately, and re-running a mode skips any (persona,
// label) key that already has a "completed" entry.
import dotenv from "dotenv";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { splitScriptForTts } from "../src/lib/tts-timing";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const REST_BASE = "https://rest.runpod.io/v1";
const QUEUE_BASE = "https://api.runpod.ai/v2";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging (this experiment's own)
const EXPECTED_WORKER_VERSION = "heroai-omnivoice-runpod-v8-all-voices-32-temp-dynref";

const ARTIFACT_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const REFHUNT_DIR = path.join(ARTIFACT_ROOT, "refhunt");
const EVAL_DIR = path.join(ARTIFACT_ROOT, "eval");
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, "run-manifest.json");
const REFHUNT_SELECTION_PATH = path.join(ARTIFACT_ROOT, "refhunt-selection.json");

// ── Budget (T5 brief hard constraint: this task's own remaining budget) ────
const SPEND_CAP_USD = 4.8;
const SPEND_SOFT_STOP_USD = 4.0; // degrade before hitting the hard cap
const JOB_CAP = 650;
const SMOKE_JOBS_ALREADY_SPENT = 2; // Step 0.3 (smoke-hv-emotion-v13.ts)

// ── Personas (T1 final 16, docs/research/2026-07-24-hero-voice-persona-shortlist.json) ─
type Archetype = "R1" | "R2" | "R3" | "R4";
type Persona = { id: string; gender: string; band: string; f0Hz: number; archetype: Archetype };

// Mapping rule (documented in task-5-report.md): R1 female mid-high/high,
// R2 male deep, R3 male/female mid-low, R4 child/neutral + playful-high
// (the remaining mid-high males/high-pitch personas that don't fit R1/R2/R3).
const PERSONAS: Persona[] = [
  { id: "voice_31", gender: "F", band: "mid-high", f0Hz: 198.3, archetype: "R1" },
  { id: "voice_13", gender: "F", band: "mid-high", f0Hz: 207.1, archetype: "R1" },
  { id: "voice_15", gender: "F", band: "mid-high", f0Hz: 258.7, archetype: "R1" },
  { id: "voice_43", gender: "F", band: "mid-high", f0Hz: 223.9, archetype: "R1" },
  { id: "voice_26", gender: "F", band: "high", f0Hz: 389.9, archetype: "R1" },
  { id: "voice_42", gender: "M", band: "deep", f0Hz: 124.2, archetype: "R2" },
  { id: "voice_48", gender: "M", band: "deep", f0Hz: 98.3, archetype: "R2" },
  { id: "voice_27", gender: "M", band: "deep", f0Hz: 96.3, archetype: "R2" },
  { id: "voice_38", gender: "M", band: "deep", f0Hz: 93.3, archetype: "R2" },
  { id: "voice_40", gender: "M", band: "mid-low", f0Hz: 148.6, archetype: "R3" },
  { id: "voice_11", gender: "M", band: "mid-low", f0Hz: 134.7, archetype: "R3" },
  { id: "voice_47", gender: "F", band: "mid-low", f0Hz: 174.2, archetype: "R3" },
  { id: "voice_18", gender: "F", band: "mid-high", f0Hz: 248.5, archetype: "R4" }, // child
  { id: "voice_07", gender: "N", band: "high", f0Hz: 345.3, archetype: "R4" }, // child, gender-neutral
  { id: "voice_21", gender: "M", band: "mid-high", f0Hz: 220.1, archetype: "R4" }, // teenager, high pitch
  { id: "voice_46", gender: "M", band: "mid-high", f0Hz: 231.8, archetype: "R4" }, // high pitch
];

const REF_SCRIPTS: Record<Archetype, string> = {
  R1: "ว้าว! อันนี้ดีมากเลยนะ รู้ไหมว่าทำไม? เพราะมันเปลี่ยนทุกอย่างที่เราเคยรู้ไปเลย ลองฟังดีๆ นะ แล้วคุณจะทึ่งเหมือนกัน!",
  R2: "คืนนั้นฝนตกหนักมาก ผมนั่งมองออกไปนอกหน้าต่าง แล้วก็คิดถึงคำที่แม่เคยบอกไว้ ว่าไม่ว่าจะเหนื่อยแค่ไหน พรุ่งนี้ก็มาถึงเสมอ",
  R3: "ถามจริงๆ เถอะ คุณจะรอไปถึงเมื่อไหร่? โอกาสแบบนี้ไม่ได้มีทุกวันนะครับ ตัดสินใจวันนี้ แล้วชีวิตคุณจะไม่เหมือนเดิมอีกเลย!",
  R4: "เฮ้! มานี่เร็วๆ มีอะไรจะให้ดู อันนี้เจ๋งสุดๆ ไปเลย ดูสิ ดูสิ! เห็นไหมว่ามันน่ารักแค่ไหน อิอิ",
};

const S1 = "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง";
const S2 = "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา";
const S3 = "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด";

// Non-verbal tags variant: [surprise-ah] (gasp-like surprised interjection —
// closest of the upstream 13 fixed tags to a "gasp" opener) prepended to S1's
// hook. Documented exactly here + in task-5-report.md per the brief.
const S1_WITH_TAGS = `[surprise-ah] ${S1}`;

const REF_HUNT_TEMPS_MANDATORY = [1.0, 2.0, 3.0];
const REF_HUNT_TEMPS_OPTIONAL = [1.5, 2.5];
const MATRIX_TEMPS = [0.0, 1.0, 2.0];

// ── Manifest (append-only, resumable) ───────────────────────────────────────
type ManifestEntry = {
  key: string; // unique (persona, arm-label) resumability key
  persona: string;
  phase: "refhunt" | "eval-main" | "eval-tags" | "eval-chunk";
  label: string;
  params: Record<string, unknown>;
  refAudioSha256?: string;
  jobId?: string;
  status: "completed" | "failed";
  error?: string;
  delayTime?: number;
  executionTime?: number;
  wallMs?: number;
  duration?: number;
  wavPath?: string;
  submittedAt: string;
};

function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return [];
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function appendManifestEntry(entries: ManifestEntry[], entry: ManifestEntry) {
  entries.push(entry);
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

function jobsUsed(entries: ManifestEntry[]): number {
  return SMOKE_JOBS_ALREADY_SPENT + entries.length;
}

// ── RunPod plumbing (same pattern as smoke-hv-emotion-v13.ts) ──────────────
type Job = {
  id?: string;
  status?: string;
  delayTime?: number;
  executionTime?: number;
  error?: string;
  output?: {
    audio_base64?: string;
    format?: string;
    duration?: number;
    worker_version?: string;
    language?: string;
    num_step?: number;
    class_temperature?: number;
    ref_source?: string;
  };
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`${url} returned non-JSON status ${response.status}: ${source.slice(0, 300)}`);
  }
  if (!response.ok) {
    const redactWorkers = (value: unknown): unknown =>
      value && typeof value === "object" && "workers" in value
        ? { ...(value as Record<string, unknown>), workers: "[redacted]" }
        : value;
    const safeBody = Array.isArray(body) ? body.map(redactWorkers) : redactWorkers(body);
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `${url} failed with status ${response.status}: ${JSON.stringify(safeBody)}`;
    throw new Error(message);
  }
  return body as T;
}

// RunPod GPU-pool throttling has been observed to exceed 10 minutes before a
// worker becomes available (ref-hunt phase: ~10-11 min throttled before the
// first job started). 25 minutes gives real margin above that without
// hanging forever. On a client-side timeout we CANCEL the job (never just
// abandon it) so it can't keep running/billing unaccounted-for and can't
// collide with a later resubmission of the same (persona, label) key.
async function submitAndPoll(input: Record<string, unknown>): Promise<{ job: Job; wallMs: number }> {
  const wallStartedAt = Date.now();
  const submitted = await jsonRequest<Job>(`${QUEUE_BASE}/${ENDPOINT_ID}/run`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  if (!submitted.id) throw new Error("RunPod returned no job id");
  const deadline = Date.now() + 25 * 60_000;
  let job = submitted;
  try {
    while (job.status !== "COMPLETED") {
      if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) {
        throw new Error(`${job.id}: ${job.error || job.status || "job failed"}`);
      }
      if (Date.now() >= deadline) throw new Error(`${job.id}: exceeded 25 minutes`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      job = await jsonRequest<Job>(`${QUEUE_BASE}/${ENDPOINT_ID}/status/${submitted.id}`);
    }
  } catch (error) {
    try {
      await jsonRequest(`${QUEUE_BASE}/${ENDPOINT_ID}/cancel/${submitted.id}`, { method: "POST" });
      console.log(JSON.stringify({ event: "cancelled-timed-out-job", jobId: submitted.id }));
    } catch (cancelError) {
      console.log(JSON.stringify({ event: "cancel-failed", jobId: submitted.id, error: String(cancelError) }));
    }
    throw error;
  }
  return { job, wallMs: Date.now() - wallStartedAt };
}

async function getBalance(): Promise<number> {
  const response = await fetch("https://api.runpod.io/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
  });
  const body = (await response.json()) as { data?: { myself?: { clientBalance?: number } } };
  const balance = body.data?.myself?.clientBalance;
  if (typeof balance !== "number") throw new Error("could not read RunPod balance");
  return balance;
}

async function waitForScaleDown(idleTimeoutSeconds = 60): Promise<void> {
  const deadline = Date.now() + (idleTimeoutSeconds + 300) * 1_000;
  let consecutiveStoppedChecks = 0;
  while (Date.now() < deadline) {
    const endpoints = await jsonRequest<Array<{ id: string; workers?: Array<{ id?: string; desiredStatus?: string }> }>>(
      `${REST_BASE}/endpoints?includeWorkers=true`,
    );
    const current = endpoints.find((item) => item.id === ENDPOINT_ID);
    const workers = current?.workers ?? [];
    const scrubbedWorkers = workers.map((worker) => ({ id: worker.id, desiredStatus: worker.desiredStatus }));
    const activeWorkers = workers.filter((worker) => worker.desiredStatus !== "EXITED");
    if (activeWorkers.length === 0) {
      consecutiveStoppedChecks += 1;
      if (consecutiveStoppedChecks >= 2) {
        console.log(JSON.stringify({ event: "scale-down-confirmed", workers: scrubbedWorkers }));
        return;
      }
    } else {
      consecutiveStoppedChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`worker did not scale down after ${idleTimeoutSeconds + 300} seconds`);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ── Job runner with budget guard + resumability ─────────────────────────────
let manifestEntries: ManifestEntry[] = [];
let balanceCheckCounter = 0;
let spendSoftStopTripped = false;

async function runOne(
  key: string,
  persona: string,
  phase: ManifestEntry["phase"],
  label: string,
  input: Record<string, unknown>,
  wavOutPath: string,
): Promise<ManifestEntry | null> {
  const existing = manifestEntries.find((e) => e.key === key && e.status === "completed");
  if (existing) {
    console.log(JSON.stringify({ event: "skip-already-done", key }));
    return existing;
  }
  if (spendSoftStopTripped) {
    console.log(JSON.stringify({ event: "skip-soft-stop", key }));
    return null;
  }
  if (jobsUsed(manifestEntries) >= JOB_CAP) {
    console.log(JSON.stringify({ event: "skip-job-cap", key }));
    spendSoftStopTripped = true;
    return null;
  }

  balanceCheckCounter += 1;
  if (balanceCheckCounter % 30 === 0) {
    try {
      const balance = await getBalance();
      const spent = INITIAL_BALANCE - balance;
      console.log(JSON.stringify({ event: "balance-check", balance, spentSoFar: Number(spent.toFixed(4)) }));
      if (spent >= SPEND_SOFT_STOP_USD) {
        console.log(JSON.stringify({ event: "soft-stop-triggered", spent }));
        spendSoftStopTripped = true;
        return null;
      }
    } catch (error) {
      console.log(JSON.stringify({ event: "balance-check-failed", error: String(error) }));
    }
  }

  const submittedAt = new Date().toISOString();
  try {
    const { job, wallMs } = await submitAndPoll(input);
    const output = job.output;
    if (!output?.audio_base64 || output.format !== "wav") throw new Error("missing/invalid WAV output");
    if (output.worker_version !== EXPECTED_WORKER_VERSION) {
      throw new Error(`unexpected worker_version ${output.worker_version}`);
    }
    const wavBuffer = Buffer.from(output.audio_base64, "base64");
    mkdirSync(path.dirname(wavOutPath), { recursive: true });
    writeFileSync(wavOutPath, wavBuffer);
    const entry: ManifestEntry = {
      key,
      persona,
      phase,
      label,
      params: input,
      refAudioSha256: typeof input.ref_audio_b64 === "string" ? sha256Hex(Buffer.from(input.ref_audio_b64 as string, "base64")) : undefined,
      jobId: job.id,
      status: "completed",
      delayTime: job.delayTime,
      executionTime: job.executionTime,
      wallMs,
      duration: output.duration,
      wavPath: path.relative(path.resolve(__dirname, ".."), wavOutPath),
      submittedAt,
    };
    appendManifestEntry(manifestEntries, entry);
    console.log(JSON.stringify({ event: "job-done", key, jobId: job.id, wallMs, duration: output.duration }));
    return entry;
  } catch (error) {
    const entry: ManifestEntry = {
      key,
      persona,
      phase,
      label,
      params: input,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      submittedAt,
    };
    appendManifestEntry(manifestEntries, entry);
    console.log(JSON.stringify({ event: "job-failed", key, error: entry.error }));
    return null;
  }
}

let INITIAL_BALANCE = 0;

// ── Step 1: ref hunting ──────────────────────────────────────────────────
async function runRefHunt() {
  for (const persona of PERSONAS) {
    const refScript = REF_SCRIPTS[persona.archetype];
    const temps = [...REF_HUNT_TEMPS_MANDATORY];
    // extend with optional temps only while budget allows (degradation order:
    // drop 2.5/1.5 first if caps bite)
    if (!spendSoftStopTripped && jobsUsed(manifestEntries) < JOB_CAP - 100) {
      temps.push(...REF_HUNT_TEMPS_OPTIONAL);
    }
    for (const temp of temps) {
      const key = `refhunt:${persona.id}:t${temp}`;
      const label = `temp${temp}`;
      const wavPath = path.join(REFHUNT_DIR, `${persona.id}__t${temp}.wav`);
      await runOne(key, persona.id, "refhunt", label, {
        operation: "tts",
        voice_id: persona.id,
        text: refScript,
        num_step: 32,
        speed: 1,
        class_temperature: temp,
      }, wavPath);
    }
  }
  console.log(JSON.stringify({ event: "refhunt-generation-complete", jobsUsed: jobsUsed(manifestEntries) }));
}

// ── Step 2: eval matrix ──────────────────────────────────────────────────
type RefSelection = { persona: string; rank: 1 | 2; temp: number; wavPath: string; refText: string };

function loadRefSelections(): RefSelection[] {
  if (!existsSync(REFHUNT_SELECTION_PATH)) {
    throw new Error(`${REFHUNT_SELECTION_PATH} not found — run the refhunt-select step first`);
  }
  return JSON.parse(readFileSync(REFHUNT_SELECTION_PATH, "utf-8"));
}

async function runEvalMatrix() {
  const selections = loadRefSelections();
  const byPersona = new Map<string, RefSelection[]>();
  for (const sel of selections) {
    if (!byPersona.has(sel.persona)) byPersona.set(sel.persona, []);
    byPersona.get(sel.persona)!.push(sel);
  }

  for (const persona of PERSONAS) {
    const refs = (byPersona.get(persona.id) ?? []).sort((a, b) => a.rank - b.rank);
    if (refs.length === 0) {
      console.log(JSON.stringify({ event: "skip-persona-no-refs", persona: persona.id }));
      continue;
    }
    const refBuffers = refs.map((r) => ({ ...r, audioB64: readFileSync(path.resolve(__dirname, "..", r.wavPath)).toString("base64") }));

    // main 18: top-2 refs x temp{0,1,2} x {S1,S2,S3}
    for (const ref of refBuffers) {
      for (const temp of MATRIX_TEMPS) {
        for (const [sLabel, sText] of [["S1", S1], ["S2", S2], ["S3", S3]] as const) {
          const key = `eval-main:${persona.id}:ref${ref.rank}:t${temp}:${sLabel}`;
          const label = `ref${ref.rank}_t${temp}_${sLabel}`;
          const wavPath = path.join(EVAL_DIR, persona.id, `${label}.wav`);
          await runOne(key, persona.id, "eval-main", label, {
            operation: "tts",
            voice_id: persona.id,
            text: sText,
            num_step: 32,
            speed: 1,
            class_temperature: temp,
            ref_audio_b64: ref.audioB64,
            ref_text: ref.refText,
          }, wavPath);
        }
      }
    }

    // tags variant: S1 only, top-1 ref, 3 temps
    if (!spendSoftStopTripped) {
      const top1 = refBuffers[0];
      for (const temp of MATRIX_TEMPS) {
        const key = `eval-tags:${persona.id}:t${temp}`;
        const label = `ref1_t${temp}_S1tags`;
        const wavPath = path.join(EVAL_DIR, persona.id, `${label}.wav`);
        await runOne(key, persona.id, "eval-tags", label, {
          operation: "tts",
          voice_id: persona.id,
          text: S1_WITH_TAGS,
          num_step: 32,
          speed: 1,
          class_temperature: temp,
          ref_audio_b64: top1.audioB64,
          ref_text: top1.refText,
        }, wavPath);
      }
    }

    // chunking variant: S2 only, top-1 ref, temp 1.0, chunk 300 vs 700
    // (uses the app's REAL splitScriptForTts — same function production uses)
    if (!spendSoftStopTripped) {
      const top1 = refBuffers[0];
      for (const cap of [300, 700]) {
        const chunks = splitScriptForTts(S2, cap);
        const chunkWavs: Buffer[] = [];
        let allOk = true;
        for (let i = 0; i < chunks.length; i++) {
          const key = `eval-chunk:${persona.id}:cap${cap}:chunk${i}`;
          const label = `ref1_t1.0_S2chunk${cap}_part${i}`;
          const wavPath = path.join(EVAL_DIR, persona.id, `${label}.wav`);
          const entry = await runOne(key, persona.id, "eval-chunk", label, {
            operation: "tts",
            voice_id: persona.id,
            text: chunks[i].text,
            num_step: 32,
            speed: 1,
            class_temperature: 1.0,
            ref_audio_b64: top1.audioB64,
            ref_text: top1.refText,
          }, wavPath);
          if (!entry) { allOk = false; break; }
          chunkWavs.push(readFileSync(path.resolve(__dirname, "..", entry.wavPath!)));
        }
        if (allOk && chunkWavs.length > 0) {
          const concatPath = path.join(EVAL_DIR, persona.id, `ref1_t1.0_S2chunk${cap}.wav`);
          writeFileSync(concatPath, concatWavPcm16Mono(chunkWavs));
          console.log(JSON.stringify({ event: "chunk-concat", persona: persona.id, cap, parts: chunks.length, path: path.relative(path.resolve(__dirname, ".."), concatPath) }));
        }
      }
    }
  }
  console.log(JSON.stringify({ event: "eval-matrix-generation-complete", jobsUsed: jobsUsed(manifestEntries) }));
}

// Minimal WAV (PCM16 mono) concatenation — every input here comes from this
// worker's own sf.write(..., subtype="PCM_16") output, so format is uniform;
// no resampling/format-negotiation needed.
function concatWavPcm16Mono(wavs: Buffer[]): Buffer {
  if (wavs.length === 1) return wavs[0];
  function readWav(buf: Buffer) {
    let offset = 12;
    let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null;
    let data: Buffer | null = null;
    while (offset < buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = buf.subarray(offset + 8, offset + 8 + size);
      if (id === "fmt ") {
        fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
      } else if (id === "data") {
        data = body;
      }
      offset += 8 + size + (size % 2);
    }
    if (!fmt || !data) throw new Error("invalid WAV: missing fmt/data chunk");
    return { fmt, data };
  }
  const parsed = wavs.map(readWav);
  const { channels, sampleRate, bitsPerSample } = parsed[0].fmt;
  for (const p of parsed) {
    if (p.fmt.channels !== channels || p.fmt.sampleRate !== sampleRate || p.fmt.bitsPerSample !== bitsPerSample) {
      throw new Error("WAV format mismatch across chunks, cannot concatenate");
    }
  }
  const dataConcat = Buffer.concat(parsed.map((p) => p.data));
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataConcat.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataConcat.length, 40);
  return Buffer.concat([header, dataConcat]);
}

async function main() {
  const mode = process.argv[2];
  if (!["refhunt", "matrix"].includes(mode)) {
    throw new Error("usage: npx tsx scripts/hv-emotion-run-matrix.ts <refhunt|matrix>");
  }
  manifestEntries = loadManifest();
  INITIAL_BALANCE = await getBalance();
  console.log(JSON.stringify({ event: "start", mode, initialBalance: INITIAL_BALANCE, jobsUsedSoFar: jobsUsed(manifestEntries) }));

  if (mode === "refhunt") {
    await runRefHunt();
  } else {
    await runEvalMatrix();
  }

  const finalBalance = await getBalance();
  console.log(JSON.stringify({
    event: "phase-complete",
    mode,
    jobsUsed: jobsUsed(manifestEntries),
    finalBalance,
    spentThisRun: Number((INITIAL_BALANCE - finalBalance).toFixed(4)),
  }));

  await waitForScaleDown(60);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "matrix run failed");
  process.exit(1);
});
