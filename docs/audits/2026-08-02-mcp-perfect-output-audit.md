# MCP perfect-output audit — 2026-08-02

## Objective and scope

The target is a Pro/Business user prompting through Claude Code, Codex, or another MCP client and receiving a production-usable video without opening the web editor. Admin-only features are intentionally out of scope.

A job may be reported as `done` only when:

1. the exact final subtitles that will be burned preserve the authored text, numbers, punctuation, spacing inside each card, Thai grapheme boundaries, and a valid non-overlapping audio timeline;
2. the final render completes;
3. exactly one minute/credit/legacy-clip charge remains active and settled; and
4. the MCP status response exposes evidence for both subtitle QA and billing.

## Production snapshot before remediation

30-day MCP activity contained 174 video jobs: 165 completed (94.8%), with 86 Gemini and 88 ElevenLabs jobs.

- 106 persisted final burn payloads had no structural text, timing, Thai grapheme, or spacing anomalies detectable from their stored render data.
- Eight Gemini jobs between 2026-07-17 and 2026-07-20 entered a degraded timing path; five were delivered. Since 2026-07-21, the inspected Gemini window was 22/22 without that marker.
- Five normal credit-funded jobs spent 10 credits in total. The expected formula and persisted ledger matched, with no duplicate charge rows in the inspected set.
- A critical avatar billing defect was confirmed: the base reservation could be refunded even though the composite and burn were both treated as already paid. A successful avatar job could therefore finish with a net-zero charge. One fully persisted production example was found on 2026-07-28.
- MCP used the same underlying TTS/avatar/render routes as the web path, but `create_video_job` did not expose the Gemini voice selector even though the worker supported it.

The production snapshot supports operational and structural conclusions. It does not by itself certify subjective naturalness of every voice or visual quality of every avatar; that requires listening/watching a controlled post-deploy sample.

## Remediation implemented

### Subtitle and timing release gate

- Removed the MCP single-segment proportional timing fallback for final output.
- Missing or unusable provider timing now calls the production audio transcription/alignment path.
- Added a provider-independent QA gate over the exact captions passed to the burn render.
- The gate fails before rendering/delivery on missing or changed text/numbers, internal spacing loss, invalid/overlapping/out-of-audio timing, broken Thai combining-mark boundaries, punctuation-only cards, or cards shorter than the safe duration.
- Avatar checkpoints persist the timing source and re-run the same QA after provider resume, before the final burn.
- Preview and final outputs retain the QA receipt.

### Exact billing lifecycle

- Successful avatar jobs retain the base render as their one charge. The composite paid marker keeps the burn free; the base is no longer refunded on success.
- Terminal failure settlement still refunds the retained reservation once through the existing idempotent settlement paths.
- A billing receipt is derived from authoritative `RenderJob` reservations. Missing charges, multiple active charges, or an unsettled charge fail closed before delivery.
- Minute-funded, credit-funded, and legacy clip-funded receipts are distinguished. Credit conversion uses the shared production credit-cost function.

### MCP contract and observability

- `create_video_job` now accepts a validated `geminiVoiceName` from the production Gemini voice catalog.
- `get_video_status` now returns `subtitleQa` and `billingReceipt` for completed jobs, while retaining user ownership checks.
- Added `npm run verify:mcp-perfect` as a repeatable release gate.

## Verification evidence

- `npm run verify:mcp-perfect`: passed. Covers Gemini voice schema, forced-alignment fail-closed behavior, exact text/number/spacing/timeline checks, billing receipts, normal jobs, and avatar provider resume.
- MCP orchestrator integration: 37/37 checks passed.
- VideoJob lifecycle/parser: 51/51 checks passed.
- MCP tool ownership/status: 17/17 checks passed.
- Accounting: billing receipt 4/4, minute-credit 9/9, credit-overflow 52/52, and render reservation settlement all passed.
- Subtitle regression suites and MCP/web cadence parity passed.
- `npx tsc --noEmit`: passed.
- Production build: passed and generated all 157 static pages. The build emitted the repository's existing missing-`DATABASE_URL` warning during static collection because no build-time database URL was supplied; exit status was 0.

## Verdict

The remediated branch meets the enforceable part of “prompt and get a real job”: it no longer calls a final MCP job successful unless the final subtitle payload and single settled charge can be proven. Normal and resumed-avatar paths are covered.

This is code-complete but not yet deployed. It should not be described as production-certified until a controlled canary has rendered and humans have watched/listened to the output. External TTS, stock, and avatar providers remain nondeterministic; the system's guarantee is fail-closed delivery, not that an external provider can never fail.

Recommended production acceptance after deploy:

1. Run at least five Thai prompts spanning Gemini, ElevenLabs, sentence subtitles, 1–2 word subtitles, and avatar resume.
2. Watch every output end-to-end and listen for pronunciation, pauses, clipping, avatar lip-sync, composite edges, and subtitle/audio sync.
3. Confirm every completed job reports `subtitleQa.status = passed` and `billingReceipt.status = settled` with one active charge.
4. Monitor failure rate, forced-alignment usage, QA rejection codes, and billing-receipt rejection codes during the canary window before broad release.
