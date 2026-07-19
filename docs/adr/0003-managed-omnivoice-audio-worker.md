# ADR 0003: Managed OmniVoice audio worker

- Status: Proposed for canary
- Date: 2026-07-20

## Context

The existing product uses user-owned Gemini and ElevenLabs keys. OmniVoice is different: it is a model and worker operated by the HERO AI team on a separate KVM2 server. Users cannot supply an equivalent provider key, and the production app needs a server credential to authenticate to that private service.

Merging the historical feature branch wholesale would also merge unrelated editor work and discard newer stability changes on `main`.

## Decision

Treat OmniVoice as a narrowly scoped managed platform service and an explicit exception to the general BYOK rule:

- Keep Gemini and ElevenLabs unchanged and selectable.
- Port OmniVoice manually onto current `main`; do not merge `dev_waow` wholesale.
- Keep the worker audio-only. The existing production render pipeline remains authoritative for video.
- Store the worker credential only in root-readable runtime environments. Never expose it to the browser, repository, image, URL, or logs.
- Authenticate app-to-worker requests over HTTPS and restrict the worker proxy to approved source IPs.
- Require both build-time UI enablement and runtime server enablement, plus a fail-closed account allowlist and a live readiness check.
- Do not retry synthesis POSTs automatically because a timed-out request may still consume CPU and complete upstream.
- Enforce a short-script ceiling and existing product minute quota. Protect the KVM2 worker with admission control and resource limits.

## Consequences

OmniVoice can be disabled independently without changing existing providers. It consumes platform compute rather than a user's provider quota, so its capacity and cost need separate telemetry and operational review. The current KVM2 performance means this is initially a canary feature for short scripts, not a general replacement for Gemini or ElevenLabs.
