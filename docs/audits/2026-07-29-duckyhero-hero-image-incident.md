# DuckyHero Hero AI Image incident audit

Date: 2026-07-29 (Asia/Bangkok)  
Affected account: `duckyhero@gmail.com`  
Scope: internal/admin Hero AI Image beta only

## Executive finding

The account, prompt, and production RunPod API key were not the cause. RunPod's public
`z-image-turbo` endpoint accepted jobs and then failed inside its own nested WaveSpeed
submission with HTTP 401 (`Invalid API key`). A direct production-key smoke reproduced
the same provider failure, while the RunPod account API continued to return HTTP 200.

A separate first-run failure exposed an application reliability gap: one provider image
completed but the app's single 30-second download attempt timed out. The remaining 26
scenes settled successfully, but the failed video still retained their 52-credit charge.

Production recovery testing found three additional independent defects before the route
was accepted:

- the custom Comfy workflow appended negative concept nouns such as `collage`, `grid`,
  and `contact sheet` to Z-Image's only positive conditioning, causing two production
  E2E images to render as multi-panel contact sheets
- the environment file had been switched to `custom`, but PM2 still held `disabled`;
  CLI readiness passed while the running application correctly failed closed
- the replacement voice and image endpoints initially allowed only 3 GPU types each;
  cold jobs exhausted their bounded queue waits without receiving a worker

## Incident evidence

All times below are Asia/Bangkok.

| Video job | Window | Result | Evidence | Credit outcome before remediation |
| --- | --- | --- | --- | ---: |
| `cms69pklr0079lc85w6gzblx7` | 22:57–23:02 | failed after 26/27 images | scene 17 `OUTPUT_INVALID`; provider job was `COMPLETED`, app download timed out | 52 credits remained charged |
| `cms6adzhk00djlc858uce3rph` | 23:16–23:18 | all 27 images failed | nested WaveSpeed HTTP 401 in every provider error | all 54 credits refunded |

The public endpoint's last observed successful Z-Image completion was 23:01:56. Its first
WaveSpeed 401 in this incident was 23:17:48. The application process and environment did
not restart or change between those points.

Direct provider reproduction:

- endpoint: RunPod public `z-image-turbo`
- provider job: `sync-110d7c4e-1ecb-4af7-8433-49d22657cb0c-e2`
- RunPod API response: HTTP 200 with terminal `FAILED`
- terminal cause: WaveSpeed HTTP 401 invalid API key
- reported provider cost: none

This proves the failing credential belonged to the public endpoint's nested provider
integration, not the Hero AI production RunPod credential.

The evidence report was sent from the account owner mailbox to `help@runpod.io`, with
`support@wavespeed.ai` copied, under subject “RunPod public z-image-turbo accepted jobs
but failed on nested WaveSpeed 401”. RunPod assigned ticket `#44090`. The ticket was
updated with the custom-worker allocation evidence. No API key or secret was included.

The first custom recovery endpoint then exposed a second independent root cause. Its
stored GHCR credential could no longer authenticate:

- GitHub `/user`: HTTP 401 `Bad credentials`
- GHCR repository pull-scope exchange: HTTP 403 `DENIED`
- a fresh endpoint bound to that credential allocated a worker immediately, but the
  worker became unhealthy before the handler initialized
- the replacement credential returned HTTP 200 for the exact image manifest digest
  `sha256:79b55eb182e41a255d71d6dd2602d6e4aa5b259b5e94d76dec7705b46ee05618`,
  after which the worker changed to `initializing` and completed normally

The public WaveSpeed 401 caused the user incident. The expired private-registry credential
was a separate recovery-path defect that would have prevented a safe custom failover.

## Permanent remediation

Hero Video is now fail-closed on the isolated custom endpoint
`e10knh9zjtr2pl` (`heroai-z-image-turbo-production-v3`). It does not fall back to KIE
or another AI engine.

Application changes:

1. Pin Hero Video job creation and generation to `runpod-custom`; an accidental public
   route rollback returns 503 before credits are reserved.
   The public Z-Image route is also quarantined for direct Studio use unless the separate
   `AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED=1` recovery flag is deliberately enabled.
2. Give the custom route its own 3-credit quote. At the conservative USD 0.05 estimate,
   it fits the existing 30% gross-margin cost guard; the previous 2-credit quote did not.
3. Classify systemic provider failures, stop after at most the first three-scene
   concurrency wave, and open a ten-minute circuit breaker.
   A custom-worker queue timeout cancels the exact durable RunPod job and refunds it
   before stopping the remaining scenes; an unconfirmed cancellation is retained for
   reconciliation rather than unsafely refunded.
