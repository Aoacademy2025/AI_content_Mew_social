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

  // Ops batch 2026-10-12 (HERO-STUDIO-WEB-14): a stack with ONLY injected `app:///executors/`
  // frames (not `_next/`, not ours) must be dropped — `executors/` and `M_ID` appear nowhere
  // in src/public.
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "TypeError: Cannot read properties of undefined (reading 'M_ID')",
      filenames: ["app:///executors/200.js:1:1"],
    }),
    true,
    "WEB-14: a pure app:///executors/ stack must be noise",
  );
  // A stack with an injected app:///executors/ frame AND our own app:///_next/ frame is mixed,
  // so it must be kept — this is the case the broadened rule must not catch too much.
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "TypeError: Cannot read properties of undefined (reading 'M_ID')",
      filenames: [
        "app:///executors/200.js:1:1",
        "app:///_next/static/chunks/main-abc.js:1:1",
      ],
    }),
    false,
    "a mixed app:///executors/ + app:///_next/ stack must be kept",
  );
  // A pure app:///_next/ stack (our own build output, no injected frame at all) must be kept.
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "render failed",
      filenames: ["app:///_next/static/chunks/main-abc.js:1:1"],
    }),
    false,
    "a pure app:///_next/ stack must be kept",
  );
  // WEB-13 shape: our own React warning with our own ./src/ frames — nothing app:/// at all,
  // must stay kept regardless of the broadened app:/// rule above.
  assert.strictEqual(
    isThirdPartyFrontendNoise({
      message: "Maximum update depth exceeded",
      filenames: [
        "./src/app/(dashboard)/video-editor/_v2/Step1Script.tsx:42:11",
      ],
    }),
    false,
    "WEB-13: our own Step1Script.tsx frames must be kept",
  );

  console.log("verify-frontend-error-noise: 15/15 passed");
}

main();
