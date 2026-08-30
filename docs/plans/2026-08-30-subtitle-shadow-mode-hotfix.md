# Subtitle Shadow Mode + Render Stability Hotfix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the pre-2026-08-28 render/export success rate by turning every subtitle-quality gate on the TTS-voice path into a *report* (never a block, except truly empty captions), while keeping the acoustic evidence collection, and fix the three stuck/opaque-failure paths measured on prod.

**Architecture:** Keep `validateSubtitleQuality` as the single QA report producer but give it a third status `warning`; the only blocking codes are `empty_script` / `empty_captions`. Render timing for Gemini / Hero AI Voice is **forced alignment when one bounded transcribe call succeeds** (measured on prod: cards >1 s off fall from ~11 % to 1.3 %, audit §5.4), otherwise the deterministic TTS segment clock (`tts_segment_timing`), otherwise the spoken-script clock — always something, never a failure. No TTS regeneration, no retry loops, no export re-alignment, no blocking on text edits. Both clocks and the verification verdict are persisted as evidence (`subtitleQa` / `subtitleEvidence`) for the phase-2 accuracy work. Add a server-side watchdog for `VideoJob` and per-step telemetry for `captions`.

**Tech Stack:** Next.js 15 route handlers, `scripts/mcp-video-worker.ts` PM2 worker, Prisma/SQLite (no schema change), `scripts/verify-*.ts` (tsx) as the test pattern, CI = `.github/workflows/ci.yml`.

**Spec:** `docs/audits/2026-08-30-subtitle-render-stability-audit.md` (prod measurements + gate inventory). Decisions locked with Mew 2026-08-30: (1) Shadow mode, (2) `main` frozen until this ships, (3) acceptance = 48 h prod: create fail ≤15%, export fail ≤3%, zero `subtitle_alignment_*` / `unverified_alignment` / `legacy_caption_projection_failed` / `transcribe_incomplete` failures, no bare "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", `captions` step measurable.

## Global Constraints

- **No Prisma schema change** (deploy path is `prisma db push`; removals/renames unsafe).
- **No new env knob is required for correct behaviour**; the two knobs introduced (`SUBTITLE_VERIFY_BUDGET_MS`, `VIDEO_JOB_STALE_MS`) have safe defaults and exist only for ops tuning.
- **Never fail a job for a subtitle reason other than "nothing to show"** — see `BLOCKING_SUBTITLE_CODES` in Task 1. This is the ADR-0056 invariant ("subtitle QA is a report, not a gate").
- **No extra provider spend on the subtitle path**: no Gemini TTS regeneration triggered by alignment results; at most ONE transcribe call per job.
- Thai copy for user-facing messages; English for code comments and docs.
- Every task ends with `npx tsc --noEmit --pretty false` clean (ignore the pre-existing `artifacts/ops-close-2026-08-21-brand-visual-tickets.ts:138` error) and the listed `npm run verify:*` scripts green.
- Work happens in the Orca worktree `/Users/mewsocialmacmini/projects/AI_content_Mew_social-subtitle-render-stability-audit` (branch `subtitle-render-stability-audit`, based on `origin/main` `3c14d318`). One PR; one commit per task.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017HS8srSV1aKc3HNtrb9gZy`.

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Subtitle QA `warning` status + blocking-code policy + timing repair | mew-worker-heavy | subagent | — | tsc, `verify:subtitle-audio-sync`, `verify:subtitle-release-audit`, code review |
| 2 | Orchestrator: one bounded alignment call → forced-alignment timing, else TTS clock; no regen/retry; export never re-aligns | mew-worker-heavy | subagent | 1 | tsc, `verify:subtitle-audio-sync`, `verify:provider-subtitle-alignment`, `verify:export-gallery-metadata`, `verify:mcp-perfect`, `npm run build`, code review + security-review (external API call path) |
| 3 | Client export preflight: content edits allowed | mew-worker | subagent | 1 | tsc, `verify:caption-card-editing`, `verify:post-export-edit-state`, code review |
| 4 | Upload transcription: partial coverage is a warning, not a 422 | mew-worker-heavy | subagent | 1 | tsc, `verify:transcribe-alignment`, code review |
| 5 | Error specificity + `captions` step telemetry | mew-worker | subagent | 2 | tsc, `verify:mcp-perfect`, `verify:quota-error-shape`, code review |
| 6 | VideoJob server-side watchdog | mew-worker-heavy | subagent | — | tsc, `verify:render-queue`, new `verify:video-job-watchdog`, code review |
| 7 | Export `stale_export_source` + silent Render button | mew-worker | subagent | — | tsc, `verify:editor-job-runtime`, code review |
| 8 | ADR 0056 + audit report + CONTEXT.md glossary | (session model) | inline | 1–7 | critic vs acceptance criteria |

Tasks 1, 6, 7 form the initial frontier (independent files). 3 and 4 unlock after 1; 2 after 1; 5 after 2.

---

### Task 1: Subtitle QA `warning` status + blocking policy + timing repair

**Files:**
- Modify: `src/lib/mcp/subtitle-quality.ts:1005-1035` (policy), `:1048-1177` (`validateSubtitleQuality` status mapping)
- Modify: `src/lib/subtitle-release-audit.ts:60-95` (severity mapping)
- Test: `scripts/verify-subtitle-quality-policy.ts` (new), update `scripts/verify-subtitle-release-audit.ts`, `scripts/verify-orchestrator-timing-fallback.ts`, `scripts/verify-avatar-caption-fallback.ts` expectations
- Modify: `package.json` scripts — add `"verify:subtitle-quality-policy": "node --conditions=react-server --import tsx scripts/verify-subtitle-quality-policy.ts"` and add it to the `verify:subtitle-audio-sync` chain.

**Interfaces:**
- Produces:
  ```ts
  export type SubtitleQualityStatus = "passed" | "warning" | "failed";
  export const BLOCKING_SUBTITLE_CODES = ["empty_script", "empty_captions"] as const;
  export function subtitleQualityShouldFailJob(report: SubtitleQualityReport): boolean; // === report.status === "failed"
  export function repairCaptionTiming(captions: OrchCaption[], audioDurationMs: number): { captions: OrchCaption[]; repaired: boolean; dropped: number };
  ```
  `SubtitleQualityReport` gains `status: "warning"` carrying the same `code`/`captionIndex` fields as `failed`.

- [ ] **Step 1: Write the failing policy test** — `scripts/verify-subtitle-quality-policy.ts`

```ts
import assert from "node:assert/strict";
import {
  validateSubtitleQuality, subtitleQualityShouldFailJob, repairCaptionTiming, BLOCKING_SUBTITLE_CODES,
} from "../src/lib/mcp/subtitle-quality";

