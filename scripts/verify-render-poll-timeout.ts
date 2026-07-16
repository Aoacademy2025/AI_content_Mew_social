import assert from "node:assert/strict";

import { pollRender, type PipelineCaller } from "../src/lib/mcp/pipeline-client";

const originalNow = Date.now;
let nowMs = 0;
let polls = 0;

const caller: PipelineCaller = {
  async get<T>() {
    polls += 1;
    return (polls >= 47
      ? { progress: 100, videoUrl: "/api/renders/long-render.mp4", error: null, stage: "done" }
      : { progress: 50, videoUrl: null, error: null, stage: "rendering" }) as T;
  },
  async post<T>() {
    throw new Error("unused post") as never;
  },
  async patch<T>() {
    throw new Error("unused patch") as never;
  },
};

async function main() {
  try {
    Date.now = () => nowMs;
    const videoUrl = await pollRender(caller, "long-render", undefined, {
      intervalMs: 60_000,
      sleep: async (ms) => { nowMs += ms; },
    });

    assert.equal(videoUrl, "/api/renders/long-render.mp4");
    assert.equal(polls, 47, "the default poll budget must cover a render finishing after 46 minutes");
    console.log("render poll timeout verifier: 1 check passed");
  } finally {
    Date.now = originalNow;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
