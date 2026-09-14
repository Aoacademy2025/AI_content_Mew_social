import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  authRecoveryTelemetrySpec,
  fetchWithAuthRecovery,
} from "../src/lib/authenticated-fetch";
import {
  clearAuthSessionEnded,
  isAuthSessionEnded,
} from "../src/lib/auth-session-ended";

type FetchCall = { input: string | URL; init?: RequestInit };

async function main() {
  clearAuthSessionEnded();
  assert.equal(
    authRecoveryTelemetrySpec({ status: "refreshing", path: "/api/notifications", initialStatus: 401 }),
    null,
    "an in-flight refresh is not stored as an error row",
  );
  assert.deepEqual(
    authRecoveryTelemetrySpec({
      status: "recovered",
      path: "/api/notifications",
      initialStatus: 401,
      retryStatus: 200,
    }),
    {
      category: "product",
      status: "done",
      properties: { initialStatus: 401, retryStatus: 200 },
    },
    "a recovered 401 is not an error",
  );
  assert.equal(
    authRecoveryTelemetrySpec({ status: "signed_out", path: "/api/notifications", initialStatus: 401 })?.category,
    "error",
  );

  const calls: FetchCall[] = [];
  let tokenReads = 0;
  const body = JSON.stringify({ topic: "ทดสอบ", durationSec: 60 });
  const recovered = await fetchWithAuthRecovery(
    "/api/scripts/generate",
    { method: "POST", headers: { "Content-Type": "application/json" }, body },
    {
      fetcher: async (input, init) => {
        calls.push({ input, init });
        return new Response(null, { status: calls.length === 1 ? 401 : 200 });
      },
      getFreshToken: async () => {
        tokenReads += 1;
        return "fresh-session-token";
      },
    },
  );

  assert.equal(recovered.status, 200, "a transient 401 recovers on the second request");
  assert.equal(calls.length, 2, "a transient 401 retries exactly once");
  assert.equal(tokenReads, 1, "the retry bypasses Clerk's token cache exactly once");
  assert.equal(calls[1].init?.body, body, "the authenticated replay preserves the request body");
  assert.equal(
    new Headers(calls[1].init?.headers).get("authorization"),
    "Bearer fresh-session-token",
    "the replay sends the refreshed Clerk token",
  );

  let healthyCalls = 0;
  const healthy = await fetchWithAuthRecovery("/api/scripts/generate", undefined, {
    fetcher: async () => {
      healthyCalls += 1;
      return new Response(null, { status: 200 });
    },
    getFreshToken: async () => {
      throw new Error("must not refresh a healthy request");
    },
  });
  assert.equal(healthy.status, 200);
  assert.equal(healthyCalls, 1, "a healthy request is never replayed");

  let missingTokenCalls = 0;
  const stillUnauthorized = await fetchWithAuthRecovery("/api/scripts/generate", undefined, {
    fetcher: async () => {
      missingTokenCalls += 1;
      return new Response(null, { status: 401 });
    },
    getFreshToken: async () => null,
  });
  assert.equal(stillUnauthorized.status, 401);
  assert.equal(missingTokenCalls, 1, "a signed-out session is not put into a retry loop");
  assert.equal(isAuthSessionEnded(), true, "Clerk reporting no token is a terminal signed-out outcome");
  let tokenReadsAfterSignOut = 0;
  let fetchesAfterSignOut = 0;
  const stillEnded = await fetchWithAuthRecovery("/api/notifications", undefined, {
    fetcher: async () => {
      fetchesAfterSignOut += 1;
      return new Response(null, { status: 401 });
    },
    getFreshToken: async () => {
      tokenReadsAfterSignOut += 1;
      return "must-not-refresh-after-sign-out";
    },
  });
  assert.equal(stillEnded.status, 401);
  assert.equal(fetchesAfterSignOut, 1, "a later poll does not retry after signed-out");
  assert.equal(tokenReadsAfterSignOut, 0, "a later poll does not ask Clerk for a token after signed-out");
  clearAuthSessionEnded();

  let failedRefreshCalls = 0;
  const refreshFailure = await fetchWithAuthRecovery("/api/scripts/generate", undefined, {
    fetcher: async () => {
      failedRefreshCalls += 1;
      return new Response(null, { status: 401 });
    },
    getFreshToken: async () => {
      throw new Error("Clerk offline");
    },
  });
  assert.equal(refreshFailure.status, 401, "a refresh failure preserves the original response");
  assert.equal(failedRefreshCalls, 1, "a failed refresh does not issue a blind mutation retry");

  let providerTokenReads = 0;
  const providerAuthFailure = await fetchWithAuthRecovery("/api/elevenlabs/voices", undefined, {
    fetcher: async () => new Response(JSON.stringify({
      code: "ELEVENLABS_KEY_INVALID",
      missingKey: "elevenlabs",
    }), { status: 422, headers: { "Content-Type": "application/json" } }),
    getFreshToken: async () => {
      providerTokenReads += 1;
      return "must-not-be-read";
    },
  });
  assert.equal(providerAuthFailure.status, 422, "provider-key auth failure is not exposed as application 401");
  assert.equal(providerTokenReads, 0, "provider-key auth failure never triggers a Clerk refresh");

  const editorSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/hero-script/_components/ScriptEditorStep.tsx"), "utf8");
  assert.match(editorSource, /import \{ authenticatedFetch \} from "@\/lib\/authenticated-fetch";/);
  assert.match(editorSource, /authenticatedFetch\("\/api\/scripts\/generate"/);
  assert.match(editorSource, /authenticatedFetch\("\/api\/scripts\/regen-section"/);
  assert.match(editorSource, /authenticatedFetch\(`\/api\/scripts\/\$\{scriptId\}\/send-to-editor`/);

  const notificationSource = readFileSync(join(process.cwd(), "src/components/layout/notification-bell.tsx"), "utf8");
  assert.match(notificationSource, /import \{ authenticatedFetch \} from "@\/lib\/authenticated-fetch";/);
  assert.doesNotMatch(notificationSource, /await fetch\((?:"|`)\/api\/notifications/);
  assert.match(notificationSource, /await authenticatedFetch\("\/api\/notifications"/);

  const v2ProjectSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/useV2Project.ts"), "utf8");
  assert.match(v2ProjectSource, /authenticatedFetch\("\/api\/user\/video-settings"/);
  assert.match(v2ProjectSource, /authenticatedFetch\("\/api\/elevenlabs\/voices"/);
  assert.match(v2ProjectSource, /authenticatedFetch\(`\/api\/editor-projects/);
  assert.doesNotMatch(v2ProjectSource, /\bfetch\(/, "Editor V2 authenticated APIs use the recovery wrapper consistently");

  const elevenLabsVoicesRoute = readFileSync(
    join(process.cwd(), "src/app/api/elevenlabs/voices/route.ts"),
    "utf8",
  );
  assert.match(elevenLabsVoicesRoute, /code: "ELEVENLABS_KEY_INVALID"/);
  assert.match(elevenLabsVoicesRoute, /missingKey: "elevenlabs"/);
  assert.match(elevenLabsVoicesRoute, /\{ status: 422 \}/);

  const creditsSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_hooks/useCreditsQuota.ts"), "utf8");
  assert.match(creditsSource, /authenticatedFetch\("\/api\/payments\/credits"/);

  console.log("auth recovery verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
