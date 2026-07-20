# OmniVoice integration specification — 2026-07-20

## Goal

Add the team's self-hosted OmniVoice provider to the existing video-editor voice flow while preserving the production behavior of Gemini and ElevenLabs. The OmniVoice KVM2 host renders audio only; video rendering remains on the production application host.

## Requirements

- **S1 — Isolated scope:** Port only OmniVoice work from `dev_waow`. Do not merge the obsolete Mobile Shop/responsive-editor work or replace current `main` implementations.
- **S2 — Existing-provider safety:** With OmniVoice flags off, Gemini and ElevenLabs UI, API routing, timing recovery, quota handling, and video rendering must behave as before.
- **S3 — Separate audio worker:** The production app must call the dedicated OmniVoice host over authenticated HTTPS. The worker must not render video and direct public access to its application port must remain blocked.
- **S4 — Controlled rollout:** OmniVoice must have independent UI and server kill switches, fail-closed per-user canary access, readiness gating, and a documented rollback that does not require reverting Gemini or ElevenLabs.
- **S5 — Capacity protection:** The app and worker must bound input, request time, memory, CPU, process count, logs, and concurrent/pending synthesis. App calls must not automatically retry synthesis POSTs.
- **S6 — Pipeline parity:** OmniVoice audio must feed the existing TTS timing/caption recovery, preview, draft persistence, video-job orchestration, telemetry, and minute-quota paths without changing the main video renderer.
- **S7 — Verification:** TypeScript, a production build with OmniVoice disabled, OmniVoice contract checks, existing subtitle/MCP/editor regressions, worker auth/input/load checks, and a canary end-to-end render must pass before wider enablement.

## Non-goals

- Realtime conversational/streaming audio.
- Video rendering on the OmniVoice KVM2 host.
- Mobile Shop or historic responsive-editor changes from `dev_waow`.
- Replacing Gemini or ElevenLabs, automatic provider fallback, or migrating saved user defaults globally.

## Launch decision

The KVM2 CPU benchmark makes OmniVoice suitable only for short scripts at four inference steps. The original canary ceiling was 300 characters; it was raised to 500 characters on 2026-07-20 to improve usability while retaining one active synthesis plus two pending requests and a per-request budget below the app route's 300-second ceiling. The rollout must monitor synthesis latency and queue rejection and restore the 300-character ceiling if the worker becomes unstable. Quality of the four-step output must be approved by a human during canary before broad access.