const script = "สวัสดีครับ วันนี้เรามาคุยกันเรื่องการออม";
const caps = [
  { text: "สวัสดีครับ", startMs: 0, endMs: 900, tag: "hook" as const },
  { text: "วันนี้เรามาคุยกันเรื่องการออม", startMs: 900, endMs: 3000, tag: "body" as const },
];
// 1. Gemini segment clock is releasable as a warning, never a failure
const gemini = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 3000, timingSource: "tts_segment_timing" });
assert.equal(gemini.status, "warning"); assert.equal(gemini.status !== "passed" && gemini.code, "unverified_alignment");
assert.equal(subtitleQualityShouldFailJob(gemini), false);
// 2. avatar_script_clock likewise
assert.equal(subtitleQualityShouldFailJob(validateSubtitleQuality({ script, captions: caps, audioDurationMs: 3000, timingSource: "avatar_script_clock" })), false);
// 3. text edits are a warning
const edited = validateSubtitleQuality({ script, captions: [caps[0], { ...caps[1], text: "วันนี้มาคุยเรื่องการออมกัน" }], audioDurationMs: 3000, timingSource: "forced_alignment" });
assert.equal(edited.status, "warning"); assert.equal(subtitleQualityShouldFailJob(edited), false);
// 4. speech coverage incomplete is a warning
const tail = validateSubtitleQuality({ script, captions: caps, audioDurationMs: 12000, timingSource: "forced_alignment", speechCoverage: { source: "transcribe", spokenEndMs: 11500 } });
assert.equal(tail.status, "warning"); assert.equal(subtitleQualityShouldFailJob(tail), false);
// 5. only empty script / empty captions block
assert.deepEqual([...BLOCKING_SUBTITLE_CODES], ["empty_script", "empty_captions"]);
assert.equal(validateSubtitleQuality({ script, captions: [], audioDurationMs: 3000, timingSource: "forced_alignment" }).status, "failed");
assert.equal(validateSubtitleQuality({ script: "", captions: caps, audioDurationMs: 3000, timingSource: "forced_alignment" }).status, "failed");
// 6. repair: empty card dropped, overlap/out-of-bounds clamped, monotonic, >= 240 ms
const bad = [
  { text: "ก", startMs: -100, endMs: 500, tag: "hook" as const },
  { text: "   ", startMs: 500, endMs: 900, tag: "body" as const },
  { text: "ข", startMs: 800, endMs: 850, tag: "body" as const },
  { text: "ค", startMs: 2000, endMs: 9000, tag: "cta" as const },
];
const fixed = repairCaptionTiming(bad, 3000);
assert.equal(fixed.dropped, 1); assert.equal(fixed.repaired, true);
assert.equal(fixed.captions[0].startMs, 0);
assert.ok(fixed.captions.every((c, i, a) => c.endMs - c.startMs >= 240 && (i === 0 || c.startMs >= a[i - 1].endMs)));
assert.equal(fixed.captions[fixed.captions.length - 1].endMs, 3000);
// 7. a clean set is untouched
assert.deepEqual(repairCaptionTiming(caps, 3000), { captions: caps, repaired: false, dropped: 0 });
console.log("verify-subtitle-quality-policy: ok");
```

- [ ] **Step 2: Run it — expect FAIL** (`repairCaptionTiming`/`BLOCKING_SUBTITLE_CODES` undefined, status `failed` instead of `warning`)

Run: `node --conditions=react-server --import tsx scripts/verify-subtitle-quality-policy.ts`

- [ ] **Step 3: Implement the policy in `subtitle-quality.ts`**

Replace lines 1005-1035 with:

```ts
export type SubtitleQualityStatus = "passed" | "warning" | "failed";

/** The only subtitle findings that make a clip un-renderable. Everything else is a
 *  report the creator sees in the Post phase (ADR 0056: subtitle QA is a report, not a gate). */
