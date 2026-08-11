import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyRunpodTerminalFailure,
  closeHeroRunpodCircuit,
  assessRunpodImageAdmission,
  forEachInFailFastBatches,
  heroRunpodCircuitState,
  openHeroRunpodCircuit,
  recordHeroRunpodFailure,
  recordHeroRunpodSuccess,
  shouldRetryQueuedRunpodJob,
} from "../src/lib/hero-image-resilience";
import {
  heroImageProviderRetryDirective,
} from "../src/lib/mcp/hero-image-pipeline-retry";
import { fetchImageResponseWithRetry } from "../src/lib/ai-generation-image-download";
import { HERO_AI_IMAGE_CREDITS } from "../src/lib/credit-costs";

async function main() {
  const upstreamAuth = classifyRunpodTerminalFailure(
    'Error submitting task: 401, {"code":401,"message":"Invalid API key. Verify the key, or contact support@wavespeed.ai."}',
  );
  assert.deepEqual(upstreamAuth, {
    code: "RUNPOD_UPSTREAM_AUTH",
    systemic: true,
    retryable: false,
  });
  assert.deepEqual(classifyRunpodTerminalFailure("CUDA out of memory"), {
    code: "RUNPOD_FAILED",
    systemic: false,
    retryable: true,
  });
  assert.deepEqual(classifyRunpodTerminalFailure("RUNPOD_QUEUE_TIMEOUT"), {
    code: "RUNPOD_QUEUE_TIMEOUT",
    systemic: false,
    retryable: true,
    stopBatch: true,
  });

  const attempted: number[] = [];
  const batch = await forEachInFailFastBatches(
    Array.from({ length: 27 }, (_, index) => index),
    3,
    async (scene) => {
      attempted.push(scene);
      return { systemic: scene === 0 };
    },
    (result) => result.systemic,
  );
  assert.deepEqual(attempted, [0, 1, 2], "a systemic provider failure must stop after the first concurrency wave");
  assert.deepEqual(batch.processed, [0, 1, 2]);
  assert.equal(batch.skipped.length, 24);
  assert.equal(batch.stopped, true);

  closeHeroRunpodCircuit();
  assert.equal(heroRunpodCircuitState().open, false);
  openHeroRunpodCircuit("RUNPOD_UPSTREAM_AUTH", 1_000);
  assert.deepEqual(heroRunpodCircuitState(1_001), {
    open: true,
    code: "RUNPOD_UPSTREAM_AUTH",
    retryAfterMs: 10 * 60_000 - 1,
  });
  assert.equal(heroRunpodCircuitState(1_000 + 10 * 60_000).open, false);
  closeHeroRunpodCircuit();
  assert.deepEqual(recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", "job-a", 2_000), {
    circuitOpened: false,
    independentSignals: 1,
  });
  assert.equal(heroRunpodCircuitState(2_001).open, false, "one queue timeout must not stop other accounts");
  assert.deepEqual(recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", "job-a", 2_002), {
    circuitOpened: false,
    independentSignals: 1,
  }, "the same durable job must not count twice");
  assert.deepEqual(recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", "job-b", 2_003), {
    circuitOpened: true,
    independentSignals: 2,
  });
  assert.deepEqual(heroRunpodCircuitState(2_004), {
    open: true,
    code: "RUNPOD_QUEUE_TIMEOUT",
    retryAfterMs: 60_000 - 1,
  });
  assert.deepEqual(heroRunpodCircuitState(2_003 + 60_000), {
    open: false,
    halfOpen: true,
  });
  assert.equal(
    heroRunpodCircuitState(2_003 + 60_001).open,
    true,
    "only one request may claim the half-open probe",
  );
  recordHeroRunpodSuccess();
  assert.equal(heroRunpodCircuitState().open, false);
  assert.equal(shouldRetryQueuedRunpodJob({
    queuedMs: 120_000,
    health: {
      jobs: { inQueue: 1, inProgress: 0 },
      workers: { idle: 1, running: 1 },
    },
  }), true, "an idle worker plus a long queued job is an orphan signal");
  assert.equal(shouldRetryQueuedRunpodJob({
    queuedMs: 120_000,
    health: {
      jobs: { inQueue: 1, inProgress: 1 },
      workers: { idle: 0, running: 1 },
    },
  }), false, "a busy worker is normal capacity pressure, not an orphan");
  assert.equal(HERO_AI_IMAGE_CREDITS, 2, "the custom Hero route needs the approved 2-credit cost envelope");

  assert.deepEqual(assessRunpodImageAdmission({
    jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 },
    workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 0, unhealthy: 0 },
  }), { admitted: true }, "a healthy scale-to-zero endpoint remains admissible");
  assert.deepEqual(assessRunpodImageAdmission({
    jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 },
    workers: { idle: 1, initializing: 0, ready: 0, running: 0, throttled: 1, unhealthy: 0 },
  }), { admitted: false, reason: "workers_throttled" }, "throttled capacity is rejected before image credits are reserved");
  assert.deepEqual(assessRunpodImageAdmission({
    jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 2, retried: 0 },
    workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 0, unhealthy: 1 },
  }), { admitted: false, reason: "workers_unhealthy" }, "an unhealthy endpoint with no usable worker is rejected before spend");

  const providerTimeout = Object.assign(new Error("provider queue timed out"), {
    name: "PipelineHttpError",
    path: "/api/videos/fetch-stock",
    status: 503,
    body: {
      error: "provider queue timed out",
      code: "HERO_IMAGE_UNAVAILABLE",
      retryable: true,
      retryAfterSec: 60,
    },
  });
  assert.deepEqual(heroImageProviderRetryDirective(providerTimeout, 0), {
    nextAttempt: 1,
    delayMs: 60_000,
    code: "HERO_IMAGE_UNAVAILABLE",
  }, "a refunded provider outage receives one bounded stock-only retry");
  assert.equal(
    heroImageProviderRetryDirective(providerTimeout, 1),
    null,
    "a second provider outage becomes terminal instead of looping or spending indefinitely",
  );
  assert.equal(
    heroImageProviderRetryDirective(Object.assign(new Error("credits"), {
      name: "PipelineHttpError",
      path: "/api/videos/fetch-stock",
      status: 402,
      body: {
        error: "credits",
        code: "INSUFFICIENT_CREDITS",
        retryable: false,
      },
    }), 0),
    null,
    "financial failures are never auto-retried",
  );

  let imageHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/image.png") {
      res.writeHead(404);
      res.end();
      return;
    }
    imageHits += 1;
    if (imageHits === 1) return;
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": "8",
    });
    res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const response = await fetchImageResponseWithRetry(
      `http://127.0.0.1:${address.port}/image.png`,
      { timeoutMs: 50, retries: 1, wallClockMs: 2_000 },
    );
    assert.equal(response.status, 200);
    assert.equal(imageHits, 2, "a timed-out temporary image download must be retried");
    assert.equal((await response.arrayBuffer()).byteLength, 8);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const fetchStock = fs.readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const heroImage = fs.readFileSync("src/lib/video-hero-image.server.ts", "utf8");
  const media = fs.readFileSync("src/lib/ai-generation-media.server.ts", "utf8");
  const runpod = fs.readFileSync("src/lib/runpod-serverless.ts", "utf8");
  const orchestrator = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  const capacity = fs.readFileSync("scripts/configure-runpod-image-capacity.ts", "utf8");
  const provider = fs.readFileSync("src/lib/image-generation-provider.server.ts", "utf8");
  const videoJobs = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  const editor = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
  const receipt = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx", "utf8");
  assert.match(fetchStock, /forEachInFailFastBatches/, "the real Hero video route must use fail-fast batching");
  assert.match(fetchStock, /HERO_RUNPOD_CONCURRENCY/, "app concurrency must be explicit and capped to the endpoint contract");
  assert.match(
    fetchStock,
    /Provider phase first:[\s\S]+Local[\s\S]+Ken Burns run only after the provider queue drains/,
    "provider generation must be decoupled from local Ken Burns processing",
  );
  assert.match(fetchStock, /refundSettledVideoImageBatch/, "the real Hero video route must compensate settled scene credits");
  assert.match(fetchStock, /heroRunpodCircuitState/, "the route must reject requests while the Hero provider circuit is open");
  assert.match(fetchStock, /assessRunpodImageAdmission/, "the route must inspect live endpoint health before image reservations");
  assert.match(fetchStock, /heroProviderAttempt/, "provider retries must use a fresh idempotency namespace");
  assert.match(
    orchestrator,
    /fetchStockWithHeroProviderRetry/,
    "the video pipeline must retry only the stock seam instead of replaying voice and captions",
  );
  assert.match(
    orchestrator,
    /heroImageProviderRetryDirective/,
    "the video pipeline must keep provider retries bounded by the shared decision contract",
  );
  assert.match(heroImage, /classifyRunpodTerminalFailure/, "provider terminal errors must retain systemic classification");
  assert.match(heroImage, /prepared\.providerRoute !== "runpod-custom"/, "Hero video must stay pinned to the verified custom endpoint");
  assert.match(heroImage, /cancelRunpodImageJob/, "a bounded custom-worker timeout must cancel the exact durable provider job");
  assert.match(heroImage, /replaceCanceledImageAttempt/, "a confirmed orphan cancellation must create one durable same-engine retry");
  assert.match(heroImage, /getRunpodEndpointHealth/, "orphan detection must consult live endpoint capacity");
  assert.match(heroImage, /RUNPOD_QUEUE_TIMEOUT/, "queue exhaustion must stop only the affected video batch");
  assert.match(runpod, /cancelRunpodImageJob/, "the image provider must expose guarded cancellation");
  assert.match(runpod, /getRunpodEndpointHealth/, "the image provider must expose endpoint health for orphan detection");
  assert.match(capacity, /productionWorkersMax = 2/, "the guarded capacity command must target two workers");
  assert.match(capacity, /rollback \? 1 : productionWorkersMax/, "the guarded command must support an explicit one-worker rollback");
  assert.match(capacity, /queued > 0 \|\| inProgress > 0/, "capacity mutation must refuse a non-empty provider queue");
  assert.match(capacity, /workersMin: 0/, "capacity must preserve scale-to-zero");
  assert.match(capacity, /idleTimeout: desiredIdleTimeout/, "capacity must preserve the five-second idle timeout");
  assert.match(provider, /model\.customCreditCostKey/, "the custom endpoint must receive its route-specific quote");
  assert.match(videoJobs, /offer\.providerRoute !== "runpod-custom"/, "job creation must reject an accidental public-route rollback");
  assert.match(editor, /HERO_AI_IMAGE_CREDITS/, "the editor must disclose the custom-route price from the shared table");
  assert.match(receipt, /return HERO_AI_IMAGE_CREDITS/, "the render receipt must use the same custom-route price");
  assert.match(media, /fetchImageResponseWithRetry/, "the real persistence path must use bounded retry");

  console.log("verify-hero-image-resilience: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
