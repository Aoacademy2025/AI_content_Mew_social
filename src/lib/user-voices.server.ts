// NOTE: no `import "server-only"` here — this module is part of the MCP
// headless worker's import chain (orchestrator → hero-voice-generation), which
// runs under plain tsx where server-only throws. The ".server.ts" suffix and
// node:fs imports keep it out of client bundles the same way its siblings do.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { prisma } from "@/lib/prisma";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { pcmFromWav } from "@/lib/omnivoice-core";
import { pcmDurationMs } from "@/lib/tts-timing";

const execFileAsync = promisify(execFile);

// Hero Voice custom clones (admin-gated v1). Reference audio lives OUTSIDE
// public/ — it is user biometric-ish data served only through an auth-gated
// route and sent to the worker per-request as base64 (never stored provider-side).
export const USER_VOICE_PREFIX = "user_";
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MIN_REF_MS = 2_000;
const MAX_REF_MS = 30_000;
const TARGET_SAMPLE_RATE = 24_000;

export class UserVoiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "UserVoiceError";
  }
}

function userVoicesDir(): string {
  const dir = path.join(process.cwd(), "uploads", "user-voices");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isUserVoiceId(voiceId: string): boolean {
  return voiceId.startsWith(USER_VOICE_PREFIX);
}

export function userVoiceIdFor(id: string): string {
  return `${USER_VOICE_PREFIX}${id}`;
}

/** Convert any uploaded audio to the worker's reference format: 24kHz mono 16-bit WAV. */
async function toReferenceWav(sourceBuffer: Buffer): Promise<Buffer> {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sourcePath = path.join(os.tmpdir(), `user-voice-src-${stamp}`);
  const targetPath = path.join(os.tmpdir(), `user-voice-out-${stamp}.wav`);
  fs.writeFileSync(sourcePath, sourceBuffer);
  try {
    await execFileAsync(getFfmpegPath(), [
      "-y",
      "-i", sourcePath,
      "-ac", "1",
      "-ar", String(TARGET_SAMPLE_RATE),
      "-sample_fmt", "s16",
      "-map_metadata", "-1",
      // Trim leading + trailing silence (front pass, reverse, front pass,
      // reverse back). Dead air in the reference skews F5-style duration
      // estimation (seconds-per-char) and produces garbled speech.
      "-af", "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,areverse",
      targetPath,
    ], { timeout: 60_000 });
    return fs.readFileSync(targetPath);
  } catch (error) {
    if (error instanceof UserVoiceError) throw error;
    throw new UserVoiceError("แปลงไฟล์เสียงไม่สำเร็จ — รองรับ mp3 / wav / m4a / webm", 422);
  } finally {
    for (const file of [sourcePath, targetPath]) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

export async function createUserVoice(input: {
  userId: string;
  name: string;
  refText: string;
  audio: Buffer;
}) {
  const name = input.name.trim().slice(0, 60);
  const refText = input.refText.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!name) throw new UserVoiceError("ตั้งชื่อเสียงก่อน", 400);
  if (refText.length < 8) {
    throw new UserVoiceError("พิมพ์ข้อความที่พูดในไฟล์เสียง (ต้องตรงกับเสียงจริง)", 400);
  }
  if (!input.audio.length) throw new UserVoiceError("ไม่พบไฟล์เสียง", 400);
  if (input.audio.length > MAX_UPLOAD_BYTES) {
    throw new UserVoiceError("ไฟล์เสียงใหญ่เกิน 15MB", 413);
  }

  const wav = await toReferenceWav(input.audio);
  let durationMs: number;
  try {
    const { pcm, sampleRate } = pcmFromWav(wav);
    durationMs = Math.round(pcmDurationMs(pcm.length, sampleRate));
  } catch {
    throw new UserVoiceError("ไฟล์เสียงไม่ถูกต้อง", 422);
  }
  if (durationMs < MIN_REF_MS) throw new UserVoiceError("เสียงตัวอย่างสั้นเกินไป — ต้องยาวอย่างน้อย 2 วินาที", 422);
  if (durationMs > MAX_REF_MS) {
    throw new UserVoiceError("เสียงตัวอย่างยาวเกิน 30 วินาที — ตัดช่วงที่พูดชัด ๆ มา 10-20 วินาทีพอ", 422);
  }

  const voice = await prisma.userVoice.create({
    data: { userId: input.userId, name, refText, filename: "pending", durationMs },
  });
  const filename = `${voice.id}.wav`;
  fs.writeFileSync(path.join(userVoicesDir(), filename), wav);
  return prisma.userVoice.update({ where: { id: voice.id }, data: { filename } });
}

export async function listUserVoices(userId: string) {
  return prisma.userVoice.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function deleteUserVoice(userId: string, id: string) {
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice) return false;
  await prisma.userVoice.delete({ where: { id: voice.id } });
  try { fs.unlinkSync(path.join(userVoicesDir(), voice.filename)); } catch {}
  return true;
}

export async function readUserVoiceWav(userId: string, id: string): Promise<{ wav: Buffer; name: string } | null> {
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice || voice.filename === "pending") return null;
  try {
    return { wav: fs.readFileSync(path.join(userVoicesDir(), voice.filename)), name: voice.name };
  } catch {
    return null;
  }
}

export type UserVoiceRef = { audioBase64: string; refText: string; name: string; durationMs: number };

/**
 * Resolve a `user_<id>` voiceId to the worker reference payload. Ownership is
 * enforced (userId must own the voice) — returns null for anything else so
 * callers can 404 without leaking which IDs exist.
 */
export async function loadUserVoiceRef(userId: string, voiceId: string): Promise<UserVoiceRef | null> {
  if (!isUserVoiceId(voiceId)) return null;
  const id = voiceId.slice(USER_VOICE_PREFIX.length);
  if (!id) return null;
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice || voice.filename === "pending") return null;
  try {
    const wav = fs.readFileSync(path.join(userVoicesDir(), voice.filename));
    return { audioBase64: wav.toString("base64"), refText: voice.refText, name: voice.name, durationMs: voice.durationMs };
  } catch {
    return null;
  }
}