export const BLOCKING_SUBTITLE_CODES = ["empty_script", "empty_captions"] as const;
const BLOCKING_SUBTITLE_CODE_SET = new Set<string>(BLOCKING_SUBTITLE_CODES);

export const INLINE_FIXABLE_SUBTITLE_CODES = ["spacing_mismatch", "punctuation_only_card", "card_too_short"] as const;
export type InlineFixableSubtitleCode = (typeof INLINE_FIXABLE_SUBTITLE_CODES)[number];
const INLINE_FIXABLE_SUBTITLE_CODE_SET = new Set<string>(INLINE_FIXABLE_SUBTITLE_CODES);
export function isInlineFixableSubtitleCode(code: string | undefined): code is InlineFixableSubtitleCode {
  return Boolean(code && INLINE_FIXABLE_SUBTITLE_CODE_SET.has(code));
}

export function subtitleQualityShouldFailJob(report: SubtitleQualityReport): boolean {
  return report.status === "failed";
}

/** Deterministic, render-safe timing repair. Never changes text; drops blank cards;
 *  clamps to [0, audioDurationMs]; enforces monotonic non-overlapping cards ≥ 240 ms. */
export function repairCaptionTiming<T extends { text: string; startMs: number; endMs: number }>(
  captions: T[], audioDurationMs: number,
): { captions: T[]; repaired: boolean; dropped: number } {
  const kept = captions.filter((c) => c.text.trim().length > 0);
  const dropped = captions.length - kept.length;
  const out: T[] = [];
  let cursor = 0;
  for (const c of kept) {
    let start = Math.max(cursor, Number.isFinite(c.startMs) ? Math.max(0, Math.round(c.startMs)) : cursor);
    let end = Number.isFinite(c.endMs) ? Math.round(c.endMs) : start + MIN_CARD_MS;
    if (end - start < MIN_CARD_MS) end = start + MIN_CARD_MS;
    if (audioDurationMs > 0 && end > audioDurationMs) { end = audioDurationMs; if (end - start < MIN_CARD_MS) start = Math.max(cursor, end - MIN_CARD_MS); }
    out.push({ ...c, startMs: start, endMs: end });
    cursor = end;
  }
  const repaired = dropped > 0 || out.some((c, i) => c.startMs !== kept[i].startMs || c.endMs !== kept[i].endMs);
  return { captions: repaired ? out : captions, repaired, dropped };
}
```

In `validateSubtitleQuality` (`:1048-1177`): keep every existing check and code, but at each `return { status: "failed", … }` whose `code` is **not** in `BLOCKING_SUBTITLE_CODE_SET`, return `status: "warning"` instead. Simplest: wrap the function — rename the current body to `classifySubtitleQuality` (unchanged) and add:

```ts
export function validateSubtitleQuality(input: SubtitleQualityInput): SubtitleQualityReport {
  const report = classifySubtitleQuality(input);
  if (report.status === "failed" && !BLOCKING_SUBTITLE_CODE_SET.has(report.code)) {
    return { ...report, status: "warning" };
  }
  return report;
}
```

Update the `SubtitleQualityReport` union so the `warning` variant has exactly the fields of the `failed` variant. Fix every consumer `tsc` flags: `subtitleQualityInlineCopy` callers, `orchestrator.ts` checks of `status !== "passed"` (they remain valid), `subtitle-release-audit.ts` (Step 4), `usePostPhaseEditor.ts` / editor surfaces that read `subtitleQa.status === "failed"` — treat `"warning"` the same as `"failed"` for *display* (inline hint), never for blocking.

- [ ] **Step 4: Release audit severity** — `src/lib/subtitle-release-audit.ts:60-95`: `failed_subtitle_qa` stays `p0` only when `qa.status === "failed"`; add `code: "subtitle_qa_warning", severity: "p1"` for `warning`; the `unverified_alignment` push at `:65-67` becomes severity `"p1"`; `invalid_speech_coverage` `:93` becomes `"p1"`. Update `scripts/verify-subtitle-release-audit.ts` expectations accordingly (a `tts_segment_timing` release is now p1, not p0).

- [ ] **Step 5: Run the policy test and the existing suites — expect PASS**

Run: `node --conditions=react-server --import tsx scripts/verify-subtitle-quality-policy.ts && npm run verify:subtitle-release-audit && npx tsc --noEmit --pretty false`
Expected: all green except the known `artifacts/...:138` tsc line. Fixtures in `verify-orchestrator-timing-fallback.ts` / `verify-avatar-caption-fallback.ts` that asserted a job *fails* on `unverified_alignment` must be flipped to assert `status: "warning"` + job proceeds — do that here, do not delete the checks.

- [ ] **Step 6: Commit** — `git commit -m "fix(subtitles): QA warning status — only empty captions block a render (ADR 0056)"`

---

### Task 2: Orchestrator — one bounded alignment call, fail-open timing ladder, export never re-aligns

**Files:**
- Modify: `src/lib/mcp/orchestrator.ts:1850-2100` (create path), `:1228-1356` (export path)
- Modify: `src/lib/mcp/subtitle-alignment-retry.ts` (unused after this task — delete only if no other importer; otherwise leave)
- Test: `scripts/verify-provider-subtitle-alignment.ts` (update), `scripts/verify-orchestrator-timing-fallback.ts` (update), `scripts/verify-export-gallery-metadata.ts` (update the "legacy replay" cases)

**Interfaces:**
- Consumes (Task 1): `validateSubtitleQuality` (warning status), `repairCaptionTiming`, `subtitleQualityShouldFailJob`.
- Produces: `subtitleEvidence.verification` persisted in job output:
  ```ts
  type SubtitleVerification = {
    status: "aligned" | "failed" | "skipped" | "timeout";
    code?: string;                 // alignment failure code when status === "failed"
    method?: "exact" | "fuzzy";
    similarityPermille?: number;
    durationMs: number;
    ttsCaptions: Array<{ startMs: number; endMs: number }>;   // the provider-clock captions that were NOT rendered (evidence)
    maxAbsStartDeltaMs?: number;   // max |tts card start − rendered card start| across cards (when counts match)
    medianAbsStartDeltaMs?: number;
  };
  ```
  `SUBTITLE_VERIFY_BUDGET_MS = Number(process.env.SUBTITLE_VERIFY_BUDGET_MS ?? 180_000)`.

- [ ] **Step 1: Write the failing behaviour tests** in `scripts/verify-provider-subtitle-alignment.ts` (this script already builds an orchestrator harness with a fake `caller`; extend it):

```ts
// A. Gemini job: transcribe returns garbage (alignment fails) → job still completes; timingSource === "tts_segment_timing";
//    subtitleQa.status === "warning" (unverified_alignment); evidence.verification.status === "failed" with a code;
//    exactly ONE POST /api/videos/transcribe; ZERO extra POST /api/videos/tts-gemini.
// B. Gemini job: transcribe hangs 5 s with SUBTITLE_VERIFY_BUDGET_MS=1000 → job completes on the TTS clock;
//    evidence.verification.status === "timeout"; render POST happened after ≤ ~1 s, not after 5 s.
// C. Gemini job: transcribe returns good words → rendered captions are the forced-alignment captions
//    (timingSource "forced_alignment", subtitleQa.status === "passed"); evidence.verification.status === "aligned",
//    ttsCaptions persisted, medianAbsStartDeltaMs is a number.
// D. Gemini job where tts-gemini fail-open returns no `timing` AND transcribe fails → captions come from
//    captionsFromSpokenScript (timingSource "avatar_script_clock"), job completes, subtitleQa.status === "warning".
// E. ElevenLabs job: provider_alignment path unchanged, no transcribe call.
// F. Export job whose source preview has timingSource "tts_segment_timing" and NO subtitleQa → export completes,
//    ZERO transcribe calls, captions burned exactly as submitted (after repairCaptionTiming).
// G. Export job with edited caption text (content mismatch) → export completes; exportSubtitleQa.status === "warning".
// H. Export job with one blank card → blank card dropped, export completes.
// I. Gemini job where alignment returns "numeric_claim_mismatch" → job completes on the TTS clock (warning), no regeneration.
```
Each case asserts on the fake caller's call log (`calls.filter(c => c.path === "/api/videos/transcribe").length`, same for `/api/videos/tts-gemini`).

- [ ] **Step 2: Run — expect FAIL** (`npm run verify:provider-subtitle-alignment`): A throws `SubtitleAlignmentFailureError`, B waits the full 5 s, F throws `missing_legacy_replay_evidence`, G throws `text_mismatch`, I regenerates TTS.

- [ ] **Step 3: Rewrite the create path (`orchestrator.ts:1850-2100`)**

Replace the `acousticAttempts` loop, `geminiRegenerationCodes`, `generatedTtsFallbackCodes`, and the inner `while (true)` retry with this ladder:

```ts
// 1. Provider clock (always available or synthesised).
let subtitleTimingSource: SubtitleTimingSource = provider === "elevenlabs" ? "provider_alignment" : "tts_segment_timing";
let capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor(), viralCards); // viralCards as today
if (!capRes || capRes.captions.length === 0) {
  // fail-open: provider returned no timing (tts-gemini single-call fallback) → char-proportional clock over the measured duration
  capRes = captionsFromSpokenScript(narrationText, audioDurationMs, maxCardCharsFor(), viralCards); // match the existing signature in tts-timing-captions.ts:144
  subtitleTimingSource = "avatar_script_clock";
}
const ttsCaptions = capRes.captions.map((c) => ({ startMs: c.startMs, endMs: c.endMs }));
// 2. ONE bounded acoustic alignment (Gemini / Hero AI Voice only). Success → it becomes the render clock.
let verification: SubtitleVerification = { status: "skipped", durationMs: 0, ttsCaptions };
if (provider !== "elevenlabs") {
  verification = await alignNarrationOnce({ caller, audioUrl: tts.voiceUrl, narrationText, maxCardChars: maxCardCharsFor(), budgetMs: SUBTITLE_VERIFY_BUDGET_MS, ttsCaptions });
  if (verification.status === "aligned" && verification.capRes) {
    capRes = verification.capRes;                 // captions + words from buildCanonicalCaptionsFromAlignedWords
    subtitleTimingSource = "forced_alignment";
    subtitleSpeechCoverage = verification.speechCoverage;
  }
}
```

`alignNarrationOnce` (new function in `orchestrator.ts`, ~50 lines): `Promise.race` of a single `caller.post("/api/videos/transcribe", { audioUrl, scriptPrompt: narrationText.slice(0,800), script: narrationText }, { retries: 0 })` against `sleep(budgetMs)` → on `timeout` returns `{ status: "timeout", durationMs, ttsCaptions }` (the in-flight request is abandoned; log once). On response: `alignTranscriptWordsToSourceDetailed(narrationText, words)`; if `aligned` → `buildCanonicalCaptionsFromAlignedWords(narrationText, words, maxCardChars)`; if that returns captions → `{ status: "aligned", method, similarityPermille, durationMs, ttsCaptions, capRes: { captions, words, audioDurationMs, fullText: narrationText }, speechCoverage, medianAbsStartDeltaMs, maxAbsStartDeltaMs }` (deltas computed by index when `captions.length === ttsCaptions.length`, else omitted with `code: "card_count_mismatch"` kept as info). Any thrown error / failed alignment → `{ status: "failed", code, durationMs, ttsCaptions }`. Emits ONE telemetry event `subtitle_verification_done` (`category: "pipeline"`, `step: "captions"`, `status`, `durationMs`, properties `{ provider, method, similarityPermille, medianAbsStartDeltaMs, maxAbsStartDeltaMs, code }`). It never throws.

Then:

```ts
const repaired = repairCaptionTiming(captionsAfterWordMode, durMs);   // cardsByWordCount(...) as today, then repair
const captions = repaired.captions;
const subtitleQa = validateSubtitleQuality({ script: capRes.fullText, captions, audioDurationMs: durMs, timingSource: subtitleTimingSource, speechCoverage: subtitleSpeechCoverage });
if (subtitleQa.status !== "passed") emitTelemetry({ name: "subtitle_quality_report", category: subtitleQa.status === "failed" ? "error" : "pipeline", source: "server", step: "captions", status: subtitleQa.code, properties: { pipelineRunId, jobId, via: "mcp", provider, timingSource: subtitleTimingSource, repaired: repaired.repaired, dropped: repaired.dropped, verification: verification.status } });
if (subtitleQualityShouldFailJob(subtitleQa)) throw new SubtitleAlignmentFailureError(`ไม่มีข้อความซับสำหรับคลิปนี้ (${subtitleQa.code}) — กรุณาตรวจสคริปต์แล้วลองใหม่`, subtitleQa.code, provider);
```

Persist `verification` (without `capRes`) as `subtitleEvidence.verification` in every `finishJob` (preview `:2369`, burn `:2431`) and in the avatar checkpoint (`:2333`, so the resume path does not re-run alignment). **Delete** the avatar-checkpoint resume re-validation throw at `:823-824` (keep the `validateSubtitleQuality` call; only `subtitleQualityShouldFailJob` may throw, and it now only throws for empty captions). Delete `subtitleAlignmentTechnicalRetryDirective` usage and the `subtitle_alignment_tts_retry_scheduled` / `subtitle_alignment_technical_retry_scheduled` / `subtitle_alignment_generated_tts_fallback` emitters.

- [ ] **Step 4: Rewrite the export path (`orchestrator.ts:1252-1356`)**

Delete the `sourceNeedsAlignmentRecovery` block (`:1252-1330`) entirely — no transcribe call on export. Replace with:

```ts
const repairedExport = repairCaptionTiming(finalCaptions, exportAudioDurationMs ?? 0);
finalCaptions = repairedExport.captions;
if (repairedExport.repaired) exportOverlayConfig = retimeSubtitleOverlayConfig(input.subtitleOverlayConfig, finalCaptions) ?? input.subtitleOverlayConfig;
const exportSubtitleQa = validateSubtitleQuality({ script: canonicalScript, captions: finalCaptions, audioDurationMs: exportAudioDurationMs, timingSource: exportTimingSource, speechCoverage: exportSpeechCoverage });
if (exportSubtitleQa.status !== "passed") emitTelemetry({ name: "subtitle_quality_report", category: exportSubtitleQa.status === "failed" ? "error" : "pipeline", source: "server", step: "burn", status: exportSubtitleQa.code, properties: { pipelineRunId, jobId, via: "mcp", mode: "export", timingSource: exportTimingSource, dropped: repairedExport.dropped } });
if (subtitleQualityShouldFailJob(exportSubtitleQa)) throw new SubtitleAlignmentFailureError("ไม่มีข้อความซับให้ส่งออก — เปิดชั้นซับหรือเพิ่มข้อความอย่างน้อย 1 กล่องก่อนส่งออก", exportSubtitleQa.code, sourceInput?.voiceProvider);
```

Keep `exportWords = preview.words ?? []` and `exportSpeechCoverage` as today for evidence. Remove the three `SubtitleAlignmentFailureError` throws for `missing_legacy_replay_evidence`, `legacy_caption_projection_failed`, `legacy_overlay_projection_failed` and the `retimeCanonicalCaptionsFromAlignedWords` import if now unused.

- [ ] **Step 5: Run the suites — expect PASS**

Run: `npm run verify:provider-subtitle-alignment && npm run verify:subtitle-audio-sync && npm run verify:export-gallery-metadata && npm run verify:mcp-perfect && npx tsc --noEmit --pretty false`
Then `npm run build` (must pass; note route count).

- [ ] **Step 6: Commit** — `git commit -m "fix(subtitles): render from the TTS clock, verify acoustically off the critical path, never re-align on export"`

---

### Task 3: Client export preflight — content edits allowed

**Files:**
- Modify: `src/lib/caption-card-editing.ts:32-58`
- Modify: `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts:1100-1113`
- Test: `scripts/verify-caption-card-editing.ts` (update), add `verify:caption-card-editing` to `ci.yml` after `verify:editor-style-presets`

- [ ] **Step 1: Failing test** — in `scripts/verify-caption-card-editing.ts` replace the `spoken_content_changed` expectation with:

```ts
const edited = captionExportPreflight([{ text: "ข้อความที่แก้แล้ว" }], true, "ข้อความเดิม", "creator-script");
assert.deepEqual(edited, { ok: true });
const blank = captionExportPreflight([{ text: "ก" }, { text: "  " }], true, "กข", "creator-script");
assert.deepEqual(blank, { ok: false, reason: "blank_caption", index: 1 });
```

- [ ] **Step 2: Run — expect FAIL** (`npm run verify:caption-card-editing`).

- [ ] **Step 3: Implement** — `captionExportPreflight` returns only `blank_caption`; remove the `spoken_content_changed` branch and the `CaptionExportPreflightResult` reason; delete the now-unused `narrationText`/`narrativeSourceKind` params **only if** tsc shows no other caller — otherwise keep them ignored with a comment `// content edits are allowed (ADR 0056)`. In `usePostPhaseEditor.ts` the toast for `spoken_content_changed` goes away (single blank-card message remains).