4. Refund every already-settled image in a video batch when any missing scene makes the
   video unusable. Exact granted/purchased buckets are restored transactionally and the
   operation is idempotent.
5. Retry temporary RunPod image downloads twice within a bounded 100-second wall-clock
   budget instead of failing after one 30-second attempt.
6. Make readiness output explicitly distinguish configuration validation from the
   required live provider smoke.
7. Bound a completely fresh custom-worker wait at 14 minutes (15-minute hard maximum),
   then cancel and refund the exact durable job. The verified 28 GB image needed about
   ten minutes for a fresh pull, while FlashBoot revivals completed in seconds.
8. Add `npm run check:ghcr-pull-token`, which validates both GitHub credential validity
   and the exact GHCR manifest pull scope without printing the credential.
9. Keep Z-Image's CFG=1 workflow positive-only. Negative concept nouns are no longer
   concatenated into `CLIPTextEncode`; readiness rejects any future
   `{{NEGATIVE_PROMPT}}` injection into this workflow.
10. Express the Hero scene framing entirely as affirmative single-view language. The
    positive prompt contains no `collage`, `grid`, `panel`, `contact sheet`, `mockup`,
    or `layout` trigger noun.
11. Add dry-run-by-default, endpoint-identity-checked capacity tools. They refuse to
    mutate an endpoint unless scale-to-zero, `workersMax=1`, and FlashBoot remain true,
    and verify the template ID and complete GPU pool after the PATCH.
12. Make the route configurator optionally restart both PM2 consumers with the newly
    parsed environment and verify every managed value from PM2 after restart. This closes
    the file-versus-running-process configuration drift found by the E2E gate.

RunPod capacity changes:

- superseded voice v9 staging endpoint `k69fz253b59st4`: `workersMax 1 → 0`
- original Z-Image endpoint `0c6eadcsuhuhor`: parked at `workersMin=0`,
  `workersMax=0` after a never-started smoke was cancelled with `cost=null`
- replacement endpoint `z6rultw0btxy3n`: parked at `0/0` after it proved the expired
  registry credential by allocating an unhealthy worker
- production candidate `e10knh9zjtr2pl`: `workersMin=0`, `workersMax=1`, FlashBoot
- Z-Image fallback pool: 3 → 10 NVIDIA GPU types, all with at least 48 GB VRAM:
  `A40 / RTX A6000 / L40 / RTX 6000 Ada / L40S / A100 PCIe / A100 SXM /
  H100 PCIe / H100 SXM / H100 NVL`. A two-scene production E2E subsequently received
  workers in 12,421 ms and 24,543 ms instead of timing out after 14 minutes.
- superseded OmniVoice v1 endpoint `xbn9a1ynd6byeu`: `workersMax 1 → 0`
- former production voice endpoint `txvrmtzfc8au3b`: its template used the same expired
  registry credential; the never-started production-smoke job was cancelled with
  `cost=null`
- auth-fixed production voice endpoint `0t5ta1alo5nzqo`: valid 24 kHz mono PCM WAV,
  102 ms queue delay, 3,947 ms execution, `workersMin=0`, `workersMax=1`
- OmniVoice fallback pool: 3 → 9 previously validated GPU types. The first three-type
  production E2E timed out in queue after 14 minutes; after expansion, the next cold
  voice completed and the pipeline advanced in about 40 seconds

The worker-quota mutations passed the zero queued/in-progress precondition. GPU fallback
changes were made only with zero in-progress jobs and zero running workers; the one durable
queued smoke job was preserved. All changes are reversible.

## Verification

- `npm run verify:hero-image-resilience`
  - provider error classification
  - fail-fast limit of 3/27 submissions
  - circuit open/expiry
  - real timeout-then-success download retry
  - transactional, exact-bucket, idempotent batch compensation
- `npm run verify:ai-studio`
- `npm run verify:render-receipt`
- `npx tsc --noEmit`

Live custom verification on endpoint `e10knh9zjtr2pl`:

| Gate | Job | Queue/cold delay | Execution | Result |
| --- | --- | ---: | ---: | --- |
| fully fresh pull | `a9638fca-e62d-4d3f-a0c0-04cc1cf66fbf-e2` | 602,423 ms | 11,475 ms | valid 862,128-byte PNG |
| warm, new seed | `d2e8ec43-df5c-4ca6-bb12-37af8487017b-e2` | 95 ms | 5,699 ms | valid 867,743-byte PNG |
| scale-to-zero FlashBoot revival, new seed | `cd465da5-e312-4bc8-9a0f-34ef3d9d1016-e1` | 1,121 ms | 5,379 ms | valid 911,964-byte PNG |
| positive-only workflow | `aa9414de-ca39-4f68-8e03-b6f17190f027-e1` | 300,838 ms | 10,175 ms | valid 863,263-byte, single-frame PNG |

