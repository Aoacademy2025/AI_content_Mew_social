// T6 (hv-emotion) — production-faithful fidelity re-renders against this
// experiment's own staging endpoint (d66lniwmhsjt51, v13 dynref image, same
// as T5 — worker NOT edited this task). NEVER touches production
// (txvrmtzfc8au3b) or any other staging resource.
//
// Modes (run in order; each idempotent/resumable via its own run-manifest.json,
// kept separate from T5's 167MB matrix/run-manifest.json per the brief's
// "never load it whole" hygiene rule — this task writes its own small manifest):
//   npx tsx scripts/hv-emotion-t6-fidelity-rerender.ts baseline  — Step 1.1 true baseline (48 jobs)
//   npx tsx scripts/hv-emotion-t6-fidelity-rerender.ts winners   — Step 1.2 winner S2/S3 re-render (32 jobs)
//
// Speech text: S1 submitted as-is (normalizer verified a no-op, see
// hv-emotion-print-normalized.ts output in task-6-report.md). S2/S3 submitted
// as prepareHeroVoiceSpeech(display).speechText (production-faithful).
import dotenv from "dotenv";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareHeroVoiceSpeech, HERO_VOICE_SPEECH_NORMALIZER_VERSION } from "../src/lib/hero-voice-speech";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const REST_BASE = "https://rest.runpod.io/v1";
const QUEUE_BASE = "https://api.runpod.ai/v2";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging (this experiment's own)
const EXPECTED_WORKER_VERSION = "heroai-omnivoice-runpod-v8-all-voices-32-temp-dynref";

const REPO_ROOT = path.resolve(__dirname, "..");
const MATRIX_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const WINNERS_PATH = path.join(MATRIX_ROOT, "winners.json");
const FIDELITY_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24", "fidelity");
const MANIFEST_PATH = path.join(FIDELITY_ROOT, "run-manifest.json");

// ── Budget (T6 brief hard cap: THIS task's own budget, separate from T5's) ──
const SPEND_CAP_USD = 0.6;
const SPEND_SOFT_STOP_USD = 0.55;
const JOB_CAP = 120;

// ── Personas (same 16, same mapping as T5 — task-5-report.md) ──────────────
const PERSONAS = [
  "voice_31", "voice_13", "voice_15", "voice_43", "voice_26",
  "voice_42", "voice_48", "voice_27", "voice_38",
  "voice_40", "voice_11", "voice_47",
  "voice_18", "voice_07", "voice_21", "voice_46",
];

const S1 = "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง";
const S2 = "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา";
const S3 = "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด";

// Production-faithful speech text per script (computed once at module load,
// recorded in every manifest entry's params.speechText + a top-level file).
const SPEECH: Record<"S1" | "S2" | "S3", { display: string; speechText: string }> = {
  S1: { display: S1, speechText: prepareHeroVoiceSpeech(S1).speechText },
  S2: { display: S2, speechText: prepareHeroVoiceSpeech(S2).speechText },
  S3: { display: S3, speechText: prepareHeroVoiceSpeech(S3).speechText },
};

type ManifestEntry = {
  key: string;
  persona: string;
  phase: "baseline" | "winner-rerender";
  label: string;
  script: "S1" | "S2" | "S3";
  displayText: string;
  speechText: string;
  normalizerVersion: string;
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
  mkdirSync(FIDELITY_ROOT, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}
function jobsUsed(entries: ManifestEntry[]): number {
  return entries.length;
}

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

let manifestEntries: ManifestEntry[] = [];
let balanceCheckCounter = 0;
let spendSoftStopTripped = false;
let INITIAL_BALANCE = 0;

async function runOne(
  key: string,
  persona: string,
  phase: ManifestEntry["phase"],
  label: string,
  scriptId: "S1" | "S2" | "S3",
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
  if (balanceCheckCounter % 10 === 0) {
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
  const speech = SPEECH[scriptId];
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
      script: scriptId,
      displayText: speech.display,
      speechText: speech.speechText,
      normalizerVersion: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
      params: { ...input, ref_audio_b64: input.ref_audio_b64 ? "[omitted]" : undefined },
      refAudioSha256: typeof input.ref_audio_b64 === "string" ? sha256Hex(Buffer.from(input.ref_audio_b64 as string, "base64")) : undefined,
      jobId: job.id,
      status: "completed",
      delayTime: job.delayTime,
      executionTime: job.executionTime,
      wallMs,
      duration: output.duration,
      wavPath: path.relative(REPO_ROOT, wavOutPath),
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
      script: scriptId,
      displayText: speech.display,
      speechText: speech.speechText,
      normalizerVersion: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
      params: { ...input, ref_audio_b64: input.ref_audio_b64 ? "[omitted]" : undefined },
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      submittedAt,
    };
    appendManifestEntry(manifestEntries, entry);
    console.log(JSON.stringify({ event: "job-failed", key, error: entry.error }));
    return null;
  }
}

// ── Step 1.1: true baseline arms (16 x S1,S2,S3 = 48) ───────────────────────
async function runBaseline() {
  const BASELINE_DIR = path.join(FIDELITY_ROOT, "baseline");
  for (const persona of PERSONAS) {
    for (const scriptId of ["S1", "S2", "S3"] as const) {
      const key = `baseline:${persona}:${scriptId}`;
      const label = `${scriptId}`;
      const wavPath = path.join(BASELINE_DIR, persona, `${label}.wav`);
      await runOne(key, persona, "baseline", label, scriptId, {
        operation: "tts",
        voice_id: persona,
        text: SPEECH[scriptId].speechText,
        num_step: 32,
        speed: 1,
        class_temperature: 0.0,
      }, wavPath);
    }
  }
  console.log(JSON.stringify({ event: "baseline-complete", jobsUsed: jobsUsed(manifestEntries) }));
}

// ── Step 1.2: winner S2/S3 re-render (16 x 2 = 32) ──────────────────────────
type WinnersFile = Record<string, {
  winner: {
    ref: { persona: string; rank: 1 | 2; temp: number; wavPath: string; refText: string };
    temp: number;
    perScriptFiles: { S1: string; S2: string; S3: string };
  };
}>;

async function runWinners() {
  const winners: WinnersFile = JSON.parse(readFileSync(WINNERS_PATH, "utf-8"));
  const WINNER_DIR = path.join(FIDELITY_ROOT, "winners");

  for (const persona of PERSONAS) {
    const w = winners[persona];
    if (!w) {
      console.log(JSON.stringify({ event: "skip-persona-no-winner", persona }));
      continue;
    }
    // Verify winner S1 (reused as-is, not re-rendered) exists.
    const s1Path = path.resolve(MATRIX_ROOT, "eval", w.winner.perScriptFiles.S1);
    if (!existsSync(s1Path)) {
      console.log(JSON.stringify({ event: "MISSING-WINNER-S1-FILE", persona, path: s1Path }));
    }

    const refWavPath = path.resolve(REPO_ROOT, w.winner.ref.wavPath);
    const refAudioB64 = readFileSync(refWavPath).toString("base64");
    const refText = w.winner.ref.refText;
    const temp = w.winner.temp;

    for (const scriptId of ["S2", "S3"] as const) {
      const key = `winner-rerender:${persona}:${scriptId}`;
      const label = `ref${w.winner.ref.rank}_t${temp}_${scriptId}`;
      const wavPath = path.join(WINNER_DIR, persona, `${label}.wav`);
      await runOne(key, persona, "winner-rerender", label, scriptId, {
        operation: "tts",
        voice_id: persona,
        text: SPEECH[scriptId].speechText,
        num_step: 32,
        speed: 1,
        class_temperature: temp,
        ref_audio_b64: refAudioB64,
        ref_text: refText,
      }, wavPath);
    }
  }
  console.log(JSON.stringify({ event: "winners-complete", jobsUsed: jobsUsed(manifestEntries) }));
}

async function main() {
  const mode = process.argv[2];
  if (!["baseline", "winners"].includes(mode)) {
    throw new Error("usage: npx tsx scripts/hv-emotion-t6-fidelity-rerender.ts <baseline|winners>");
  }
  manifestEntries = loadManifest();
  INITIAL_BALANCE = await getBalance();
  console.log(JSON.stringify({ event: "start", mode, initialBalance: INITIAL_BALANCE, jobsUsedSoFar: jobsUsed(manifestEntries) }));

  if (mode === "baseline") {
    await runBaseline();
  } else {
    await runWinners();
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
  console.error(error instanceof Error ? error.message : "fidelity re-render failed");
  process.exit(1);
});