- [ ] **Step 4: Run — expect PASS**: `npm run verify:caption-card-editing && npm run verify:post-export-edit-state && npx tsc --noEmit --pretty false`

- [ ] **Step 5: Commit** — `git commit -m "fix(editor): exporting edited subtitle text is allowed"`

---

### Task 4: Upload transcription — partial coverage is a warning, not a 422

**Files:**
- Modify: `src/app/api/videos/transcribe/route.ts:1176-1307` (the 422 branches: fine-recovery exhausted, recovery exhausted, chunk 3-attempt, single-call), `:1789-1795` (`word_timing_incomplete`), `:1866-1888` (`transcribe_desynced`, `transcribe_incomplete`)
- Modify: `src/lib/mcp/orchestrator.ts:1495-1525` (upload path consumer: `ถอดซับจากคลิปไม่สำเร็จ` stays only for zero captions)
- Test: `scripts/verify-transcribe-quality-retry.ts`, `scripts/verify-transcribe-desync-guard.ts`, `scripts/verify-transcribe-chunking.ts` (update), new case in `scripts/verify-transcribe-words-guard.ts`

**Interfaces:**
- Produces: transcribe response gains `warnings?: Array<{ code: "transcribe_incomplete" | "transcribe_desynced" | "word_timing_incomplete" | "chunk_recovery_exhausted"; fromMs?: number; toMs?: number }>` and HTTP 200 whenever ≥1 caption was produced. HTTP 422 remains only for `empty_transcript` / `no_usable_words` (zero captions) and for the provider/quota/key errors already in place (401/403/409/429).