The three images were visually inspected. The RunPod job response did not report a cost.
The allocated A40 showed USD 1.22/hour while running; after `workersMin=0` took effect,
the worker returned to idle/ready FlashBoot state and account `currentSpendPerHr`
returned to USD 0.

The production e2e smoke also proved that the expired registry credential affected the
OmniVoice template, not only Z-Image. A replacement endpoint using the same immutable v11
image completed job `fd3c2e46-992b-437e-877f-79a7d50fa76c-e1`: 126,284-byte, 2.63-second,
24 kHz mono PCM WAV. The smoke contract was corrected to the production worker's required
`num_step=32`.

Final production E2E job `cms6io97f0001lcfspr7ikxqm` passed voice, two custom
Z-Image scenes, and render:

- scene jobs `cms6iq7w20001lcaahpho68xs` and `cms6iq7wb0005lcaa5xjsibob`
- 768×1344 PNGs, visually inspected as two distinct single-camera, edge-to-edge images;
  no collage, grid, contact sheet, or panel composition
- image queue/execution: 12,421/11,028 ms and 24,543/6,093 ms
- final MP4: H.264 1080×1920 + AAC, 10.688 seconds, 7,167,050 bytes, HTTP 200
- test debit: 8 granted credits; restored once with
  `ops_smoke_refund:cms6io97f0001lcfspr7ikxqm`, and the idempotency recheck returned
  `granted:false`

After both gates pass, configure production with the guarded, dry-run-by-default command:

```bash
npm run ops:configure-hero-image-custom-route -- \
  --env-file=/var/www/ai-content/.env \
  --apply \
  --restart-pm2
```

The command pins the exact endpoint/workflow/estimate, keeps the public recovery gate
closed, creates a timestamped environment backup before a changed atomic update, refreshes
both PM2 consumers, and fails unless their running environments match.

RunPod balance evidence for this recovery window:

- opening balance: USD 30.020862
- final settled balance: USD 29.8400623081
- total test spend: USD 0.1807996919 (about THB 6.51 at 36 THB/USD)
- final `currentSpendPerHr`: USD 0

## Remaining credential hardening

The functional recovery is live, but the temporary replacement GHCR registry auth uses
the working classic GitHub token already present on the operator host. Its observed scopes
are `gist`, `read:org`, `repo`, `workflow`, and `write:packages`; GitHub returned no token
expiration header. This is durable enough to pull the immutable image but has more
privilege than a RunPod worker needs.

Replace RunPod registry auth `cms6euknu003npi42luhxaa4t` with a separately created
classic PAT scoped only to `read:packages`, then run `npm run check:ghcr-pull-token` and
a cold smoke before deleting the current auth. GitHub does not provide an API that this
deployment can safely use to mint that user PAT, so this rotation requires the account
owner to create it in GitHub settings. Do not paste the token into this audit or chat.

## Account remediation

Production audit before compensation:

- balance: 14 granted + 958 purchased credits
- incident batch: 26 completed/settled images = 52 granted credits
- prior whole-batch refunds: 0

Use the guarded, dry-run-by-default command after deployment:

```bash
npm run ops:refund-video-image-batch -- \
  --user-email=duckyhero@gmail.com \
  --video-job=cms69pklr0079lc85w6gzblx7 \
  --reason=incident_2026_07_29 \
  --apply
```

Applied production result:

- 26 jobs changed from settled to refunded
- 52 granted credits restored exactly once
- balance changed from 14 granted + 958 purchased (972 total) to
  66 granted + 958 purchased (1,024 total)
- 26 refund-ledger rows total 52 credits and a second dry run finds zero refundable jobs
- final production E2E temporarily debited 8 granted credits, then restored them once;
  final balance remains 66 granted + 958 purchased = 1,024

## Rollback

If the custom live smoke or production smoke fails:

1. Set `AI_STUDIO_Z_IMAGE_ROUTE=disabled` and refresh both PM2 consumers. Because Hero
   Video is pinned to custom and the separate public recovery gate remains closed, this
   leaves the feature safely unavailable before charge.
2. Set endpoint `e10knh9zjtr2pl` back to `workersMax=0`.
3. If voice v9 staging capacity is needed again, restore `k69fz253b59st4` to
   `workersMax=1` after the Z-Image endpoint is parked.
