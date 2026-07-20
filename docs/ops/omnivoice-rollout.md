# OmniVoice rollout and rollback runbook

## Safety invariants

- Production video rendering stays on the application host.
- Worker port `8000` binds to loopback only; external traffic enters through HTTPS.
- Worker API key is present only in root-readable runtime environment files. Commands, logs, screenshots, and this runbook must never print it.
- Public `/health` and `/ready` endpoints expose liveness only. Voice catalog and synthesis endpoints require the worker API key; interactive docs stay disabled.
- An empty `OMNIVOICE_ALLOWED_USER_IDS` denies everyone. Broad access requires the explicit value `*`.
- Gemini and ElevenLabs are the operational fallback; OmniVoice synthesis POSTs are never retried automatically.

## Application configuration

Use the secret manager or the production host's protected `.env`; do not commit values.

```dotenv
# Initial dark deploy
NEXT_PUBLIC_OMNIVOICE_ENABLED=0
OMNIVOICE_ENABLED=0

# Required before canary
OMNIVOICE_URL=https://omnivoice.srv1497862.hstgr.cloud
OMNIVOICE_API_KEY=<secret>
OMNIVOICE_ALLOWED_USER_IDS=<comma-separated database User.id values>
OMNIVOICE_NUM_STEP=4
OMNIVOICE_MAX_SCRIPT_CHARS=500
OMNIVOICE_REQUEST_BUDGET_MS=240000
```

`NEXT_PUBLIC_OMNIVOICE_ENABLED` is compiled into the client and needs a rebuild. The runtime switch and allowlist are also enforced by every server route.
The app caps three in-flight synthesis requests per process, matching the worker's one-active/two-pending envelope; excess calls receive `429`.

## Phase 0 — dark deploy

1. Confirm the worker health/readiness checks pass, direct port `8000` is unreachable externally, and the production host IP is in the proxy allowlist.
2. Deploy the integration commit with both feature flags `0`.
3. Run the app smoke test using Gemini and ElevenLabs. Confirm no OmniVoice option is rendered and normal job telemetry/error rates are unchanged.
4. Keep this state for at least one normal production render window. Any regression here is caused by integration code, not worker traffic; roll back the app commit.

## Phase 1 — internal canary

1. Set the worker URL/key and one or more internal database `User.id` values. Never start with `*`.
2. Set both flags to `1`, rebuild, and restart the application with updated environment.
3. Verify an account outside the allowlist sees only Gemini and ElevenLabs.
4. Verify an allowed account can list voices, preview a voice, create a short OmniVoice job, edit captions, and complete video export.
5. Verify scripts over the configured ceiling fail before a job is queued and a fourth simultaneous worker request receives `429` rather than exhausting the host.
6. Human-review four-step Thai audio quality before adding more users.

## Phase 2 — gradual expansion

Add small batches of user IDs. During each batch monitor:

- worker health, restart count, memory/swap, disk, queue rejections, and generation latency;
- application `omnivoice_tts`, TTS failure, degraded-timing, render failure, and minute-reservation events;
- Gemini and ElevenLabs success/error rates to prove the existing paths remain stable.

The 500-character ceiling is a canary usability increase from the original 300-character
limit. Monitor synthesis latency and queue rejection after the change; restore 300 if the
request budget or one-active/two-pending worker envelope becomes unstable.

Do not use `*` until capacity and audio quality are accepted. KVM2 remains restricted to audio rendering and short scripts.

## Fast rollback

1. Set `OMNIVOICE_ENABLED=0` and restart the application with updated environment. Server calls fail closed immediately; Gemini and ElevenLabs remain available.
2. Set `NEXT_PUBLIC_OMNIVOICE_ENABLED=0`, rebuild, and restart to remove the UI option.
3. Existing OmniVoice jobs may fail with the provider-disabled message; do not silently rerun them with another provider because that changes the requested output. Ask the user to choose Gemini or ElevenLabs and create a new job.
4. If only the worker release is faulty, keep the application disabled and restore the pinned pre-hardening worker image/compose from `/var/backups/omnivoice/20260720-prehardening` after validating the exact target.

## Go/no-go checklist

- `npx tsc --noEmit`
- `npm run verify:omnivoice`
- `npm run verify:subtitle-invariant`
- `npm run verify:mcp-parity`
- `npm run verify:editor-projects`
- `npm run verify:project-menu`
- production build with both flags `0`
- worker auth/input/queue/load checks
- dark-deploy Gemini and ElevenLabs smoke tests
- allowlisted OmniVoice preview and end-to-end video export
- human approval of four-step audio quality