- [ ] **Step 1: Failing tests**: in `verify-transcribe-chunking.ts` add a fixture where chunk 2 of 3 fails all attempts → expect HTTP 200, captions from chunks 1+3, `warnings[0].code === "chunk_recovery_exhausted"` with `fromMs/toMs` of chunk 2. In `verify-transcribe-desync-guard.ts` the >10% overshoot case → 200 + `warnings[0].code === "transcribe_desynced"`, captions clamped by `repairCaptionTiming`. In `verify-transcribe-words-guard.ts` the incomplete-word case → 200 + captions kept + `warnings[0].code === "word_timing_incomplete"`, `words: []`.
- [ ] **Step 2: Run — expect FAIL** (`npm run verify:transcribe-alignment`).
- [ ] **Step 3: Implement** — each listed 422 branch becomes `warnings.push({...})` + continue with what was produced; the final response builder calls `repairCaptionTiming(captions, audioDurationMs)` (import from `@/lib/mcp/subtitle-quality`) and returns 422 `empty_transcript` only when `captions.length === 0`. Orchestrator upload consumer (`:1495-1525`): persist `warnings` into `subtitleEvidence.uploadWarnings`; `validateSubtitleQuality` result handled with `subtitleQualityShouldFailJob` (Task 1 semantics).
- [ ] **Step 4: Run — expect PASS**: `npm run verify:transcribe-alignment && npx tsc --noEmit --pretty false`
- [ ] **Step 5: Commit** — `git commit -m "fix(transcribe): partial upload transcription is a warning, not a failure"`

