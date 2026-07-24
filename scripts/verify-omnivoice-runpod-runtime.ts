import assert from "node:assert/strict";

const requests: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  requests.push(url);

  if (url.endsWith("/run")) {
    return Response.json({ id: "queued-job-1", status: "IN_QUEUE" });
  }
  if (url.endsWith("/status/queued-job-1")) {
    return Response.json({ id: "queued-job-1", status: "IN_QUEUE" });
  }
  if (url.endsWith("/cancel/queued-job-1")) {
    return Response.json({ id: "queued-job-1", status: "CANCELLED" });
  }
  return Response.json({ error: "unexpected request" }, { status: 500 });
};

async function main() {
  const imported = await import("../src/lib/omnivoice");
  const module = (
    "callOmniVoice" in imported
      ? imported
      : (imported as typeof imported & { default: typeof imported }).default
  );
  const result = await module.callOmniVoice(
    {
      backend: "runpod",
      endpointId: "endpoint-1",
      apiKey: "test-key",
      numStep: 32,
      maxChunkChars: 700,
      requestBudgetMs: 5_000,
      // Keep the runtime contract test fast; production config clamps this to
      // a minimum of 30 seconds and defaults to 300 seconds.
      queueWaitBudgetMs: 1,
    },
    "voice_01",
    "ทดสอบ",
    1,
    Date.now() + 5_000,
  );

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a queue timeout");
  assert.equal(result.code, "RUNPOD_QUEUE_TIMEOUT");
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    requests.map((url) => new URL(url).pathname),
    [
      "/v2/endpoint-1/run",
      "/v2/endpoint-1/status/queued-job-1",
      "/v2/endpoint-1/cancel/queued-job-1",
    ],
  );
  console.log("RunPod queued-job cancellation runtime check passed.");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
