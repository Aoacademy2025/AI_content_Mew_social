import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_HERO_IMAGE_SCENE_RETRY_MAX,
  selectSceneRetries,
  type HeroSceneFailure,
} from "../src/lib/hero-image-scene-retry";

function failure(
  sourceIndex: number,
  overrides: Partial<HeroSceneFailure> & { code?: string } = {},
): HeroSceneFailure & { code: string } {
  return {
    sourceIndex,
    code: "OUTPUT_INVALID",
    systemic: false,
    retryable: true,
    stopBatch: false,
    ...overrides,
  };
}

async function main() {
  assert.equal(DEFAULT_HERO_IMAGE_SCENE_RETRY_MAX, 2, "the default in-batch retry budget is two scenes");

  // ---- empty input -----------------------------------------------------
  assert.deepEqual(
    selectSceneRetries([], { max: 2 }),
    { retrySourceIndexes: [], remainingFailures: [] },
    "no failures means no retries",
  );

  // ---- only retryable && !systemic && !stopBatch is eligible -----------
  {
    const failures = [
      failure(0, { systemic: true, code: "PROVIDER_UNAVAILABLE" }),
      failure(1, { retryable: false, code: "PROVIDER_FAILED" }),
      failure(2, { stopBatch: true, code: "PROVIDER_TIMEOUT" }),
      failure(3),
    ];
    const selection = selectSceneRetries(failures, { max: 5 });
    assert.deepEqual(selection.retrySourceIndexes, [3], "systemic / non-retryable / batch-stopping failures stay failures");
    assert.deepEqual(
      selection.remainingFailures.map((item) => item.sourceIndex),
      [0, 1, 2],
      "the ineligible failures survive in their original order",
    );
  }

  // ---- the budget caps how many scenes are retried, order preserved ----
  {
    const failures = [failure(7), failure(2), failure(5), failure(9)];
    const selection = selectSceneRetries(failures, { max: 2 });
    assert.deepEqual(selection.retrySourceIndexes, [7, 2], "the first `max` eligible failures are retried, in order");
    assert.deepEqual(
      selection.remainingFailures.map((item) => item.sourceIndex),
      [5, 9],
      "everything over the budget stays a failure so the batch still refunds",
    );
  }

  // ---- the default budget applies when max is omitted ------------------
  {
    const selection = selectSceneRetries([failure(0), failure(1), failure(2)]);
    assert.deepEqual(selection.retrySourceIndexes, [0, 1]);
    assert.deepEqual(selection.remainingFailures.map((item) => item.sourceIndex), [2]);
  }

  // ---- a zero budget disables in-batch retry entirely ------------------
  {
    const failures = [failure(0), failure(1)];
    const selection = selectSceneRetries(failures, { max: 0 });
    assert.deepEqual(selection.retrySourceIndexes, []);
    assert.deepEqual(selection.remainingFailures, failures, "a disabled budget changes nothing");
  }

  // ---- only scenes the provider phase actually owns can be retried -----
  // A reused Brand Visual whose retained asset vanished is retryable, but it
  // has no provider job to re-run: dropping it would ship an incomplete video.
  {
    const failures = [
      failure(0, { code: "RETAINED_ASSET_UNAVAILABLE" }),
      failure(4),
    ];
    const selection = selectSceneRetries(failures, { max: 2, eligibleSourceIndexes: [4] });
    assert.deepEqual(selection.retrySourceIndexes, [4]);
    assert.deepEqual(
      selection.remainingFailures.map((item) => item.code),
      ["RETAINED_ASSET_UNAVAILABLE"],
      "a scene outside the provider batch must keep its failure",
    );
  }

  // ---- a scene is never queued for retry twice -------------------------
  {
    const selection = selectSceneRetries([failure(3), failure(3)], { max: 2 });
    assert.deepEqual(selection.retrySourceIndexes, [3], "the same scene is retried at most once");
    assert.equal(selection.remainingFailures.length, 1, "the duplicate stays a failure — fail closed");
  }

  // ---- the input array is never mutated --------------------------------
  {
    const failures = [failure(1), failure(2), failure(3)];
    const snapshot = JSON.parse(JSON.stringify(failures));
    selectSceneRetries(failures, { max: 1 });
    assert.deepEqual(JSON.parse(JSON.stringify(failures)), snapshot, "selectSceneRetries is pure");
  }

  // ---- wiring: the video route and the provider path use the helpers ---
  const route = fs.readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const heroImage = fs.readFileSync("src/lib/video-hero-image.server.ts", "utf8");

  assert.match(route, /selectSceneRetries/, "the video batch must decide retries through the shared pure helper");
  assert.match(
    route,
    /scene-retry:\$\{sceneRetry\}|:scene-retry:/,
    "a retried scene must carry its own idempotency key so it cannot reuse the failed job",
  );
  assert.match(route, /HERO_IMAGE_SCENE_RETRY_MAX/, "the in-batch retry budget must be bounded and env-overridable");
  assert.match(route, /heroSceneRetryCount/, "telemetry must report how many scenes were retried");
  assert.match(route, /heroSceneRetryRecoveredCount/, "telemetry must report how many retries recovered the batch");
  assert.match(route, /sceneRetry/, "the scene error event must mark the retried attempt");
  assert.match(
    route,
    /!batchOutcome\.stopped/,
    "a stopped batch (open circuit / stalled queue) must not be re-driven scene by scene",
  );

  assert.match(heroImage, /withTransientDbRetry/, "persisting a completed image must survive a transient DB timeout");
  assert.match(
    heroImage,
    /label:\s*"completeImageJob"/,
    "the retry must be labelled so the warning identifies the operation",
  );
  const completedBranch = heroImage.slice(
    heroImage.indexOf('if (snapshot.status === "COMPLETED")'),
    heroImage.indexOf('if (TERMINAL_PROVIDER.has(snapshot.status))'),
  );
  assert.ok(completedBranch.length > 0, "the COMPLETED branch must still exist");
  assert.equal(
    (completedBranch.match(/persistAiGenerationImage\(/g) ?? []).length,
    1,
    "the image file is persisted once and reused across DB retries",
  );
  assert.ok(
    completedBranch.indexOf("persistAiGenerationImage(")
      < completedBranch.indexOf("withTransientDbRetry("),
    "the image must be on disk before the retried transaction runs",
  );
  assert.match(completedBranch, /failAndRefundAiJob\(/, "an exhausted retry must still refund exactly as before");
  assert.match(completedBranch, /"OUTPUT_INVALID"/, "the public failure code is unchanged");

  console.log("verify-hero-image-scene-retry: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