---

### Task 5: Error specificity + `captions` step telemetry

**Files:**
- Modify: `src/lib/mcp/orchestrator.ts:555-575` (`STEP_TELEMETRY_NAME`, `emitStage`), the `catch` at `:2443+` (`failJob` call)
- Modify: `src/lib/mcp/pipeline-client.ts:75-95` (error envelope → `code`), `:195-210` (`pollRender` messages)
- Modify: `src/lib/api-error.ts:74-90` (`friendlyMessage` keeps the original cause in a `detail` field)
- Test: `scripts/verify-mcp-release-gates.ts` (extend), new `scripts/verify-pipeline-error-specificity.ts`, add to `verify:mcp-perfect`

- [ ] **Step 1: Failing tests** (`scripts/verify-pipeline-error-specificity.ts`):

```ts
// 1. STEP_TELEMETRY_NAME maps "captions" → "captions" (no longer skipped); emitStage("captions","done",1234) produces pipeline_step_done with durationMs 1234.
// 2. A route error envelope { error: { code: "render_maintenance", message: "…" } } thrown by caller.post surfaces as
//    PipelineApiError { code: "render_maintenance", message, status }.
// 3. pollRender with p.stage === "error" and p.error === "Cannot find module '@remotion/bundler'" throws
//    PipelineApiError { code: "render_worker_failed", message: "render failed: Cannot find module '@remotion/bundler'" }.
// 4. failJob mapping: an Error without code at step "render" stores errorCode "render_unknown" and errorMessage
//    "เรนเดอร์ไม่สำเร็จ (render_unknown): <first 160 chars of the scrubbed cause>" — never the bare
//    "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง".
// 5. api-error friendlyMessage(err) returns { message: <friendly>, detail: <scrubbed original, ≤ 300 chars> } and the JSON
//    envelope includes `detail` (assert on buildErrorResponse output).
```

