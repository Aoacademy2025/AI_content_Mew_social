# Hero Voice clone Task 6 gate readback

Date: 2026-09-04 (final image evidence refreshed 2026-09-05)
Branch: `mewic/hero-voice-clone-prod-audit`
Decision: **NO-GO — paid submission and staging mutation remain disabled**

## Verified locally

- Tasks 1–5 focused verification passed. The clone worker passed 57/57 Python tests plus static/AST/JSON/shell checks.
- Task 4 deletion/upload crash matrices and Task 5 review-preparation/publication/artifact crash recovery passed.
- Prisma validate/generate, a fresh schema push, and all 20 migrations passed on throwaway SQLite databases.
- TypeScript, focused changed-scope ESLint, production build (184/184 pages), client source-map/private-sentinel scan, sensitive-audio status scan, and `git diff --check` passed.
- The final private candidate image was built from commit `2abeebf8a0daad82f1484aebb7f64646e0c21b9e`. Registry readback fixed OCI index `sha256:c40fa76893fe1e0deab29fd8664d6ec32999496e57ce7b08becf5aba7edd7abc` and Linux/amd64 manifest `sha256:5b46143871655d4613b2ed5dff0cd414aba9d8994abbf2918addea00b99adffd`.
- The authenticated OCI verifier passed the complete final image: every descriptor, size, digest, diff ID, tar stream, layer and merged filesystem; secret/key/audio/catalog/Git/cache absence; exact source/runtime/model manifests; all 12 model files; patched package metadata; and build attestation.
- Registry attestations were independently downloaded and checked. The 4,362,831-byte SPDX in-toto statement is `sha256:2a35cfa2a3348044bf139c51ebe5d163675ed62ccf72752dc8482c36831729e9`; the 70,250-byte SLSA provenance statement is `sha256:7904f56f6c95343f1752e1a4df960f118f9fd5ab869293f68eee684a0d85ff21`. Both subjects are the exact Linux/amd64 manifest above. Provenance also binds build commit `2abeebf8a0daad82f1484aebb7f64646e0c21b9e`, builder run `33901610331`, and base digest `sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee`.
- The 44-slot runner remains dry/evidence-gated. Tests use synthetic WAVs, fake provider transport, throwaway private storage, and offline Git authorities only.
- The named private GHCR image and feature branch were intentionally created. No RunPod endpoint/template/job/queue, production endpoint, Hostinger/PM2 state, DNS, deployed file, billing system, or real audio was mutated.

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

1. No Docker, Podman, Colima, or Lima runtime is installed. The candidate was built in pinned GitHub CI and fully inspected as an authenticated OCI layout locally, but its network-blocked cold import/model load and real GPU execution cannot run here. The canonical non-emulated Linux/arm64 evaluator also remains unavailable.
2. The evaluator lock is intentionally blocked on the authoritative arm64 base digest, fully hashed transitive wheel closure, FFmpeg package/build/binary identity, and non-emulated runtime attestation.
3. Control now preserves the audited-v13 preprocessing boundary, and Demucs has a hash-pinned metadata-only torchaudio compatibility patch. The immutable image is fully filesystem-verified, but offline model load, real GPU/audio parity, and enhancement fixtures remain required before paid execution.
4. No Task 6 evidence key/digest, objective/review keys, exact test Clerk issuer/audience/two-session attestation, GitHub repository-node/askpass credentials, or RunPod restricted credential is present in the current process.
5. The [license gate](./2026-09-04-hero-voice-clone-license-gate.md) is NO-GO for candidate execution, public distribution, customer use, or commercial use. The final direct Trivy scan of the authenticated OCI found zero critical and zero high vulnerabilities after the pinned runtime/tooling remediation; it found 151 medium and 57 low vulnerabilities. Package-level license review remains open, including 300 observations that Trivy classifies as high-severity restricted-license findings. Those are license classifications, not CVEs, and are not legal clearance. The private registry artifact exists for gated inspection only.
6. The [RunPod payload-retention audit](./2026-09-04-runpod-serverless-payload-retention.md) remains NO-GO for sending a real person's reference until a binding DPA/legal basis and written input/history/log/backup deletion plus data-center answers exist.
7. No immutable GPU rate, 660-second billing/forced-park proof, bounded non-GPU reserve evidence, staging endpoint/template readback, capacity proof, or final whole-branch independent review exists. The private candidate OCI digest, digest-bound SPDX SBOM, SLSA provenance, and full filesystem scan now exist; no template references the image yet.
8. The supplied private Google Drive folder and legacy pointer were read without changing sharing. The downloaded source matched the out-of-band SHA-256, duration, format, and approved transcript; it was converted locally to the exact 10.000-second mono 24 kHz PCM16 canary WAV. The canonical exact-JCS pointer and WAV are owner-only, Git-ignored/outside the checkout, and the temporary download was removed. No human audio has been sent to RunPod.

