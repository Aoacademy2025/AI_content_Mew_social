import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ACOUSTIC_CLOCK_VERSION, ACOUSTIC_MODEL_REVISION,
  type AcousticCharacter, type AcousticEvidence,
} from "@/lib/acoustic-subtitle-clock";

export type AcousticMode = "off" | "shadow" | "apply";
export function acousticSubtitleMode(userId?: string): AcousticMode {
  const mode = process.env.SUBTITLE_ACOUSTIC_MODE;
  if (mode !== "apply") return mode === "shadow" ? "shadow" : "off";
  const configured = Number(process.env.SUBTITLE_ACOUSTIC_ROLLOUT_PERCENT ?? 0);
  const percent = Number.isFinite(configured) ? Math.min(100, Math.max(0, configured)) : 0;
  if (!userId || percent === 0) return "shadow";
  const bucket = createHash("sha256").update(`hero-acoustic-cohort:${userId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
  return bucket * 100 < percent ? "apply" : "shadow";
}

type WorkerClock = {
  version: string;
  modelRevision: string;
  audioHash: string;
  textHash: string;
  audioDurationMs: number;
  characters: AcousticCharacter[];
};
export type AcousticWorkerResult = { evidence: AcousticEvidence; clock?: WorkerClock };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
let lastCacheSweep = 0;
async function sweepAcousticCache(directory: string): Promise<void> {
  if (Date.now() - lastCacheSweep < 60 * 60_000) return;
  lastCacheSweep = Date.now();
  try {
    const entries = await fs.opendir(directory);
    let inspected = 0;
    for await (const entry of entries) {
      if (++inspected > 2000) break;
      if (!entry.isFile() || !/^[a-f0-9]{64}(?:\.json|\.[a-f0-9-]+\.tmp)$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > CACHE_MAX_AGE_MS) await fs.unlink(file).catch(() => {});
    }
  } catch { /* best-effort cleanup owns only this cache's hash-named entries */ }
}

function validClock(value: unknown, audioHash: string, textHash: string, textLength: number): value is WorkerClock {
  if (!value || typeof value !== "object") return false;
  const v = value as WorkerClock;
  return v.version === ACOUSTIC_CLOCK_VERSION && v.modelRevision === ACOUSTIC_MODEL_REVISION
    && v.audioHash === audioHash && v.textHash === textHash
    && Number.isFinite(v.audioDurationMs) && v.audioDurationMs > 0 && v.audioDurationMs <= 360_000
    && Array.isArray(v.characters) && v.characters.length > 0 && v.characters.length <= 12_000
    && v.characters.every((c, i) => c && Number.isInteger(c.startChar) && Number.isInteger(c.endChar)
      && c.startChar >= 0 && c.endChar > c.startChar && c.endChar <= textLength
      && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.startMs >= 0
      && c.endMs > c.startMs && c.endMs <= v.audioDurationMs
      && Number.isFinite(c.confidence) && c.confidence >= 0 && c.confidence <= 1
      && (i === 0 || (c.startChar >= v.characters[i - 1].endChar && c.startMs >= v.characters[i - 1].endMs)));
}

/** Internal generated-WAV boundary. Never fetch an arbitrary URL, follow a
 * symlink outside renders, or pass customer text through command arguments. */
export async function resolveAcousticAudioFile(audioUrl: string, root = process.cwd()): Promise<string | null> {
  const match = /^\/api\/renders\/([A-Za-z0-9_-][A-Za-z0-9_.-]*\.wav)$/.exec(audioUrl);
  if (!match) return null;
  try {
    const directory = await fs.realpath(path.join(root, "public", "renders"));
    const file = await fs.realpath(path.join(directory, match[1]));
    if (path.dirname(file) !== directory) return null;
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 44 && stat.size <= 40_000_000 ? file : null;
  } catch { return null; }
}

/** A single killable local process. No provider retry or runtime download.
 * The Python flock bounds concurrency across worker processes; timeout includes
 * waiting for that lock and cold model load. Errors are fixed codes only. */
export async function runAcousticSubtitleWorker(args: {
  audioUrl: string;
  text: string;
  audioDurationMs: number;
  mode: Exclude<AcousticMode, "off">;
  budgetMs?: number;
}): Promise<AcousticWorkerResult> {
  const started = Date.now();
  const evidence: AcousticEvidence = {
    status: "unavailable", version: ACOUSTIC_CLOCK_VERSION, modelRevision: ACOUSTIC_MODEL_REVISION,
    mode: args.mode, applied: false, durationMs: 0,
  };
  const finish = (clock?: WorkerClock): AcousticWorkerResult => ({
    evidence: { ...evidence, durationMs: Date.now() - started }, ...(clock ? { clock } : {}),
  });
  try {
    const python = process.env.SUBTITLE_ACOUSTIC_PYTHON;
    if (!python || !path.isAbsolute(python) || !args.text.trim() || args.text.length > 12_000) return finish();
    const configured = Number(process.env.SUBTITLE_ACOUSTIC_BUDGET_MS ?? 45_000);
    const budgetMs = Math.min(90_000, Math.max(1, args.budgetMs ?? (Number.isFinite(configured) ? configured : 45_000)));
    const file = await resolveAcousticAudioFile(args.audioUrl);
    if (!file) return finish();
    const audioHash = hash(await fs.readFile(file));
    const textHash = hash(args.text);
    Object.assign(evidence, { audioHash, textHash });
    const cacheDir = process.env.SUBTITLE_ACOUSTIC_CACHE_DIR ?? path.join(os.tmpdir(), "heroai-subtitle-alignment");
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    void sweepAcousticCache(cacheDir);
    const key = hash([ACOUSTIC_CLOCK_VERSION, ACOUSTIC_MODEL_REVISION, audioHash, textHash].join(":"));
    const cachePath = path.join(cacheDir, `${key}.json`);
    try {
      const stat = await fs.stat(cachePath);
      if (stat.size <= 2_000_000 && Date.now() - stat.mtimeMs <= CACHE_MAX_AGE_MS) {
        const cached: unknown = JSON.parse(await fs.readFile(cachePath, "utf8"));
        if (validClock(cached, audioHash, textHash, args.text.length)
          && Math.abs(cached.audioDurationMs - args.audioDurationMs) <= 250) {
          evidence.cacheHit = true;
          return finish(cached);
        }
      }
    } catch { /* absent/invalid cache is a miss */ }
    const remainingMs = budgetMs - (Date.now() - started);
    if (remainingMs <= 0) { evidence.status = "timeout"; return finish(); }
    const raw = await new Promise<string | null>((resolve) => {
      let completed = false;
      let bytes = 0;
      const output: Buffer[] = [];
      const child = spawn(python, [path.join(process.cwd(), "scripts/subtitle-alignment/engine.py")], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
          HF_HUB_DISABLE_PROGRESS_BARS: "1", SUBTITLE_ACOUSTIC_CACHE_DIR: cacheDir },
      });
      const end = (result: string | null) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        evidence.status = "timeout";
        child.kill("SIGKILL");
        end(null);
      }, remainingMs);
      child.on("error", () => end(null));
      child.stdin.on("error", () => { child.kill("SIGKILL"); end(null); });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { child.kill("SIGKILL"); end(null); }
        else output.push(chunk);
      });
      child.on("close", (code) => end(code === 0 ? Buffer.concat(output).toString("utf8") : null));
      child.stdin.end(JSON.stringify({ audioPath: file, audioHash, text: args.text }));
    });
    if (!raw) return finish();
    const parsed: unknown = JSON.parse(raw);
    if (!validClock(parsed, audioHash, textHash, args.text.length)
      || Math.abs(parsed.audioDurationMs - args.audioDurationMs) > 250) return finish();
    // Whitelist fields so a child's diagnostic additions cannot reach disk/telemetry.
    const clock: WorkerClock = { version: parsed.version, modelRevision: parsed.modelRevision,
      audioHash, textHash, audioDurationMs: parsed.audioDurationMs, characters: parsed.characters.map(c => ({
        startChar: c.startChar, endChar: c.endChar, startMs: c.startMs,
        endMs: c.endMs, confidence: c.confidence,
      })) };
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(clock), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, cachePath);
    } catch { /* cache availability must not affect rendering */ }
    finally { await fs.unlink(temporary).catch(() => {}); }
    evidence.cacheHit = false;
    return finish(clock);
  } catch { return finish(); }
}
