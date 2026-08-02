import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClientPoller } from "../src/lib/client-polling";

type TimerTask = { id: number; at: number; fn: () => void };

async function main() {
  let clock = 0;
  let nextTimerId = 1;
  const timers: TimerTask[] = [];
  const schedule = (fn: () => void, delayMs: number) => {
    const id = nextTimerId++;
    timers.push({ id, at: clock + delayMs, fn });
    return id;
  };
  const cancel = (id: unknown) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  async function advance(ms: number) {
    const target = clock + ms;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      clock = next.at;
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    clock = target;
    await Promise.resolve();
    await Promise.resolve();
  }

  let visible = true;
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseSlow: (() => void) | null = null;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const poller = createClientPoller({
    task: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls === 1) await slow;
      concurrent -= 1;
    },
    isActive: () => true,
    isVisible: () => visible,
    nextDelayMs: ({ isVisible }) => isVisible ? 5_000 : null,
    schedule,
    cancel,
  });

  poller.start();
  await advance(0);
  assert.equal(calls, 1);
  await advance(30_000);
  assert.equal(calls, 1, "a slow request never overlaps with another poll");
  releaseSlow?.();
  await Promise.resolve();
  await Promise.resolve();
  await advance(5_000);
  assert.equal(calls, 2);
  assert.equal(maxConcurrent, 1);

  visible = false;
  await advance(5_000);
  assert.equal(calls, 3, "the already-scheduled tick observes the hidden state once");
  await advance(60_000);
  assert.equal(calls, 3, "hidden polling pauses when policy returns null");
  visible = true;
  poller.wake();
  await advance(0);
  assert.equal(calls, 4, "visibility wake resumes immediately");
  poller.stop();
  await advance(60_000);
  assert.equal(calls, 4, "stop removes all future work");

  const notificationSource = readFileSync(join(process.cwd(), "src/components/layout/notification-bell.tsx"), "utf8");
  assert.match(notificationSource, /createClientPoller/);
  assert.doesNotMatch(notificationSource, /setInterval/);
  assert.match(notificationSource, /failures >= 3 \? 300_000/);

  const jobSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/useV2Job.ts"), "utf8");
  assert.match(jobSource, /createClientPoller/);
  assert.doesNotMatch(jobSource, /setInterval/);
  assert.match(jobSource, /isVisible \? POLL_MS : 30_000/);

  const badgeSource = readFileSync(join(process.cwd(), "src/components/v2-job-badge.tsx"), "utf8");
  assert.match(badgeSource, /createClientPoller/);
  assert.doesNotMatch(badgeSource, /setInterval/);
  assert.match(badgeSource, /hasRunningJob \? 15_000 : 60_000/);

  console.log("client polling verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
