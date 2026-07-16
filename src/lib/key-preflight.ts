/**
 * Shared BYOK provider-key validity checks — SINGLE SOURCE for:
 *  - Settings "Test key" button (src/app/api/user/test-key/route.ts)
 *  - Job-submit preflight guard (src/app/api/videos/jobs/route.ts + MCP create_video_job
 *    in src/app/api/[transport]/route.ts) — Task 7, 2026-07-16 stability audit.
 *
 * Same HTTP checks, two different needs:
 *  - Settings wants a friendly ok/message pair, shown regardless of the reason for failure.
 *  - The job-submit preflight wants FAIL-OPEN: only a DEFINITIVE 401/403 blocks job
 *    submission — a network error, timeout, or a still-ambiguous result after probing
 *    must NOT block a legitimate job (a flaky provider check must never be worse than
 *    not checking at all). `verdict` carries that distinction; `ok`/`message` behave
 *    exactly as the routes that predate this file already expected.
 *  - For ElevenLabs specifically, "ambiguous" is NOT the same as "skip checking further":
 *    preflight also runs the real TTS disambiguation probe (see `ElevenLabsCheckMode`
 *    below) because it's the only way to conclusively catch a scoped key that's missing
 *    text_to_speech itself — and the probe only ever costs the user anything when it
 *    SUCCEEDS, at which point the key was fine anyway.
 */

export type KeyVerdict = "valid" | "invalid" | "unknown";