- [ ] **Step 2: Run — expect FAIL**.
- [ ] **Step 3: Implement**: (a) `STEP_TELEMETRY_NAME.captions = "captions"`; emit `pipeline_step_done` for it like other steps. (b) `pipeline-client.ts`: introduce `export class PipelineApiError extends Error { code: string; status?: number; detail?: string }`; `caller.post` throws it with `code` from the envelope (`error.code` or `code`), `detail` from `error.detail`; `pollRender` throws `PipelineApiError` with `code: "render_worker_failed"` / `"render_timeout"`. (c) orchestrator catch: `const code = e instanceof PipelineApiError ? e.code : (pipelineFailureDetails(e)?.code ?? \`${phaseName || "unknown"}_unknown\`)`; message = specific Thai per step prefix + `(${code})` + `: ${scrubbed cause ≤160 chars}`; pass `code` as `errorCode` to `failJob`. Step prefixes: `tts` "สร้างเสียงไม่สำเร็จ", `captions` "สร้างซับไม่สำเร็จ", `keywords`/`stock` "หา B-roll ไม่สำเร็จ", `render` "เรนเดอร์ไม่สำเร็จ", `avatar`/`composite` "ประกอบ Avatar ไม่สำเร็จ", `burn` "ส่งออกไม่สำเร็จ", `save` "บันทึกวิดีโอไม่สำเร็จ". Existing specific messages thrown deliberately (plan limits, quota, `SubtitleAlignmentFailureError`, content preflight) are kept verbatim — only *unknown* errors get the prefix form. (d) `api-error.ts`: `friendlyMessage` returns `{ message, detail }`; `detail = scrubSecrets(originalMessage).slice(0, 300)`; JSON envelope adds `detail`.
- [ ] **Step 4: Run — expect PASS**: `npm run verify:mcp-perfect && npm run verify:quota-error-shape && npx tsc --noEmit --pretty false`
- [ ] **Step 5: Commit** — `git commit -m "fix(pipeline): specific failure codes + captions step telemetry"`

---

### Task 6: VideoJob server-side watchdog

**Files:**
- Create: `src/lib/mcp/video-job-watchdog.ts`
- Modify: `scripts/mcp-video-worker.ts` (call the watchdog once per poll loop, before claiming)
- Modify: `src/lib/mcp/video-job.ts:170-180` (`claimNextRunnableJob` — also claim `waiting_provider` rows whose `providerNextPollAt IS NULL`)
- Test: `scripts/verify-video-job-watchdog.ts` (new; disposable SQLite via the existing `scripts/_lib/temp-db.ts` pattern used by `verify-render-queue.ts`), add `"verify:video-job-watchdog"` to `package.json` and to `ci.yml` after `verify:editor-job-runtime`

**Interfaces:**
- Produces:
  ```ts
  export const VIDEO_JOB_STALE_MS = Number(process.env.VIDEO_JOB_STALE_MS ?? 45 * 60_000);
  export async function sweepStalledVideoJobs(now = new Date()): Promise<{ failed: string[]; repairedPoll: string[] }>;
  ```

- [ ] **Step 1: Failing test** (`scripts/verify-video-job-watchdog.ts`):

