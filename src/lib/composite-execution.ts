import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LEGACY_COMPOSITE_TIMEOUT_MS = 30 * 60 * 1000;
const CANARY_COMPOSITE_TIMEOUT_MS = 55 * 60 * 1000;
const MIN_COMPOSITE_TIMEOUT_MS = 5 * 60 * 1000;

type CompositeTimeoutEnv = {
  COMPOSITE_TIMEOUT_MS?: string;
  COMPOSITE_CANARY_TIMEOUT_MS?: string;
  COMPOSITE_STABILITY_CANARY_USER_IDS?: string;
};

function timeoutEnv(override?: CompositeTimeoutEnv): CompositeTimeoutEnv {
  return override ?? {
    COMPOSITE_TIMEOUT_MS: process.env.COMPOSITE_TIMEOUT_MS,
    COMPOSITE_CANARY_TIMEOUT_MS: process.env.COMPOSITE_CANARY_TIMEOUT_MS,
    COMPOSITE_STABILITY_CANARY_USER_IDS: process.env.COMPOSITE_STABILITY_CANARY_USER_IDS,
  };
}

export function isCompositeStabilityCanary(input: {
  userId: string;
  env?: CompositeTimeoutEnv;
}): boolean {
  const env = timeoutEnv(input.env);
  return (env.COMPOSITE_STABILITY_CANARY_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(input.userId);
}

function boundedTimeout(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(
        CANARY_COMPOSITE_TIMEOUT_MS,
        Math.max(MIN_COMPOSITE_TIMEOUT_MS, Math.floor(value)),
      )
    : fallback;
}

export function resolveCompositeTimeoutMs(input: {
  userId: string;
  env?: CompositeTimeoutEnv;
}): number {
  const env = timeoutEnv(input.env);
  if (env.COMPOSITE_TIMEOUT_MS) {
    return boundedTimeout(env.COMPOSITE_TIMEOUT_MS, LEGACY_COMPOSITE_TIMEOUT_MS);
  }
  return isCompositeStabilityCanary({ userId: input.userId, env })
    ? boundedTimeout(env.COMPOSITE_CANARY_TIMEOUT_MS, CANARY_COMPOSITE_TIMEOUT_MS)
    : LEGACY_COMPOSITE_TIMEOUT_MS;
}

export type CompositeExecutionErrorCode =
  | "COMPOSITE_TIMEOUT"
  | "COMPOSITE_STALLED"
  | "COMPOSITE_TRANSIENT"
  | "COMPOSITE_FAILED";

type ExecFailure = Error & {
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
  code?: number | string | null;
};

export type CompositeExecFile = (
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; timeout: number },
  callback: (error: ExecFailure | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export class CompositeExecutionError extends Error {
  constructor(
    public readonly code: CompositeExecutionErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details: {
      killed: boolean;
      signal: string | null;
      exitCode: number | string | null;
      stderrTail: string;
    },
  ) {
    super(message);
    this.name = "CompositeExecutionError";
  }
}

function partialPath(outputPath: string): string {
  const ext = path.extname(outputPath);
  return ext
    ? `${outputPath.slice(0, -ext.length)}.part${ext}`
    : `${outputPath}.part`;
}

function removeIfPresent(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Cleanup is best-effort. The execution error remains the primary failure.
  }
}

export async function executeCompositeFfmpeg(input: {
  ffmpegPath: string;
  args: readonly string[];
  outputPath: string;
  timeoutMs: number;
  execFile?: CompositeExecFile;
}): Promise<{ stderr: string }> {
  if (input.args.at(-1) !== input.outputPath) {
    throw new Error("composite outputPath must be the final ffmpeg argument");
  }
  const partPath = partialPath(input.outputPath);
  removeIfPresent(partPath);
  const args = [...input.args.slice(0, -1), partPath];
  const exec = input.execFile ?? (nodeExecFile as unknown as CompositeExecFile);

  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      exec(
        input.ffmpegPath,
        args,
        { maxBuffer: 100 * 1024 * 1024, timeout: input.timeoutMs },
        (error, _stdout, rawStderr) => {
          const stderrText = rawStderr?.toString() ?? "";
          if (!error) {
            resolve(stderrText);
            return;
          }
          const timedOut = error.killed === true && error.signal === "SIGTERM";
          reject(new CompositeExecutionError(
            timedOut ? "COMPOSITE_TIMEOUT" : "COMPOSITE_FAILED",
            timedOut
              ? "ประกอบวิดีโอใช้เวลานานเกินกำหนด"
              : `ffmpeg failed: ${stderrText.slice(-1000)}`,
            false,
            {
              killed: error.killed === true,
              signal: error.signal ? String(error.signal) : null,
              exitCode: error.code ?? null,
              stderrTail: stderrText.slice(-2000),
            },
          ));
        },
      );
    });

    if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 1) {
      throw new CompositeExecutionError(
        "COMPOSITE_FAILED",
        "ffmpeg produced no output",
        false,
        { killed: false, signal: null, exitCode: null, stderrTail: stderr.slice(-2000) },
      );
    }
    fs.renameSync(partPath, input.outputPath);
    return { stderr };
  } catch (error) {
    removeIfPresent(partPath);
    throw error;
  }
}
