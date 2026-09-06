import fs from "node:fs";
import path from "node:path";

import { userVoicesDir } from "@/lib/user-voices.server";

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Owner-only storage for generated clone audio; never placed under public/. */
export function heroVoiceCloneAudioDirectory(): string {
  const referenceRoot = userVoicesDir();
  const directory = path.join(referenceRoot, "generated");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(referenceRoot);
  const realDirectory = fs.realpathSync(directory);
  if (!realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Hero Voice clone audio storage escaped its private root");
  }
  try { fs.chmodSync(realDirectory, 0o700); } catch {}
  return realDirectory;
}

export function heroVoiceCloneAudioFilePath(jobId: string): string | null {
  if (!SAFE_JOB_ID.test(jobId)) return null;
  return path.join(heroVoiceCloneAudioDirectory(), `clone-${jobId}.wav`);
}

export function heroVoiceClonePartFilePath(jobId: string, sequence: number): string | null {
  if (!SAFE_JOB_ID.test(jobId) || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  return path.join(heroVoiceCloneAudioDirectory(), `clone-part-${jobId}-${sequence}.wav`);
}