```ts
// seed: A) processing, updatedAt = now-50min, currentStep "tts"      → expect failed with errorCode "job_stalled", reservationRefundPending true, EditorProject.status back to "draft"
//       B) processing, updatedAt = now-10min                           → untouched
//       C) waiting_provider, providerNextPollAt NULL, updatedAt -1h    → providerNextPollAt set to now (repairedPoll), status unchanged
//       D) processing, updatedAt = now-50min, step "avatar" with providerCheckpointJson present → untouched (provider-bound work has its own 2h deadline)
//       E) queued, createdAt -3h                                        → untouched (queued is the worker's backlog, not a stall)
// assert sweep is idempotent (second call returns empty arrays) and message is
// "งานหยุดตอบสนองนานเกิน 45 นาที (job_stalled) — ระบบยกเลิกและคืนโควต้าให้แล้ว กรุณาลองใหม่"
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement** `sweepStalledVideoJobs`: `prisma.videoJob.findMany({ where: { status: "processing", updatedAt: { lt: new Date(now - VIDEO_JOB_STALE_MS) }, providerCheckpointJson: null }, select: { id: true, currentStep: true } })` → for each, `failJob(id, message, { errorCode: "job_stalled" })` (reuse the existing `failJob` in `video-job.ts` so refund flags + project transition are identical to a normal failure) and emit telemetry `video_job_stalled` (`category: "error"`, `step: currentStep`). Then `updateMany({ where: { status: "waiting_provider", providerNextPollAt: null }, data: { providerNextPollAt: now } })`. In `scripts/mcp-video-worker.ts` call it at the top of each poll iteration inside `try/catch` (log-only on error). Ensure `setJobStep` updates `updatedAt` (Prisma `@updatedAt` does this automatically on every update — verify by reading `video-job.ts` `setJobStep`).
- [ ] **Step 4: Run — expect PASS**: `npm run verify:video-job-watchdog && npm run verify:render-queue && npx tsc --noEmit --pretty false`
- [ ] **Step 5: Commit** — `git commit -m "fix(worker): fail stalled VideoJobs after 45 min and repair unclaimable provider waits"`

---

### Task 7: Export `stale_export_source` + silent Render button

**Files:**
- Modify: `src/lib/editor-projects.ts:387-410` (`assertCurrentEditorExportSource`)
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx:249-252` (`handleRender`)
- Test: `scripts/verify-editor-project-recovery-hook.ts` (extend), `scripts/verify-export-gallery-metadata.ts` (one case)

- [ ] **Step 1: Failing tests**: (a) `assertCurrentEditorExportSource(project, sourceJobId)` accepts a `sourceJobId` that is **any done `create` VideoJob of the same project created after the project's latest export source** (i.e., the b-roll re-render child) — fixture: project.activeJobId = J2, sourceJobId = J1 where J1 is done and J1.projectId === project.id and J1.createdAt ≥ J2.createdAt of the last export → expect no throw; a job from another project still throws `stale_export_source`. (b) `handleRender` when `canRunProjectOperation()` is false calls `toast.error("โปรเจกต์กำลังกู้คืน/โหลด — รอสักครู่แล้วกดเรนเดอร์อีกครั้ง")` (assert via the harness's toast spy).
- [ ] **Step 2: Run — expect FAIL**.
- [ ] **Step 3: Implement** both changes (≤30 lines total).
- [ ] **Step 4: Run — expect PASS**: `npm run verify:editor-job-runtime && npm run verify:export-gallery-metadata && npx tsc --noEmit --pretty false`
- [ ] **Step 5: Commit** — `git commit -m "fix(editor): accept the current project render as export source; explain a disabled Render button"`

---

### Task 8 (session, inline): ADR 0056 + audit report + glossary

- `docs/adr/0056-subtitle-qa-is-a-report-not-a-gate.md` — context (prod numbers), decision (blocking codes = empty only; render timing = provider clock; verification = evidence off the critical path; no provider spend from QA), consequences (phase-2 accuracy work changes the timing *source*, never adds gates).
- `docs/audits/2026-08-30-subtitle-render-stability-audit.md` — final numbers + measurement tables.
- `CONTEXT.md`: add **Subtitle QA Report / รายงานคุณภาพซับ** and **Blocking Subtitle Code** terms.

## Acceptance Criteria
- [ ] CI green on the PR; `npm run build` passes locally in the worktree.
- [ ] `verify:subtitle-audio-sync`, `verify:transcribe-alignment`, `verify:provider-subtitle-alignment`, `verify:export-gallery-metadata`, `verify:mcp-perfect`, `verify:video-job-watchdog`, `verify:editor-job-runtime`, `verify:caption-card-editing` all green.
- [ ] Harness replay of the 08-28→08-30 failure shapes (unverified_alignment, text_mismatch on export, legacy_caption_projection_failed, transcribe_incomplete, missing TTS timing) all complete instead of failing (cases A–H in Task 2, Task 4 fixtures).
- [ ] Zero Gemini TTS regeneration calls on the subtitle path; ≤1 transcribe call per job.
- [ ] 48 h after deploy (measured with `/private/tmp/heroai-prod-measure.sh`): create fail ≤15%, export fail ≤3%, none of the listed codes, no bare generic error, `captions` rows present in section E.

## Out of scope
- Making Gemini captions *more accurate* than the 08-27 baseline (phase 2 — needs a real word-timing source; see `docs/research/2026-08-30-thai-forced-alignment-options.md`).
- Story-film (internal) pipeline — untouched.
- Render-worker bundle TOCTOU across two instances, `sweepDeadRenderJobs` only on idle — logged in the audit, not fixed here.
- Removing the 08-27→08-30 fuzzy/numeric alignment code — it stays as the evidence collector.

## Status
interviewed 2026-08-30 | approved: 2026-08-30 (Mew: "พักไว้เพื่อ execute session หน้า") | executed: deferred — resume with `/mew-kickoff execute docs/plans/2026-08-30-subtitle-shadow-mode-hotfix.md` in worktree `AI_content_Mew_social-subtitle-render-stability-audit` (branch `subtitle-render-stability-audit`, node_modules + .env ready) | delivered: -
