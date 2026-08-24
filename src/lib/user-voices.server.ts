// This module is also imported by standalone background workers through the
// durable Hero Voice pipeline, so it deliberately avoids `server-only`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { pcmFromWav } from "@/lib/omnivoice-core";
import { prisma } from "@/lib/prisma";
import { pcmDurationMs } from "@/lib/tts-timing";

const execFileAsync = promisify(execFile);

export const USER_VOICE_PREFIX = "user_";
export const USER_VOICE_CONSENT_VERSION = "voice-clone-v1";
export const USER_VOICE_MAX_COUNT = 10;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MIN_REF_MS = 5_000;
export const MAX_REF_MS = 15_000;
const MAX_WORKER_REF_BYTES = 8_000_000;
const TARGET_SAMPLE_RATE = 24_000;
const SAFE_FILENAME = /^[A-Fa-f0-9-]{36}\.wav$/;
const ACTIVE_JOB_STATUSES = ["queued", "in_progress"] as const;

export class UserVoiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "UserVoiceError";
  }
}

export function userVoicesDir(): string {
  const configured = process.env.USER_VOICE_STORAGE_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new UserVoiceError(
      "USER_VOICE_STORAGE_DIR must be an absolute path",
      500,
      "USER_VOICE_STORAGE_INVALID",
    );
  }
  const directory = path.resolve(configured || path.join(process.cwd(), "uploads", "user-voices"));
  const publicDirectory = path.resolve(process.cwd(), "public");
  const isInsidePublic = (candidate: string, root: string) => (
    candidate === root || candidate.startsWith(`${root}${path.sep}`)
  );
  if (isInsidePublic(directory, publicDirectory)) {
    throw new UserVoiceError(
      "User voice storage must stay outside public/",
      500,
      "USER_VOICE_STORAGE_INVALID",
    );
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = fs.realpathSync(directory);
  const realPublicDirectory = fs.realpathSync(publicDirectory);
  if (isInsidePublic(realDirectory, realPublicDirectory)) {
    throw new UserVoiceError(
      "User voice storage must stay outside public/",
      500,
      "USER_VOICE_STORAGE_INVALID",
    );
  }
  try { fs.chmodSync(realDirectory, 0o700); } catch {}
  return realDirectory;
}

function voiceFilePath(filename: string): string | null {
  if (!SAFE_FILENAME.test(filename)) return null;
  return path.join(userVoicesDir(), filename);
}

export function isUserVoiceId(voiceId: string): boolean {
  return /^user_[A-Za-z0-9_-]{1,59}$/.test(voiceId);
}

export function userVoiceIdFor(id: string): string {
  return `${USER_VOICE_PREFIX}${id}`;
}

