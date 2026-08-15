import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HeavyMediaAdmission } from "../src/lib/heavy-media-admission";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-media-admission-"));
const alive = new Set([101, 202, 303]);
const options = (pid: number) => ({
  rootDir,
  enabled: true,
  pid,
  isProcessAlive: (candidate: number) => alive.has(candidate),
  leaseStaleMs: 2_000,
});

async function main() {
  const renderAdmission = new HeavyMediaAdmission(options(101));
  const compositeAdmission = new HeavyMediaAdmission(options(202));
  const secondRenderAdmission = new HeavyMediaAdmission(options(303));

  const renderLease = await renderAdmission.tryAcquireRender();
  assert.ok(renderLease, "a render acquires admission when no composite is active");

  const compositePromise = compositeAdmission.acquireComposite({ maxWaitMs: 1_000, pollMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    await secondRenderAdmission.tryAcquireRender(),
    null,
    "a waiting composite blocks new renders so it cannot starve",
  );

  await renderLease.release();
  const compositeLease = await compositePromise;
  assert.equal(
    await secondRenderAdmission.tryAcquireRender(),
    null,
    "an active composite remains exclusive across processes",
  );

  await compositeLease.heartbeat();
  await compositeLease.release();
  const secondRenderLease = await secondRenderAdmission.tryAcquireRender();
  assert.ok(secondRenderLease, "renders resume after the composite releases admission");
  await secondRenderLease.release();

  const deadRenderLease = await renderAdmission.tryAcquireRender();
  assert.ok(deadRenderLease, "a render lease can be created for stale-owner coverage");
  alive.delete(101);
  const recoveredComposite = await compositeAdmission.acquireComposite({ maxWaitMs: 500, pollMs: 10 });
  assert.ok(recoveredComposite, "a dead process lease is reclaimed without manual cleanup");
  await recoveredComposite.release();

  const disabled = new HeavyMediaAdmission({ rootDir, enabled: false, pid: 404 });
  const disabledLease = await disabled.acquireComposite({ maxWaitMs: 1, pollMs: 1 });
  assert.ok(disabledLease, "disabled admission is a no-op instead of changing legacy behavior");
  await disabledLease.release();

  console.log("ALL PASS");
}

main()
  .finally(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
