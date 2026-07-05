/**
 * OmniVoice TTS — self-hosted voice server (FastAPI, see API_DOCS.md ฝั่ง omnivoice repo).
 * ไม่ใช่ BYOK: server เป็นของระบบเอง ผู้ใช้ทุกคนเรียกผ่าน proxy ของเราได้เลย
 * URL ตั้งผ่าน env OMNIVOICE_URL (default = dev localhost)
 */

export function omnivoiceBaseUrl(): string {
  return (process.env.OMNIVOICE_URL || "http://localhost:8000").replace(/\/+$/, "");
}

export interface OmniVoiceInfo {
  voice_id: string;
  desc: string;
  instruct: string;
  preview_url: string;
}

export interface OmniTtsResponse {
  voice_id: string;
  text: string;
  audio_base64: string;
  format: string;       // "wav"
  sample_rate: number;  // 24000
  duration: number;     // seconds
  generation_time: number;
}

/** voice_id จากภายนอกต้อง sanitize ก่อนต่อเข้า URL (กัน path traversal ไปยัง server ภายใน) */
export function isValidOmniVoiceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * แกะ PCM ออกจาก WAV buffer โดย walk RIFF chunks จริง (header ไม่ใช่ 44 bytes เสมอ)
 * คืน sampleRate จาก fmt chunk ด้วย — ใช้คำนวณ duration แบบ arithmetic
 */
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  let sampleRate = 24000;
  if (wav.length >= 12 && wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE") {
    let off = 12;
    let pcm: Buffer | null = null;
    while (off + 8 <= wav.length) {
      const id = wav.toString("ascii", off, off + 4);
      const size = wav.readUInt32LE(off + 4);
      if (id === "fmt " && off + 8 + 16 <= wav.length) sampleRate = wav.readUInt32LE(off + 12);
      if (id === "data") { pcm = wav.subarray(off + 8, Math.min(off + 8 + size, wav.length)); break; }
      off += 8 + size + (size % 2); // chunks are word-aligned
    }
    if (pcm) return { pcm, sampleRate };
  }
  // ไม่ใช่ RIFF มาตรฐาน → เดา 44-byte header (layout ที่ server เราเขียนเอง)
  return { pcm: wav.subarray(44), sampleRate };
}
