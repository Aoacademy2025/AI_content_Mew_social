import assert from "node:assert";
import { createHmac } from "node:crypto";

import {
  buildLineRetryKey,
  buildSentryLineAlert,
  sendLinePush,
  timingSafeTextEqual,
  verifySentryServiceHookSignature,
} from "../src/lib/sentry-line-alert";
import { POST } from "../src/app/api/webhooks/sentry-line/route";

const MANAGED_ENV_KEYS = [
  "SENTRY_LINE_ALERTS_ENABLED",
  "SENTRY_SERVICE_HOOK_ID",
  "SENTRY_SERVICE_HOOK_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_TARGET_USER_ID",
] as const;

function signedRequest(
  payload: unknown,
  secret: string,
  hookId: string,
): Request {
  const body = JSON.stringify(payload);
  return new Request("https://studio.example.com/api/webhooks/sentry-line", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ServiceHook-GUID": hookId,
      "X-ServiceHook-Signature": createHmac("sha256", secret)
        .update(body)
        .digest("hex"),
    },
    body,
  });
}

async function main() {
  const rawBody = JSON.stringify({ event_id: "event-1" });
  const secret = "test-service-hook-secret";
  const signature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  assert.strictEqual(
    verifySentryServiceHookSignature(rawBody, signature, secret),
    true,
  );
  assert.strictEqual(
    verifySentryServiceHookSignature(rawBody, `sha256=${signature}`, secret),
    true,
  );
  assert.strictEqual(
    verifySentryServiceHookSignature(`${rawBody} `, signature, secret),
    false,
  );
  assert.strictEqual(
    verifySentryServiceHookSignature(rawBody, "not-a-signature", secret),
    false,
  );
  assert.strictEqual(timingSafeTextEqual("hook-1", "hook-1"), true);
  assert.strictEqual(timingSafeTextEqual("hook-1", "hook-2"), false);

  const alert = buildSentryLineAlert({
    event_id: "event-1",
    group_id: "7712167681",
    title:
      "Render failed for customer@example.com token=plain-secret at https://studio.example.com/export?session=secret",
    culprit:
      "POST /api/videos/550e8400-e29b-41d4-a716-446655440000/render?token=secret",
    level: "error",
    metadata: { type: "RenderError", value: "private customer script" },
    tags: [["environment", "production"]],
    extra: { prompt: "must never be forwarded" },
  });
  assert(alert);
  assert.match(alert.text, /ระดับ: ERROR/);
  assert.match(alert.text, /ประเภท: RenderError/);
  assert.match(alert.text, /POST \/api\/videos\/\[id\]\/render/);
  assert.match(alert.text, /sentry\.io\/issues\/7712167681\//);
  assert.doesNotMatch(
    alert.text,
    /customer@example\.com|plain-secret|private customer|session=|must never|550e8400/,
  );
  const unsafeTypeAlert = buildSentryLineAlert({
    event_id: "event-unsafe-type",
    metadata: { type: "customer private error text" },
    tags: [["environment", "production"]],
  });
  assert(unsafeTypeAlert);
  assert.match(unsafeTypeAlert.text, /ประเภท: ApplicationError/);
  assert.doesNotMatch(unsafeTypeAlert.text, /customer private/);
  assert.strictEqual(
    buildSentryLineAlert({
      event_id: "event-2",
      title: "Development error",
      tags: [["environment", "development"]],
    }),
    null,
  );

  const retryKey = buildLineRetryKey("hook-1", "event-1");
  assert.match(
    retryKey,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.strictEqual(retryKey, buildLineRetryKey("hook-1", "event-1"));
  assert.notStrictEqual(retryKey, buildLineRetryKey("hook-1", "event-2"));

  let request: { url?: string; init?: RequestInit } = {};
  const delivered = await sendLinePush(
    {
      accessToken: "line-test-token",
      targetId: "U-test-target",
      text: alert.text,
      retryKey,
    },
    async (url, init) => {
      request = { url: String(url), init };
      return new Response("{}", { status: 200 });
    },
  );
  assert.strictEqual(delivered, true);
  assert.strictEqual(request.url, "https://api.line.me/v2/bot/message/push");
  assert.strictEqual(
    (request.init?.headers as Record<string, string>)["X-Line-Retry-Key"],
    retryKey,
  );
  const body = JSON.parse(String(request.init?.body));
  assert.strictEqual(body.to, "U-test-target");
  assert.strictEqual(body.messages[0].text, alert.text);
  assert.strictEqual(body.notificationDisabled, false);

  const rejected = await sendLinePush(
    {
      accessToken: "line-test-token",
      targetId: "U-test-target",
      text: "test",
      retryKey,
    },
    async () => new Response("{}", { status: 429 }),
  );
  assert.strictEqual(rejected, false);

  const originalEnv = Object.fromEntries(
    MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  try {
    for (const key of MANAGED_ENV_KEYS) delete process.env[key];
    let response = await POST(
      new Request("https://studio.example.com/api/webhooks/sentry-line", {
        method: "POST",
      }),
    );
    assert.strictEqual(response.status, 503);

    process.env.SENTRY_LINE_ALERTS_ENABLED = "1";
    const routeHookId = "1".repeat(32);
    const routeSecret = "2".repeat(64);
    process.env.SENTRY_SERVICE_HOOK_ID = routeHookId;
    process.env.SENTRY_SERVICE_HOOK_SECRET = routeSecret;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-route-test-token".repeat(2);
    process.env.LINE_TARGET_USER_ID = `U${"3".repeat(32)}`;

    response = await POST(
      new Request("https://studio.example.com/api/webhooks/sentry-line", {
        method: "POST",
        headers: {
          "X-ServiceHook-GUID": routeHookId,
          "X-ServiceHook-Signature": "0".repeat(64),
        },
        body: "{}",
      }),
    );
    assert.strictEqual(response.status, 401);

    let pushCount = 0;
    globalThis.fetch = async () => {
      pushCount += 1;
      return new Response("{}", { status: 200 });
    };
    response = await POST(
      signedRequest(
        {
          event_id: "route-staging",
          title: "Staging only",
          tags: [["environment", "staging"]],
        },
        routeSecret,
        routeHookId,
      ),
    );
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      ok: true,
      delivered: false,
    });
    assert.strictEqual(pushCount, 0);

    response = await POST(
      signedRequest(
        {
          event_id: "route-production",
          group_id: "12345",
          title: "Production failure",
          level: "error",
          tags: [["environment", "production"]],
        },
        routeSecret,
        routeHookId,
      ),
    );
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      ok: true,
      delivered: true,
    });
    assert.strictEqual(pushCount, 1);

    response = await POST(
      new Request("https://studio.example.com/api/webhooks/sentry-line", {
        method: "POST",
        headers: { "Content-Length": String(256 * 1024 + 1) },
      }),
    );
    assert.strictEqual(response.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log("verify-sentry-line-alert: all checks passed");
}

main();
