import type { OmniVoiceInfo } from "@/lib/tts-providers";

export interface OmniVoiceAdmissionLease {
  release(): void;
}

/** Small per-process guard; the worker has the authoritative cross-host queue. */
export function createOmniVoiceAdmissionCounter(maxInFlight: number) {
  const limit = Math.max(1, Math.floor(maxInFlight));
  let inFlight = 0;
  return {
    tryAcquire(): OmniVoiceAdmissionLease | null {
      if (inFlight >= limit) return null;
      inFlight += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },
    inFlight: () => inFlight,
  };
}

export function userInOmniVoiceAllowlist(userId: string, rawAllowlist: string | undefined): boolean {
  const configured = (rawAllowlist ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Production-wide access must be explicit. A missing variable is a closed canary,
  // not an accidental global launch.
  return configured.includes("*") || configured.includes(userId);
}

const THAI_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];

/** เลขไทยแบบอ่านทีละหลัก (เช่น "ซอย 15" → "หนึ่งห้า") ตรงกับที่คนไทยอ่านเลขที่/ซอย/รหัส */
function digitsToThaiWords(digits: string): string {
  return digits.split("").map((d) => THAI_DIGITS[Number(d)]).join("");
}

// คำนำหน้าที่คนไทยอ่านเลขต่อท้ายทีละหลัก (ระบุตำแหน่ง/รหัส ไม่ใช่ปริมาณ) — ตรงข้ามกับ
// ปี/เดือน/เวลา/จำนวนที่อ่านเป็นเลขรวม ต้อง whitelist เพราะแยกด้วย pattern ทั่วไปไม่ได้
const DIGIT_BY_DIGIT_PREFIXES = ["ซอย", "เลขที่", "ห้อง", "ชั้น", "แยก", "ถนน", "ทางหลวง"];
const DIGIT_BY_DIGIT_RE = new RegExp(
  `(${DIGIT_BY_DIGIT_PREFIXES.join("|")})(\\s*)(\\d+)(?!\\.\\d|[:\\d])`,
  "g",
);

/**
 * OmniVoice (เหมือน TTS หลายตัว) ออกเสียงเลขอารบิกเดี่ยวๆที่แปะอยู่ติดคำไทยผิด
 * (พบจริง: "ซอย 1" → "ซอยมน") — แปลงเป็นคำไทยทีละหลักก่อนส่งเข้าโมเดลเพื่อเลี่ยงจุดที่ตีความผิด
 * จำกัดเฉพาะคำนำหน้าที่รู้ชัดว่าอ่านทีละหลัก (ซอย/เลขที่/ห้อง ฯลฯ) — ไม่แตะปี/เดือน/เวลา/
 * จำนวนนับที่อ่านเป็นเลขรวม (เช่น "ปี 2568", "100 คน") เพราะกฎการอ่านตรงข้ามกัน
 * ใช้เฉพาะข้อความที่ส่งเข้า TTS เท่านั้น — ซับ/สคริปต์ที่ผู้ใช้เห็นต้องเป็นเลขเดิมเสมอ
 */
export function normalizeNumbersForTts(text: string): string {
  return text.replace(DIGIT_BY_DIGIT_RE, (_m, prefix: string, space: string, digits: string) => `${prefix}${space}${digitsToThaiWords(digits)}`);
}

export function isValidOmniVoiceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function isOmniVoiceInfo(value: unknown): value is OmniVoiceInfo {
  if (!value || typeof value !== "object") return false;
  const voice = value as Partial<OmniVoiceInfo>;
  return typeof voice.voice_id === "string"
    && isValidOmniVoiceId(voice.voice_id)
    && typeof voice.desc === "string"
    && typeof voice.instruct === "string"
    && typeof voice.preview_url === "string"
    && voice.preview_url.trim().length > 0;
}

/** Extract signed 16-bit PCM from a RIFF/WAV response produced by the worker. */
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("OmniVoice returned an invalid WAV file");
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > wav.length) throw new Error("OmniVoice returned a truncated WAV file");
    if (id === "fmt " && size >= 16) {
      const audioFormat = wav.readUInt16LE(dataStart);
      channels = wav.readUInt16LE(dataStart + 2);
      sampleRate = wav.readUInt32LE(dataStart + 4);
      bitsPerSample = wav.readUInt16LE(dataStart + 14);
      if (audioFormat !== 1) throw new Error("OmniVoice returned non-PCM WAV audio");
    } else if (id === "data") {
      pcm = wav.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + (size % 2);
  }

  if (!pcm || sampleRate <= 0 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error("OmniVoice returned an unsupported WAV layout");
  }
  return { pcm, sampleRate };
}
