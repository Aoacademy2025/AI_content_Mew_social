# Hero Voice clone Task 6 gate readback

Date: 2026-09-04
Branch: `mewic/hero-voice-clone-prod-audit`
Decision: **NO-GO — paid submission and staging mutation remain disabled**

## Verified locally

- Tasks 1–5 focused verification passed. Task 3 passed 49/49 Python tests plus static/AST/JSON/shell checks.
- Task 4 deletion/upload crash matrices and Task 5 review-preparation/publication/artifact crash recovery passed.
- Prisma validate/generate, a fresh schema push, and all 20 migrations passed on throwaway SQLite databases.
- TypeScript, focused changed-scope ESLint, production build (184/184 pages), client source-map/private-sentinel scan, sensitive-audio status scan, and `git diff --check` passed.
- The 44-slot runner remains dry/evidence-gated. Tests use synthetic WAVs, fake provider transport, throwaway private storage, and offline Git authorities only.
- No production endpoint, Hostinger/PM2 state, DNS, deployed file, provider queue, registry image, GitHub ref, billing system, or real audio was mutated.

## Data inventory

| Boundary | Fields | Classification and handling |
|---|---|---|
| Browser before reveal | Opaque run/pair/audio tokens, revision, score choice, side-specific flag enums | Private authenticated UI; no arm, endpoint, provider job, slot, filename, path, transcript, or digest. `private, no-store`; owner mismatch is 404. |
| Local SQLite | Immutable manifest/identity digests, ledger records, provider IDs, bounded timing/cost, nonce state, review ciphertext/score HMAC, deletion intents | Marked canary SQLite only, mode `0600`, same-root Task 4 coordinator. No reference or generated audio bytes. |
| Local private files | Mew reference, generated WAVs, reveal envelope, evaluator inputs/results | Owner-only roots (`0700` directories, `0600` files), no-follow/inode checks, outside public/Git; recoverable deletion. |
| Provider request if later authorized | Base64 reference WAV, exact reference transcript, exact final speech text, speed, step count, seed, profile, request/settings commitments | Human voice and text leave the Mac. This is prohibited until the DPA/legal/retention/data-center gate passes. |
| Provider response if later authorized | Generated WAV, exact v3 worker/image/source/model/stage/profile identities, commitment echoes, sanitized timing | Validated before local settlement; payload is never logged. Provider retention remains independently governed and is not equated with local deletion. |
| Application logs | Opaque job/run identifiers, enum outcome/profile, bounded duration/timing | No audio, base64, transcript, email, auth subject, path, filename, reveal mapping, raw score, token, or secret. |
| Git commitment if later authorized | Exact JCS object containing only version, experiment ID, and reveal-ciphertext SHA-256 | No ciphertext, audio, score, mapping, identity, or personal data. Exact commit/blob/path bytes are read back. |
| Sanitized report | Counts, pass/fail states, immutable public component identities, bounded cost/latency aggregates | No raw audio, private pointer, reference hash, provider credential, auth session, reveal mapping, or raw score. |

## Hard blockers observed

1. No Docker, Podman, Colima, or Lima runtime is installed. The candidate OCI image and canonical non-emulated Linux/arm64 evaluator cannot be built or executed here.
2. The evaluator lock is intentionally blocked on the authoritative arm64 base digest, fully hashed transitive wheel closure, FFmpeg package/build/binary identity, and non-emulated runtime attestation.
3. Control now preserves the audited-v13 preprocessing boundary, and Demucs has a hash-pinned metadata-only torchaudio compatibility patch. Neither is runtime-proven yet: the immutable image, offline model load, real GPU/audio parity, and enhancement fixtures remain required before paid execution.
4. No Task 6 evidence key/digest, objective/review keys, exact test Clerk issuer/audience/two-session attestation, GitHub repository-node/askpass credentials, or RunPod restricted credential is present in the current process.
5. The [license gate](./2026-09-04-hero-voice-clone-license-gate.md) is NO-GO for candidate-image publication/use.
6. The [RunPod payload-retention audit](./2026-09-04-runpod-serverless-payload-retention.md) remains NO-GO for sending a real person's reference until a binding DPA/legal basis and written input/history/log/backup deletion plus data-center answers exist.
7. No immutable GPU rate, 660-second billing/forced-park proof, bounded non-GPU reserve evidence, built OCI digest, staging endpoint/template readback, capacity proof, or final whole-branch independent review exists.
8. The supplied private Google Drive folder and legacy pointer were read without changing sharing. The downloaded source matched the out-of-band SHA-256, duration, format, and approved transcript; it was converted locally to the exact 10.000-second mono 24 kHz PCM16 canary WAV. The canonical exact-JCS pointer and WAV are owner-only, Git-ignored/outside the checkout, and the temporary download was removed. No human audio has been sent to RunPod.

## Scope and branch update

Mew subsequently authorized a private, non-commercial personal evaluation and
the private report records the bounded purpose/consent. A fresh remote fetch
also proved the worktree base equals the latest `origin/main` exactly at
`8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb` (divergence `0 0`); no team voice
branch was merged. These two facts clear the owner-scope and branch-provenance
questions only. They do not clear provider retention, candidate runtime,
immutable staging, cost, credential, or review evidence.

The source check also established the separate voice authority:
`Aoacademy2025/Hero-Voice-Ai` has only/default branch `main` at
`f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37`. The candidate manifest now pins
that exact team revision plus the four selected enhancement/normalization/
ranking/watermark provenance files. The hardened clone-only implementation is
still used instead of merging the upstream FastAPI, stock/Lao, storage, or
fail-open surfaces.

## Consequence

No Task 6 evidence bundle may be signed, no `--apply` command may pass, and Task
7 must not start. The next authorized work requires external evidence and
credentials: resolve runtime/parity/licenses, execute the DPA and consent gates,
freeze rate/cost, build and scan the immutable image, provision two isolated
staging endpoints, read every binding back, and complete a final independent
branch review. Only then may the 44-slot paid canary be considered.
