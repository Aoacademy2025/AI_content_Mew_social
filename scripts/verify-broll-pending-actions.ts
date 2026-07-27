import assert from "node:assert/strict";
import {
  resolveBrollExportSource,
  type BrollExportSource,
} from "../src/lib/broll-rerender";

const current: BrollExportSource = {
  jobId: "job-original",
  videoUrl: "/api/renders/original.mp4",
  compositeBaseUrl: "/api/renders/original-base.mp4",
};
const applied: BrollExportSource = {
  jobId: "job-broll-rerender",
  videoUrl: "/api/renders/with-uploaded-broll.mp4",
  compositeBaseUrl: "/api/renders/with-uploaded-broll-base.mp4",
};

let applyCalls = 0;

async function main() {
  const unchanged = await resolveBrollExportSource({
    pendingEditCount: 0,
    current,
    applyPending: async () => {
      applyCalls += 1;
      return applied;
    },
  });
  assert.deepEqual(unchanged, current, "no pending edit keeps the current export source");
  assert.equal(applyCalls, 0, "no pending edit must not enqueue a b-roll re-render");

  const updated = await resolveBrollExportSource({
    pendingEditCount: 3,
    current,
    applyPending: async () => {
      applyCalls += 1;
      return applied;
    },
  });
  assert.deepEqual(updated, applied, "pending edits export from the applied b-roll job");
  assert.equal(applyCalls, 1, "pending edits enqueue exactly one b-roll re-render");
  assert.notEqual(updated?.jobId, current.jobId, "pending edits can never export from the stale source job");

  const failed = await resolveBrollExportSource({
    pendingEditCount: 1,
    current,
    applyPending: async () => null,
  });
  assert.equal(failed, null, "a failed b-roll apply aborts export instead of falling back to stale media");

  console.log("B-roll pending action contract passed");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
