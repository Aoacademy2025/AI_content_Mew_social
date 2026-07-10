# TTS Timing Fallback and Provider Retry Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue video jobs when TTS audio succeeds without usable timing by transcribing the already-created voice file, while making HTTP retry behavior explicit and preventing duplicate paid generation.

**Architecture:** Extract caption timing resolution into a pure/injected helper. It validates the existing TTS timing first; on absence it calls `/api/videos/transcribe` exactly once with the existing `voiceUrl`, validates the returned timeline, and reports its timing source. Separately, replace string-parsed HTTP status handling with a typed pipeline error and a bounded retry classifier for network, 408, 429, and 5xx responses.

**Tech Stack:** TypeScript, existing MCP orchestrator/pipeline caller, TTS timing helpers, `/api/videos/transcribe`, server telemetry, tsx verification scripts.

## Global Constraints

- The fallback must not call either TTS endpoint a second time. It always reuses `tts.voiceUrl`.
- A VideoJob retains one normal render reservation. The fallback must not reserve/refund clips, render minutes, or credits.
- Managed Gemini AI-audio accounting may record the real transcription provider spend because it is a separate actual call; do not hide or refund successful provider work.
- Automatic retries are allowed only for network/transport failures, HTTP 408, HTTP 429, and HTTP 5xx. Other 4xx responses fail immediately.
- Paid/non-idempotent generation calls continue to pass `retries: 0` unless they have an explicit provider idempotency key.
- Telemetry is fail-open and never changes job outcome.
- Do not rotate, replace, print, or change the Discord webhook.

---

### Task 1: Replace message-regex retry logic with typed errors

**Files:**

- Modify: `src/lib/mcp/pipeline-client.ts`
- Modify: `scripts/verify-mcp-pipeline-timeout.ts`
- Create: `scripts/verify-mcp-retry-classification.ts`

- [ ] Write failing assertions for the classifier and sleep sequence: network error retries; 408 retries; 429 retries and honors bounded `Retry-After`; 500 retries; 400/401/403/409/422 do not retry; attempts never exceed `retries + 1`.

- [ ] Add a typed error that stores response metadata without exposing more than the existing 300-character sanitized response snippet.

```ts
export class PipelineHttpError extends Error {
  constructor(
    readonly method: "POST" | "GET" | "PATCH",
    readonly path: string,
    readonly status: number,
    readonly responseSnippet: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`${method} ${path} → ${status}: ${responseSnippet}`);
    this.name = "PipelineHttpError";
  }
}

export function isRetriablePipelineError(error: unknown): boolean {
  if (error instanceof PipelineHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return isUndiciTransportError(error);
}
```