## Scope and branch update

Mew subsequently authorized a private, non-commercial personal evaluation and
the private report records the bounded purpose/consent. The initial remote
fetch proved the worktree base equaled `origin/main` at
`8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb`. `origin/main` later advanced
through unrelated video and observability changes. The latest main was fetched
and merged cleanly after each advance, with no overlap in canary or Hero Voice
paths. The final candidate therefore records source revision
`8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb` and current application base
revision `a6fd30ce00005e4c8177bf0e36cba552ae430ae7` separately. No team voice branch
was merged. These facts clear the owner-scope and branch-provenance questions
only. They do not clear provider retention, candidate runtime, immutable
staging, cost, credential, or review evidence.

The source check also established the separate voice authority:
`Aoacademy2025/Hero-Voice-Ai` has only/default branch `main` at
`f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37`. The candidate manifest now pins
that exact team revision plus the four selected enhancement/normalization/
ranking/watermark provenance files. The hardened clone-only implementation is
still used instead of merging the upstream FastAPI, stock/Lao, storage, or
fail-open surfaces.

## Immutable candidate image readback

- Feature commit: `2abeebf8a0daad82f1484aebb7f64646e0c21b9e`
- GitHub Actions CI run: `33901613626` (`success`)
- GitHub Actions image/attestation run: `33901610331` (`success`)
- Feature-branch PR: [#440](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/440) (`OPEN`, unmerged, `NO-GO` recorded)
- Private image tag: `ghcr.io/mewic/heroai-omnivoice-clone:2abeebf8a0daad82f1484aebb7f64646e0c21b9e`
- OCI index: `sha256:c40fa76893fe1e0deab29fd8664d6ec32999496e57ce7b08becf5aba7edd7abc`
- Linux/amd64 manifest: `sha256:5b46143871655d4613b2ed5dff0cd414aba9d8994abbf2918addea00b99adffd`
- Attestation manifest: `sha256:acd675a4627d427bda426dd6588b818d21f1ec18799d85167303027c70b22db6`
- SPDX statement: `sha256:2a35cfa2a3348044bf139c51ebe5d163675ed62ccf72752dc8482c36831729e9`
- SLSA provenance statement: `sha256:7904f56f6c95343f1752e1a4df960f118f9fd5ab869293f68eee684a0d85ff21`
- Full authenticated OCI verification: `PASS`
- Final Trivy vulnerability scan: `PASS` for the zero-unresolved-critical/high gate (Critical 0, High 0, Medium 151, Low 57); raw owner-only report SHA-256 `8707313c9a1867ebb9af13946c490010271815e28f691b550a77f4f303e0017d`

This clears the build/publish, manifest capture, SBOM/provenance capture, and
filesystem/layer-scan portion of Task 6 only. The plan checkbox remains open
because no dedicated candidate template has been created or read back by
digest, and cold-import/GPU evidence is still absent.

## Consequence

No Task 6 evidence bundle may be signed, no `--apply` command may pass, and Task
7 must not start. The next authorized work requires external evidence and
credentials: resolve runtime/parity/licenses, execute the DPA and consent gates,
freeze rate/cost, provision two isolated staging endpoints only after those
gates permit it, read every binding back, and complete a final independent
branch review. Only then may the 44-slot paid canary be considered.