async function toReferenceWav(sourceBuffer: Buffer): Promise<Buffer> {
  const stamp = `${Date.now()}-${randomUUID()}`;
  const sourcePath = path.join(os.tmpdir(), `hero-user-voice-source-${stamp}`);
  const targetPath = path.join(os.tmpdir(), `hero-user-voice-reference-${stamp}.wav`);
  fs.writeFileSync(sourcePath, sourceBuffer, { flag: "wx", mode: 0o600 });
  try {
    await execFileAsync(getFfmpegPath(), [
      "-y",
      "-i", sourcePath,
      "-t", "17",
      "-vn", "-sn", "-dn",
      "-ac", "1",
      "-ar", String(TARGET_SAMPLE_RATE),
      "-c:a", "pcm_s16le",
      "-map_metadata", "-1",
      "-af",
      "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
        + "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
        + "areverse,loudnorm=I=-18:TP=-2:LRA=7",
      targetPath,
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const wav = fs.readFileSync(targetPath);
    if (wav.length > MAX_WORKER_REF_BYTES) {
      throw new UserVoiceError("ไฟล์อ้างอิงใหญ่เกินขอบเขตของระบบ", 413, "USER_VOICE_REFERENCE_TOO_LARGE");
    }
    return wav;
  } catch (error) {
    if (error instanceof UserVoiceError) throw error;
    throw new UserVoiceError(
      "แปลงไฟล์เสียงไม่สำเร็จ — รองรับ mp3, wav, m4a และ webm",
      422,
      "USER_VOICE_AUDIO_INVALID",
    );
  } finally {
    for (const filename of [sourcePath, targetPath]) {
      try { fs.unlinkSync(filename); } catch {}
    }
  }
}

export async function createUserVoice(input: {
  userId: string;
  name: string;
  refText: string;
  audio: Buffer;
  consent: boolean;
}) {
  const name = input.name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const refText = input.refText.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!input.consent) {
    throw new UserVoiceError(
      "กรุณายืนยันว่าคุณเป็นเจ้าของเสียงหรือได้รับอนุญาตให้ใช้เสียงนี้",
      400,
      "USER_VOICE_CONSENT_REQUIRED",
    );
  }
  if (!name) throw new UserVoiceError("ตั้งชื่อเสียงก่อน", 400, "USER_VOICE_NAME_REQUIRED");
  if (refText.length < 8) {
    throw new UserVoiceError(
      "พิมพ์ข้อความที่พูดในไฟล์เสียงให้ตรงคำต่อคำอย่างน้อย 8 ตัวอักษร",
      400,
      "USER_VOICE_REF_TEXT_REQUIRED",
    );
  }
  if (!input.audio.length) throw new UserVoiceError("ไม่พบไฟล์เสียง", 400, "USER_VOICE_AUDIO_REQUIRED");
  if (input.audio.length > MAX_UPLOAD_BYTES) {
    throw new UserVoiceError("ไฟล์เสียงใหญ่เกิน 15 MB", 413, "USER_VOICE_UPLOAD_TOO_LARGE");
  }
  const voiceCount = await prisma.userVoice.count({ where: { userId: input.userId } });
  if (voiceCount >= USER_VOICE_MAX_COUNT) {
    throw new UserVoiceError(
      `เก็บเสียงโคลนได้สูงสุด ${USER_VOICE_MAX_COUNT} เสียง กรุณาลบเสียงที่ไม่ใช้ก่อน`,
      409,
      "USER_VOICE_LIMIT_REACHED",
    );
  }

  const wav = await toReferenceWav(input.audio);
  let durationMs: number;
  try {
    const { pcm, sampleRate } = pcmFromWav(wav);
    durationMs = Math.round(pcmDurationMs(pcm.length, sampleRate));
  } catch {
    throw new UserVoiceError("ไฟล์เสียงไม่ถูกต้อง", 422, "USER_VOICE_AUDIO_INVALID");
  }
  if (durationMs < MIN_REF_MS) {
    throw new UserVoiceError(
      "ช่วงที่พูดชัดเจนสั้นเกินไป — ต้องมีเสียงพูดต่อเนื่องอย่างน้อย 5 วินาที",
      422,
      "USER_VOICE_REFERENCE_TOO_SHORT",
    );
  }
  if (durationMs > MAX_REF_MS) {
    throw new UserVoiceError(
      "เสียงอ้างอิงยาวเกิน 15 วินาที — เลือกช่วงที่พูดชัดเจน 5–15 วินาที",
      422,
      "USER_VOICE_REFERENCE_TOO_LONG",
    );
  }

  const filename = `${randomUUID()}.wav`;
  const destination = voiceFilePath(filename);
  if (!destination) throw new UserVoiceError("จัดเก็บไฟล์เสียงไม่สำเร็จ", 500, "USER_VOICE_STORAGE_INVALID");
  const temporary = `${destination}.pending-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, wav, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    return await prisma.userVoice.create({
      data: {
        userId: input.userId,
        name,
        refText,
        filename,
        durationMs,
        consentVersion: USER_VOICE_CONSENT_VERSION,
      },
    });
  } catch (error) {
    for (const target of [temporary, destination]) {
      try { fs.unlinkSync(target); } catch {}
    }
    if (error instanceof UserVoiceError) throw error;
    throw new UserVoiceError("จัดเก็บเสียงโคลนไม่สำเร็จ", 500, "USER_VOICE_STORAGE_FAILED");
  }
}

export function listUserVoices(userId: string) {
  return prisma.userVoice.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteUserVoice(userId: string, id: string): Promise<boolean> {
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice) return false;
  const voiceId = userVoiceIdFor(voice.id);
  const activeJob = await prisma.aiGenerationJob.findFirst({
    where: { userId, kind: "voice", model: voiceId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true },
  });
  if (activeJob) {
    throw new UserVoiceError(
      "เสียงนี้กำลังถูกใช้สร้างงาน รอให้งานเสร็จก่อนแล้วจึงลบได้",
      409,
      "USER_VOICE_IN_USE",
    );
  }

  const source = voiceFilePath(voice.filename);
  const tombstone = source ? `${source}.delete-${randomUUID()}` : null;
  if (source && fs.existsSync(source)) fs.renameSync(source, tombstone!);
  try {
    await prisma.userVoice.delete({ where: { id: voice.id } });
  } catch (error) {
    if (source && tombstone && fs.existsSync(tombstone)) fs.renameSync(tombstone, source);
    throw error;
  }
  if (tombstone) {
    try { fs.unlinkSync(tombstone); } catch {}
  }
  return true;
}

export async function readUserVoiceWav(
  userId: string,
  id: string,
): Promise<{ wav: Buffer; name: string } | null> {
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice) return null;
  const filename = voiceFilePath(voice.filename);
  if (!filename) return null;
  try {
    const wav = fs.readFileSync(filename);
    if (!wav.length || wav.length > MAX_WORKER_REF_BYTES) return null;
    return { wav, name: voice.name };
  } catch {
    return null;
  }
}

export type UserVoiceRef = {
  audioBase64: string;
  refText: string;
  name: string;
  durationMs: number;
};

export async function loadUserVoiceRef(userId: string, voiceId: string): Promise<UserVoiceRef | null> {
  if (!isUserVoiceId(voiceId)) return null;
  const id = voiceId.slice(USER_VOICE_PREFIX.length);
  const voice = await prisma.userVoice.findFirst({ where: { id, userId } });
  if (!voice) return null;
  const filename = voiceFilePath(voice.filename);
  if (!filename) return null;
  try {
    const wav = fs.readFileSync(filename);
    if (!wav.length || wav.length > MAX_WORKER_REF_BYTES) return null;
    return {
      audioBase64: wav.toString("base64"),
      refText: voice.refText,
      name: voice.name,
      durationMs: voice.durationMs,
    };
  } catch {
    return null;
  }
}
