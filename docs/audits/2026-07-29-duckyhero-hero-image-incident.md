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
but failed on nested WaveSpeed 401”. No API key or secret was included.

## Permanent remediation

Hero Video is now fail-closed on the isolated custom endpoint
`0c6eadcsuhuhor` (`heroai-z-image-turbo-staging-v1`). It does not fall back to KIE or
another AI engine.

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

RunPod capacity changes:

- superseded voice v9 staging endpoint `k69fz253b59st4`: `workersMax 1 → 0`
- isolated Z-Image endpoint `0c6eadcsuhuhor`: `workersMax 0 → 1`
- Z-Image 48 GB fallback pool: `A40 / L40S / RTX 6000 Ada` →
  `A40 / RTX A6000 / L40S` after a live smoke remained queued without any worker
  allocation
- production voice endpoint `txvrmtzfc8au3b`: unchanged

Both capacity mutations passed the zero queued/in-progress precondition and are
reversible.

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

The isolated endpoint fully-cold warm-up must complete, followed by a second live smoke
whose queue + execution time fits inside the application's bounded nine-minute wait,
before production traffic is switched. Record both terminal job IDs, queue delay,
execution time, provider cost, and stored image result here during rollout.

After both gates pass, configure production with the guarded, dry-run-by-default command:

```bash
npm run ops:configure-hero-image-custom-route -- \
  --env-file=/var/www/ai-content/.env \
  --apply
```

The command pins the exact endpoint/workflow/estimate, keeps the public recovery gate
closed, and creates a timestamped environment backup before the atomic update.

## Account remediation

Production audit before compensation:

- balance: 14 granted + 958 purchased credits
- incident batch: 26 completed/settled images = 52 purchased credits
- prior whole-batch refunds: 0

Use the guarded, dry-run-by-default command after deployment:

```bash
npm run ops:refund-video-image-batch -- \
  --user-email=duckyhero@gmail.com \
  --video-job=cms69pklr0079lc85w6gzblx7 \
  --reason=incident_2026_07_29 \
  --apply
```

The expected result is 26 jobs and 52 purchased credits restored exactly once.

## Rollback

If the custom live smoke or production smoke fails:

1. Keep `AI_STUDIO_Z_IMAGE_ROUTE` unset/public. Because Hero Video is pinned to custom,
   this leaves the feature safely unavailable before charge instead of returning traffic
   to the broken public endpoint.
2. Set endpoint `0c6eadcsuhuhor` back to `workersMax=0`.
3. If voice v9 staging capacity is needed again, restore `k69fz253b59st4` to
   `workersMax=1` after the Z-Image endpoint is parked.
