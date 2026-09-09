import assert from "assert";

import {
  beforeSendSentryEvent,
  beforeSentryBreadcrumb,
  parseSentrySampleRate,
  sentryDataCollection,
} from "../src/lib/sentry-config";

function main() {
  assert.strictEqual(parseSentrySampleRate(undefined, 0.05), 0.05);
  assert.strictEqual(parseSentrySampleRate("0.2", 0.05), 0.2);
  assert.strictEqual(parseSentrySampleRate("2", 0.05), 0.05);
  assert.strictEqual(parseSentrySampleRate("not-a-number", 0.05), 0.05);

  assert.deepStrictEqual(sentryDataCollection.httpBodies, []);
  assert.strictEqual(sentryDataCollection.cookies, false);
  assert.strictEqual(sentryDataCollection.httpHeaders?.request, false);
  assert.strictEqual(sentryDataCollection.httpHeaders?.response, false);
  assert.strictEqual(sentryDataCollection.urlQueryParams, false);
  assert.strictEqual(sentryDataCollection.graphQL?.variables, false);
  assert.strictEqual(sentryDataCollection.genAI?.inputs, false);
  assert.strictEqual(sentryDataCollection.genAI?.outputs, false);
  assert.strictEqual(sentryDataCollection.databaseQueryData, false);
  assert.strictEqual(sentryDataCollection.stackFrameVariables, false);

  const event = beforeSendSentryEvent({
    event_id: "test-event",
    message:
      "export failed for customer@example.com with Bearer fake-token at /api/export?token=fake",
    user: { email: "customer@example.com" },
    request: {
      cookies: { session: "secret-session" },
      data: { prompt: "customer prompt" },
      headers: { authorization: "Bearer secret-token" },
      method: "POST",
      query_string: "token=secret-token",
      url: "https://studio.example.com/api/export?token=secret-token#debug",
    },
    extra: {
      apiKey: "secret-key",
      callback: "https://provider.example.com/jobs/1?signature=secret",
      nested: { access_token: "secret-token" },
    },
    breadcrumbs: [
      { category: "console", level: "info", message: "customer prompt" },
      {
        category: "http",
        data: { url: "/api/export?token=secret-token" },
        level: "error",
      },
    ],
  });

  assert(event, "a real application error must not be dropped");
  assert.strictEqual(event.user, undefined);
  assert.strictEqual(
    event.message,
    "export failed for [Email] with Bearer [Filtered] at /api/export",
  );
  assert.deepStrictEqual(event.request, {
    method: "POST",
    url: "https://studio.example.com/api/export",
  });
  assert.strictEqual(event.extra?.apiKey, "[Filtered]");
  assert.strictEqual(event.extra?.nested?.access_token, "[Filtered]");
  assert.strictEqual(
    event.extra?.callback,
    "https://provider.example.com/jobs/1",
  );
  assert.deepStrictEqual(event.breadcrumbs, [
    {
      category: "http",
      data: { url: "/api/export" },
      level: "error",
    },
  ]);

  assert.strictEqual(
    beforeSentryBreadcrumb({ category: "console", level: "info" }),
    null,
  );
  assert.deepStrictEqual(
    beforeSentryBreadcrumb({
      category: "http",
      data: {
        authorization: "Bearer secret-token",
        url: "https://studio.example.com/path?customer=mew",
      },
      level: "error",
    }),
    {
      category: "http",
      data: {
        authorization: "[Filtered]",
        url: "https://studio.example.com/path",
      },
      level: "error",
    },
  );
  assert.strictEqual(
    beforeSendSentryEvent({
      exception: {
        values: [
          {
            type: "ProtocolError",
            value: "ProtocolError: Target.attachToTarget failed: Target closed",
          },
        ],
      },
    }),
    null,
  );

  // Third-party browser noise, using frame origins observed in production.
  const injected = (value: string, filenames: string[]) =>
    beforeSendSentryEvent({
      exception: {
        values: [
          {
            type: "Error",
            value,
            stacktrace: { frames: filenames.map((filename) => ({ filename })) },
          },
        ],
      },
    });

  assert.strictEqual(
    injected("Error invoking postMessage: Java object is gone", [
      "app://navigation_performance_logger_android:1:10198",
      "app://navigation_performance_logger_android:1:16565",
    ]),
    null,
    "Android in-app WebView bridge noise must be dropped",
  );
  assert.strictEqual(
    injected("Failed to connect to MetaMask", [
      "app:///scripts/inpage.js:7:84292",
    ]),
    null,
    "browser extension noise must be dropped",
  );
  assert.strictEqual(
    injected(
      "undefined is not an object (evaluating 'window.webkit.messageHandlers.x')",
      [],
    ),
    null,
    "iOS in-app WebView bridge noise must be dropped without frames",
  );
  assert.strictEqual(
    injected("boom", ["chrome-extension://abcdef/contentscript.js:1:1"]),
    null,
    "extension-only stacks must be dropped",
  );

  assert(
    injected("render failed", ["app:///_next/static/chunks/main-abc.js:1:1"]),
    "our own client error must be kept",
  );
  assert(
    injected("Invalid state: Controller is already closed", [
      "node:internal/webstreams/readablestream:1077:13",
    ]),
    "our own server error must be kept",
  );
  assert(
    injected("render failed", [
      "chrome-extension://abcdef/contentscript.js:1:1",
      "app:///_next/static/chunks/main-abc.js:1:1",
    ]),
    "an error that touches our code must be kept even with an extension frame",
  );
  assert(
    beforeSendSentryEvent({ message: "checkout failed" }),
    "an error without frames must be kept",
  );

  console.log("verify-sentry-config: 31/31 passed");
}

main();
