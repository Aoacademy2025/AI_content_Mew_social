import assert from "assert";

import { isProtectedFrontendAuthError, isThirdPartyFrontendNoise } from "../src/lib/frontend-error-noise";

function main() {
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "Error invoking postMessage: Java object is gone",
      filenames: ["app://navigation_performance_logger_android:1:10198"],
    }),
    true,
    "Android WebView bridge must be noise",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({ message: "Failed to connect to MetaMask" }),
    true,
    "MetaMask must be noise even without frames",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "undefined is not an object (evaluating 'window.webkit.messageHandlers.x')",
    }),
    true,
    "iOS webkit bridge must be noise",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "boom",
      filenames: ["chrome-extension://abcdef/contentscript.js:1:1"],
    }),
    true,
    "extension-only stacks must be noise",
  );

  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "render failed",
      filenames: ["app:///_next/static/chunks/main-abc.js:1:1"],
    }),
    false,
    "our own client error must be kept",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "render failed",
      filenames: [
        "chrome-extension://abcdef/contentscript.js:1:1",
        "app:///_next/static/chunks/main-abc.js:1:1",
      ],
    }),
    false,
    "a mixed stack that touches our code must be kept",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "render failed",
      stack: "Error: render failed | at app:///_next/static/chunks/main-abc.js:1:1 | at chrome-extension://abcdef/contentscript.js:1:1",
    }),
    false,
    "telemetry stack snippets must keep mixed frames the same way",
  );

  assert.strictEqual(
    isProtectedFrontendAuthError("Clerk: Failed to load Clerk JS, failed to load script"),
    true,
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "Clerk: Failed to load Clerk JS, failed to load script: https://clerk.example/npm/@clerk/clerk-js@6",
    }),
    false,
    "failed_to_load_clerk_js must never be dropped",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: 'ClerkJS: Network error at "https://clerk.studio.example.com/v1/client/sign_ins/sia_abc/attempt"',
    }),
    false,
    "a failed sign-in must never be dropped",
  );
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: 'ClerkJS: Network error at "https://clerk.studio.example.com/v1/client/sign_ups"',
    }),
    false,
    "a failed sign-up must never be dropped",
  );

  console.log("verify-frontend-error-noise: 11/11 passed");
}

main();