export interface KeyTestResult {
  ok: boolean;
  verdict: KeyVerdict;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

export type ElevenLabsCheckMode = "settings" | "preflight";

export interface ElevenLabsCheckOptions {
  timeoutMs?: number;
  /**
   * "settings" (default) — Settings "Test key" button: a scoped key that gets
   * "missing_permissions" on /v1/user (i.e. lacks user_read, the permission /v1/user
   * itself needs) is treated as valid without a further call — historical shortcut,
   * unchanged.
   *
   * "preflight" — job-submit gate (2nd review round, 2026-07-17): ALSO probes on
   * "missing_permissions". Re-review of the real prod failure proved the shortcut
   * above is unsound for our purposes: /v1/user's "missing_permissions" message names
   * whatever permission /v1/user ITSELF needs (user_read), never the caller's actual
   * use case — so it cannot tell a key that has text_to_speech-but-not-user_read
   * (fine) apart from one that has NEITHER (the exact key that caused all 10 real
   * ElevenLabs failures). Only the real TTS endpoint can tell them apart.
   *
   * Cost re-analysis that makes this safe to run automatically: the TTS probe below
   * is only ever PAID (spends the user's ElevenLabs character quota) when it
   * SUCCEEDS — a 401/403-rejected call generates no audio and bills nothing. And if
   * it succeeds, the key is fine and the job's real TTS step would have spent that
   * same ~1 character moments later anyway. So the probe's cost/latency lands
   * exclusively on broken-ish keys — exactly when spending 3 extra seconds to save
   * the user a failed job (vs. a silent pass-through) is the right trade.
   */
  mode?: ElevenLabsCheckMode;
}

/**
 * ElevenLabs now uses SCOPED api keys. A key granted only text_to_speech (all our TTS
 * needs) returns 401 on /v1/user (needs user_read) — so the naive "/v1/user → 401 =
 * invalid" check false-fails perfectly good keys (history: prod 47acdff, and the MCP
 * server instructions explicitly warn the assistant not to assume a scoped key is dead).
 * Validate against the capability we actually use (TTS) before calling a key invalid.
 *
 * ElevenLabs' 401 body shape (confirmed against ElevenLabs' own docs/support articles):
 *   - `{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}` — the key
 *     itself is bogus/revoked. DEFINITIVE, and free to detect from this one call — no
 *     endpoint-specific scope involved, so both modes trust it as the first gate.
 *   - `{"detail":{"status":"missing_permissions","message":"...missing the permission
 *     user_read..."}}` — the key IS valid but lacks the permission /v1/user itself
 *     needs (user_read). Ambiguous re: text_to_speech — see `mode` above for how the
 *     two callers handle this differently.
 *   - Anything else 401 is genuinely ambiguous in BOTH modes; only the real TTS
 *     endpoint can conclusively confirm it — the `probe` call below.
 */
export async function testElevenLabsKey(key: string, opts: ElevenLabsCheckOptions = {}): Promise<KeyTestResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, mode = "settings" } = opts;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้" };
    if (res.status !== 401) return { ok: false, verdict: "unknown", message: `Error ${res.status}` };
    const body = (await res.text().catch(() => "")).toLowerCase();
    // Definitive + free (no extra call, both modes): the key itself doesn't exist / was revoked.
    if (body.includes("invalid_api_key")) {
      return { ok: false, verdict: "invalid", message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    }
    // Scoped key missing user_read (needed by /v1/user, not by us). Settings trusts the
    // historical shortcut and stops here; preflight falls through to the real probe —
    // this is exactly the ambiguity that let the 10 real ElevenLabs failures through.
    if (body.includes("missing_permissions") && mode === "settings") {
      return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้ (เป็น key แบบจำกัดสิทธิ์ — สร้างเสียงได้ปกติ)" };
    }
    // Ambiguous 401 (any shape neither of the above resolved) — only the real TTS
    // endpoint can conclusively confirm it. See `mode` doc above for the cost analysis
    // that makes it safe to always run this (in both modes) rather than skip it.
    const ttsRes = await fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: ".", model_id: "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (ttsRes.ok) return { ok: true, verdict: "valid", message: "✓ ElevenLabs key ใช้งานได้ (ยืนยันด้วยการสร้างเสียง)" };
    if (ttsRes.status === 401 || ttsRes.status === 403) {
      return { ok: false, verdict: "invalid", message: "Key ไม่มีสิทธิ์สร้างเสียง (text_to_speech) — ตรวจสอบสิทธิ์ key ที่ elevenlabs.io" };
    }
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
 *
 * `preflightElevenLabs` runs `testElevenLabsKey` with `mode: "preflight"` (2nd review
 * round, 2026-07-17): it DOES run the real TTS probe on an ambiguous 401 — see the
 * `ElevenLabsCheckMode` doc above for why this is safe and correct to do automatically
 * (the probe only ever costs the user anything when it succeeds, at which point the key
 * was fine and would have spent that same TTS call for real moments later anyway).
 * Final behavior — see the "Fix round" table in the Task 7 report for the full matrix:
 *   - `invalid_api_key` on /v1/user → BLOCK (free, one call).
 *   - `missing_permissions` or any other ambiguous 401 on /v1/user → probe the real TTS
 *     endpoint (one more call, ≤3s): probe 401/403 → BLOCK (definitively missing
 *     text_to_speech); probe 200 → PASS; probe network-error/timeout/other → PASS
 *     (fail-open).
 *   - Any network error/timeout anywhere in the chain → PASS (fail-open).
 */
export async function preflightElevenLabs(key: string): Promise<PreflightBlock | null> {
  const r = await testElevenLabsKey(key, { mode: "preflight" }).catch((): KeyTestResult => ({ ok: false, verdict: "unknown", message: "" }));
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

/**
 * Whether the resolved b-roll stockSource will actually reach for Pexels/Pixabay video
 * search at all (review round, 2026-07-17 — fixes the Pexels preflight running before
 * stockSource was parsed, which could block a kie-image/video-excluded auto-mix job over
 * a Pexels key it would never touch). Pure so it's unit-testable without a live route:
 *  - "kie-image": never touches Pexels/Pixabay (AI image-to-video only).
 *  - "auto-mix": only touches them when the "video" bucket is enabled — default ON
 *    (undefined/empty providers list = every bucket on), OFF only if the caller
 *    explicitly excluded "video" via autoMixProviders.
 *  - "stock" (default/undefined) or anything else: unchanged, always may be used.
 */
export function pexelsStockMayBeUsed(input: { stockSource?: string; autoMixProviders?: string[] }): boolean {
  if (input.stockSource === "kie-image") return false;
  if (input.stockSource === "auto-mix") {
    // Matches fetch-stock's own `autoMixUsesVideo` exactly: undefined/no list = every
    // bucket on (default); an explicit list — EMPTY OR NOT — only allows what's named,
    // so an empty array means nothing is allowed, not "everything."
    return !input.autoMixProviders || input.autoMixProviders.includes("video");
  }
  return true;
}
