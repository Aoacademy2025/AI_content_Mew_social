/**
 * Shared BYOK provider-key validity checks — SINGLE SOURCE for:
 *  - Settings "Test key" button (src/app/api/user/test-key/route.ts)
 *  - Job-submit preflight guard (src/app/api/videos/jobs/route.ts + MCP create_video_job
 *    in src/app/api/[transport]/route.ts) — Task 7, 2026-07-16 stability audit.
 *
 * Same HTTP checks, two different needs:
 *  - Settings wants a friendly ok/message pair, shown regardless of the reason for failure.
 *  - The job-submit preflight wants FAIL-OPEN: only a DEFINITIVE 401/403 blocks job
 *    submission — a network error, timeout, or ambiguous non-401 status must NOT block a
 *    legitimate job (a flaky provider check must never be worse than not checking at all).
 *    `verdict` carries that distinction; `ok`/`message` behave exactly as the routes that
 *    predate this file already expected.
 */

export type KeyVerdict = "valid" | "invalid" | "unknown";

export interface KeyTestResult {
  ok: boolean;
  verdict: KeyVerdict;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * ElevenLabs now uses SCOPED api keys. A key granted only text_to_speech (all our TTS
 * needs) returns 401 on /v1/user (needs user_read) — so the naive "/v1/user → 401 =
 * invalid" check false-fails perfectly good keys (history: prod 47acdff, and the MCP
 * server instructions explicitly warn the assistant not to assume a scoped key is dead).
 * Validate against the capability we actually use (TTS) before calling a key invalid.
 */
export async function testElevenLabsKey(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KeyTestResult> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้" };
    if (res.status !== 401) return { ok: false, verdict: "unknown", message: `Error ${res.status}` };
    // 401 → either a truly bad key, or a valid TTS-scoped key lacking user_read.
    const body = (await res.text().catch(() => "")).toLowerCase();
    if (body.includes("missing_permissions")) {
      return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้ (เป็น key แบบจำกัดสิทธิ์ — สร้างเสียงได้ปกติ)" };
    }
    // Ambiguous 401 → confirm against the real TTS endpoint (a standard premade voice,
    // ~1 character of quota). This is exactly what video generation calls.
    const ttsRes = await fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: ".", model_id: "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (ttsRes.ok) return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้ (ยืนยันด้วยการสร้างเสียง)" };
    if (ttsRes.status === 401) return { ok: false, verdict: "invalid", message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, verdict: "unknown", message: `Error ${ttsRes.status}` };
  } catch {
    return { ok: false, verdict: "unknown", message: "ไม่สามารถเชื่อมต่อ ElevenLabs ได้" };
  }
}

/** Pexels: a plain video search costs no meaningful quota and confirms auth. */
export async function testPexelsKey(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KeyTestResult> {
  try {
    const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, verdict: "valid", message: "Pexels key ใช้งานได้" };
    if (res.status === 401 || res.status === 403) return { ok: false, verdict: "invalid", message: "Key ไม่ถูกต้อง" };
    return { ok: false, verdict: "unknown", message: `Error ${res.status}` };
  } catch {
    return { ok: false, verdict: "unknown", message: "ไม่สามารถเชื่อมต่อ Pexels ได้" };
  }
}

export interface PreflightBlock {
  key: "elevenlabs" | "pexels";
  message: string;
}

/**
 * Job-submit preflight (Task 7, 2026-07-16 stability audit): 20/59 weekly VideoJob
 * failures this week were BYOK key problems that only surfaced mid-pipeline — ElevenLabs
 * missing the text_to_speech scope (10 failures, one repeat user) and an invalid Pexels
 * key (10 failures, five distinct users) — after TTS/keywords/stock had already run, with
 * a raw JSON error dump as the only user-facing message and no link back to Settings.
 * These run the SAME checks above BEFORE the job is accepted, fail-open on anything but a
 * confirmed bad key so a flaky provider or slow network never blocks a legitimate job.
 */
export async function preflightElevenLabs(key: string): Promise<PreflightBlock | null> {
  const r = await testElevenLabsKey(key).catch((): KeyTestResult => ({ ok: false, verdict: "unknown", message: "" }));
  if (r.verdict !== "invalid") return null;
  return {
    key: "elevenlabs",
    message: `ElevenLabs API key ใช้ไม่ได้ (${r.message}) — ไปแก้ที่ Settings → API Keys แล้วลองใหม่ (หรือเปลี่ยนไปใช้เสียง Gemini)`,
  };
}

export async function preflightPexels(key: string): Promise<PreflightBlock | null> {
  const r = await testPexelsKey(key).catch((): KeyTestResult => ({ ok: false, verdict: "unknown", message: "" }));
  if (r.verdict !== "invalid") return null;
  return {
    key: "pexels",
    message: `Pexels API key ใช้ไม่ได้ (${r.message}) — ไปแก้ที่ Settings → API Keys แล้วลองใหม่ (หรือเพิ่ม Pixabay key เป็นตัวสำรอง)`,
  };
}
