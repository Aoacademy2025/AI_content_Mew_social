-- Optional server-owned idempotency key for events whose metric contract is
-- exactly-once. NULL keeps all existing/client telemetry append-only.
ALTER TABLE "TelemetryEvent" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "TelemetryEvent_dedupeKey_key" ON "TelemetryEvent"("dedupeKey");
