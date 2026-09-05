# Gemini acoustic caption timing

Approved by Mew on 2026-09-05 after the cross-account subtitle audit. Objective: captions follow Gemini speech while admitted render/export jobs remain reliable. Headline hiding and music selection are intentional and unchanged. Upload transcription is a later adoption cohort, not silently routed through a Thai-only TTS model.

## Evidence and delivery sequence

Production audit: 30/86 original Gemini creates on Sep 1–5 used approximate clocks. Two new account samples contain approximately 1.5–5 s late source captions; another successfully aligned sample contains a roughly 0.5 s early boundary. No user edit created those source times. PR #425's fail-open policy stays in force.

This branch must deliver a measured Thai CTC timing engine, a bounded local execution/cache boundary, source-preserving partial-clock projection, opt-in orchestration integration, and a reproducible benchmark/release report. The default remains off until the acoustic reference and production-load criteria below pass. A successful build is not authorization to activate or deploy. Existing-clip repair UX and upload adoption follow only after the Gemini clock qualifies; no saved customer edit is rewritten by this branch.

## Contract

- Align the actual generated Gemini WAV against its exact narration text. Keep original UTF-16 source offsets; never replace display text with recognition output.
- Retain trustworthy acoustic word boundaries even when unsupported/uncertain spans exist. Bound uncertain spans by surrounding acoustic anchors, record their range, and use phrase cards over those spans instead of pretending word timing is verified.
- Report per-span provenance and confidence. Partial clocks remain warning-quality, not `passed` acoustic coverage. Confidence is a model signal, not a measured error in milliseconds.
- One bounded local attempt, no provider spend, no TTS regeneration, no extra remote transcription retry. Python runs outside the JS renderer with bounded concurrency/threads, timeout termination, and preinstalled pinned weights; no runtime model download.
- Cache by audio content, exact text, model revision and algorithm version. Cache contents contain numeric timing and hashes, not scripts or audio. No raw text/media/errors in logs or telemetry.
- Off preserves current behavior. Shadow records evidence without changing rendered timings. Apply is explicitly opted in after qualification. Local failure never blocks a clip or replaces a successful legacy result with an unverified clock.
- Preview persists the chosen words/captions and evidence. Export keeps that version and never silently re-aligns a creator's edits.

## Qualification

Use 30–50 distinct real clips from multiple accounts and length buckets, covering Thai/English, numbers, pauses and failure examples; compare against a held-out, human-reviewed acoustic reference. Offline ASR is a screening reference, not ground truth. Proposed release targets: >=95% of evaluated boundaries within 250 ms and >=99% within 500 ms; no >1 s outlier in the known regressions. Include render-frame offsets and audio mux offsets in final-export checks. Do not claim these targets from model confidence or a non-random diagnostic sample.

After a qualified branch, shadow first, then staged application with independent completion, latency, fallback and acoustic-quality monitoring. Target >=99% completion for admitted jobs; report cancellations/admission failures separately and retain all operational failure causes. Measure cold/warm latency, RSS and concurrent renderer impact on the actual deployment hardware before activation. Roll back via the mode flag; existing project clocks remain intact.

Candidate model: airesearch/wav2vec2-large-xlsr-53-th, pinned revision 3155938c549b23eee16b1d4b55dcb161b7fe4bcf (CC-BY-SA-4.0). Its ASR evaluation is not an alignment-accuracy qualification. Do not use the ctc-forced-aligner's default noncommercial MMS weights in production.
