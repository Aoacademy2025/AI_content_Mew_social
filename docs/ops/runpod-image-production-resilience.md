# RunPod image production resilience

Updated: 2026-07-30

This route remains a private beta. Do not open public traffic until the
300-image cold/warm/concurrent/fault canary passes and the fully-loaded cost
snapshot stays at or below the approved ceiling.

## Cost contract

- Operating target: no more than ฿0.90 per delivered image.
- Warning: above ฿0.90 through ฿1.08.
- Hard stop: above ฿1.08, the current Kie GPT Image 2 1K comparison price at
  USD 0.03 and the approved THB conversion.
- Minimum decision sample: 20 delivered, settled images.
- Billing freshness: three hours. Once a successful sync exists, stale billing
  fails closed.

The numerator comes from RunPod's endpoint billing API and includes every
charged second: initialization, execution, idle time, failed attempts, retry
attempts, and operational smokes. The denominator includes only completed image
jobs still settled to a customer. Refunded/incomplete video batches are not
counted as delivered.

The `runpod-image-cost-sync` PM2 cron refreshes the current and prior 72 hours at
minute 7 of every hour. Current-hour records are upserted, not accumulated. The
admin cost panel shows the seven-day fully-loaded result.

Manual verification:

```bash
npm run sync:runpod-image-cost
```

## Queue and retry contract

- App provider concurrency is exactly 2.
- Endpoint capacity is `workersMin=0`, `workersMax=2`, `idleTimeout=5`, with
  FlashBoot enabled.
- A job queued for two minutes is considered an orphan only when endpoint
  health simultaneously reports a queued job and an idle worker.
- The exact provider job must return confirmed `CANCELLED` before a replacement
  attempt is created.
- A customer image job permits one replacement attempt, on the same endpoint,
  model, prompt, seed, and credit reservation. It never crosses to Kie.
- An unconfirmed cancellation leaves the reservation durable for
  reconciliation and stops only that video batch.
- One queue timeout does not open the global circuit. Two independent durable
  jobs within five minutes open a 60-second circuit, followed by one half-open
  probe. Auth/config failures still open the ten-minute circuit immediately.

Provider generation finishes before local image copying and Ken Burns work
begins, preventing CPU post-processing from repeatedly letting the GPU endpoint
scale down between provider waves.

## Capacity change

Both commands are dry-run by default and refuse to mutate an unexpected
endpoint or an endpoint with queued/in-progress jobs.

```bash
# Desired production capacity
RUNPOD_ENV_FILE=/var/www/ai-content/.env \
  npm run ops:configure-runpod-image-capacity

RUNPOD_ENV_FILE=/var/www/ai-content/.env \
  npm run ops:configure-runpod-image-capacity -- --apply

# Immediate rollback to workersMax=1
RUNPOD_ENV_FILE=/var/www/ai-content/.env \
  npm run ops:configure-runpod-image-capacity -- --rollback

RUNPOD_ENV_FILE=/var/www/ai-content/.env \
  npm run ops:configure-runpod-image-capacity -- --rollback --apply
```

## Rollout gates

1. Back up the production SQLite database.
2. Require empty VideoJob, RenderJob, and RunPod image queues.
3. Deploy the additive schema and application build.
4. Confirm the immediate billing sync is fresh and admitted.
5. Apply `workersMax=2` only while the provider queue is empty.
6. Run private canaries: cold single, warm pair, two concurrent, and forced
   queue cancellation/retry.
7. Run 300 private-beta images across representative batch sizes.
8. Keep public access closed until success rate, queue recovery, duplicate
   prevention, refunds, and fully-loaded COGS all pass.

Rollback app code normally. The additive billing tables can remain. Roll back
capacity separately with `--rollback --apply`; do not purge the provider queue.