- [ ] Implement `isUndiciTransportError()` by checking Undici/network error codes (`UND_ERR_*`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`) through the `cause` chain. An ordinary `Error`, programming error, or JSON parse error is not transport and must not retry.

- [ ] Parse `Retry-After` as seconds or HTTP date and clamp it to 30 seconds. Update `withRetry` to use the classifier and `error.retryAfterMs ?? 1000 * 3 ** attempt`.

- [ ] In `req()`, throw `PipelineHttpError` on non-2xx. Keep response body truncation and do not include request headers/body in the error.

- [ ] Run:

```bash
npx tsx scripts/verify-mcp-retry-classification.ts
npx tsx scripts/verify-mcp-pipeline-timeout.ts
npx tsc --noEmit
```

Expected: all cases PASS; the timeout verifier still proves no duplicate concurrent request on a slow-but-alive call.

- [ ] Commit: `git commit -m "fix(mcp): type and bound pipeline retries"`.

### Task 2: Create a tested caption timing resolver

**Files:**

- Create: `src/lib/mcp/tts-caption-resolution.ts`
- Create: `scripts/verify-tts-caption-resolution.ts`

- [ ] Define the injected contract so tests can count TTS/transcribe calls without HTTP or DB.

```ts
export type TimingSource = "tts" | "transcription";

export type CaptionResolution = {
  captions: OrchCaption[];
  words: Array<{ word: string; startMs: number; endMs: number; startChar: number; endChar: number }>;
  fullText: string;
  audioDurationMs: number;
  timingSource: TimingSource;
};

export type ResolveCaptionTimingInput = {
  voiceUrl: string;
  ttsTiming: unknown;
  ttsAudioDurationMs: number;
  script: string;
  maxCardChars: number;
  viralCards?: ScriptCard[] | null;
  transcribe: (voiceUrl: string, script: string) => Promise<TranscriptionPayload>;
  emit: (name: "tts_timing_fallback_started" | "tts_timing_fallback_done" | "tts_timing_fallback_error", properties?: Record<string, unknown>) => void;
};
```

- [ ] Implement strict timeline validation shared by TTS and transcription results: non-empty text, finite integer millisecond values, `0 <= start < end`, ordered/non-overlapping after the existing sanitizer, positive duration, and last caption not beyond duration by more than one frame.

- [ ] First call `captionsFromTtsTiming()`. If valid, return `timingSource: "tts"` without invoking `transcribe` or fallback telemetry.

- [ ] If TTS timing is absent/invalid, emit started once, call `transcribe(voiceUrl, script)` once, normalize captions to `OrchCaption`, and return `timingSource: "transcription"`. Emit done with caption count/duration; never include script or voice URL in telemetry.

- [ ] Convert transcription words to character offsets by walking `fullText` from the prior match. If a word cannot be mapped safely, return an empty word array and preserve the validated sentence captions; do not invent offsets.

- [ ] On fallback failure, emit error and throw one typed actionable error.

```ts
export class TtsTimingFallbackError extends Error {
  readonly code = "tts_timing_and_transcription_failed";
  readonly retryable = true;
}
```

User message: `สร้างเสียงสำเร็จ แต่ระบบจับเวลาซับไม่สำเร็จ กรุณาลองงานนี้อีกครั้ง`.

- [ ] Verification cases: valid TTS timing; missing timing + valid transcription; malformed timing + valid transcription; empty captions; NaN/reversed/overlapping/out-of-range timestamps; failed transcription; word offset success/fail; telemetry sequence; exactly one fallback call.

- [ ] Run: `npx tsx scripts/verify-tts-caption-resolution.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "feat(mcp): resolve captions through transcription fallback"`.

### Task 3: Wire the resolver into the orchestrator without re-synthesis

**Files:**

- Modify: `src/lib/mcp/orchestrator.ts:453-490`
- Modify: `src/lib/mcp/orchestrator.ts:608-636`
- Modify: `src/lib/mcp/video-job.ts:82-118`
- Modify: `scripts/verify-mcp-orchestrator.ts`

- [ ] Keep the TTS call in its current place but make non-idempotent synthesis explicit with `{ retries: 0 }` for both providers. A transport timeout is surfaced rather than risking a second synthesis after the provider created audio.

```ts
const tts = provider === "elevenlabs"
  ? await caller.post<TtsPayload>("/api/videos/tts", elevenLabsBody, { retries: 0 })
  : await caller.post<TtsPayload>("/api/videos/tts-gemini", geminiBody, { retries: 0 });
```

- [ ] Preserve the current viral-card attempt when TTS timing has text. Pass its result into the resolver. The transcribe fallback uses:

```ts
const timing = await resolveCaptionTiming({
  voiceUrl: tts.voiceUrl,
  ttsTiming: tts.timing,
  ttsAudioDurationMs: tts.audioDurationMs ?? 0,
  script: input.script,
  maxCardChars: maxCardCharsFor(),
  viralCards,
  transcribe: (voiceUrl, script) => caller.post("/api/videos/transcribe", {
    audioUrl: voiceUrl,
    scriptPrompt: script,
    script,
  }, { retries: 0 }),
  emit: emitTimingFallback,
});
```

- [ ] Use `timing.captions`, `timing.words`, `timing.fullText`, and `timing.audioDurationMs` downstream. For word-count subtitle mode, use `cardsByWordCount` only when safe char-offset words exist; otherwise keep the validated transcription captions.

- [ ] Add `captionTimingSource?: "tts" | "transcription"` to `VideoJobPreviewData`, and persist it in preview output. For v1/full jobs, include top-level `captionTimingSource` in output metadata without changing required legacy fields; update the tolerant parser to expose it optionally.

- [ ] Add a local fail-open telemetry emitter using `recordTelemetryEvent` with the exact event names. Properties: `pipelineRunId`, `jobId`, `via: "mcp"`, `provider`, `captionCount`, `durationMs`; never script text or media URLs.

- [ ] Extend orchestrator verification to prove:

  - valid timing never calls `/api/videos/transcribe`;
  - missing timing calls transcribe with the exact returned `voiceUrl`;
  - TTS endpoint is called once total;
  - fallback output reaches keywords/config/render and stores `captionTimingSource`;
  - both timing paths failing calls `failJob` once with the actionable error;
  - no render or paid generation step starts after fallback failure.

- [ ] Run `npx tsx scripts/verify-mcp-orchestrator.ts && npx tsx scripts/verify-tts-caption-resolution.ts && npx tsc --noEmit`.

- [ ] Commit: `git commit -m "fix(mcp): transcribe voice when TTS timing is absent"`.

### Task 4: Prove quota and provider-call invariants

**Files:**

- Create: `scripts/verify-tts-fallback-invariants.ts`
- Modify: `scripts/verify-mcp-audit-status.ts` if new error code classification is surfaced there

- [ ] Seed a temporary user/job and snapshot `usageCount`, `minutesUsed`, `CreditBalance`, `CreditLedger`, and `ChargedClip` before running the resolver/orchestrator with mocked pipeline calls.

- [ ] In the successful fallback case, assert:

  - exactly one TTS call and one transcribe call;
  - no Kie/HeyGen/TTS repeat call;
  - before the normal render step, render quota/credits are unchanged;
  - the full pipeline creates only the same single render reservation as the valid-timing path.

- [ ] In the failed fallback case, assert no render reservation or credit/clip/minute ledger mutation occurs.

- [ ] Verify AI-audio behavior separately: the fallback transcription may increment `aiAudioMinutesUsed` by its actual managed-provider spend, but must not double-count TTS or change render minutes.

- [ ] Run:

```bash
rm -f /tmp/heroai-tts-fallback.db
DATABASE_URL=file:/tmp/heroai-tts-fallback.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-tts-fallback.db npx tsx scripts/verify-tts-fallback-invariants.ts
npx tsc --noEmit
```

- [ ] Commit: `git commit -m "test(mcp): prove TTS fallback billing invariants"`.

### Task 5: Roll out and monitor independently

**Files:**

- No additional code unless telemetry review finds a bug.

- [ ] Deploy this branch separately from cleanup/recovery/deploy hardening.
- [ ] Confirm MCP worker starts once with a valid secret and new code, then submit one controlled missing-timing fixture/job.
- [ ] Monitor counts for all three fallback telemetry events, terminal `tts_timing_and_transcription_failed`, total TTS calls per job, and VideoJob completion rate.
- [ ] Compare the prior audit baseline (9 jobs / 5 users failed on missing TTS timing) with the first seven days. Any fallback that calls TTS twice or mutates extra render quota triggers rollback.
- [ ] Rollback is application-code rollback only; no schema rollback is required for the optional output metadata.

## Final Verification

- [ ] Run the retry, timeout, caption resolver, orchestrator, invariant, subtitle-invariant, and TypeScript checks.
- [ ] Search changed code to confirm both TTS calls specify `retries: 0` and fallback passes the already-created `voiceUrl`.
- [ ] Run `git diff --check` and verify telemetry contains no script/media URL.
- [ ] Acceptance: missing timing completes through transcription, dual failure is actionable/retryable, non-retriable 4xx attempts once, and provider/render billing invariants hold.
