/**
 * Third-party browser noise and routine client AbortController teardown shared
 * by Sentry `beforeSend` and first-party `frontend_error` telemetry. One rule,
 * two capture points — so insights cannot keep writing rows that Sentry already drops.
 *
 * Never treat Clerk SDK-load or sign-in/sign-up failures as noise. Those leave
 * the visitor without auth and must stay visible.
 */

export const FOREIGN_BROWSER_API =
  /(?:Failed to connect to MetaMask|Java object is gone|Java exception was raised during method invocation|window\.webkit\.messageHandlers|\bEmptyRanges\b)/i;

// HERO-89 (HERO-STUDIO-WEB-20/21/1Z/1V/1W/1T/1S): routine browser AbortController.abort()
// during job poll completion (`stopPolling()`), autosave timeout/cancelation, or React
// `useEffect` unmount cleanup surfaces in some browsers as an unhandled rejection with
// the standard DOMException AbortError message.
export const ROUTINE_BROWSER_ABORT_ERROR =
  /(?:^|\bAbortError:\s*)(?:signal is aborted without reason|The user aborted a request\.?|The operation was aborted\.?|Fetch is aborted\.?)(?:\s*$)/i;

// Ops batch 2026-10-12 (HERO-STUDIO-WEB-14, 1,563 events since 09-25): `app:///scripts/` was
// the only triple-slash path treated as injected, so a stack with ONLY `app:///executors/
// 200.js` frames (functions `E`/`Y`; `executors/` and the error's `M_ID` field appear nowhere
// in src/public — it is not ours) was kept, not dropped. Any `app:///` path that is NOT ours
// is injected: broadened to every `app:///` path except `app:///_next/` (our own build
// output — matched by APP_FRAME below too, so a mixed stack still keeps an event).
export const INJECTED_FRAME_ORIGIN =
  /^(?:(?:chrome|moz|safari-web|safari|ms-browser)-extension:\/\/|webkit-masked-url:|app:\/\/[^/]|app:\/\/\/(?!_next\/))/i;

// `/npm/` (e.g. `app:///npm/@clerk/clerk-js@6.31.0/dist/clerk.browser.js`) is the source-map
// path convention for a dependency bundled INTO our own build — ours, not an injected script,
// even though it is not under `_next/`. Needed so the broadened INJECTED_FRAME_ORIGIN above
// does not start treating Clerk's own SDK frames as injected (a non-network-error Clerk
// failure using those exact frames must stay reported — see verify-sentry-config.ts).
export const APP_FRAME = /(?:\/?_next\/|\.next\/|^node:|\/npm\/|\.tsx?(?::\d+)*$)/i;

const PROTECTED_AUTH_FAILURE =
  /failed_to_load_clerk_js|Failed to load Clerk JS|\/v1\/client\/sign_ins|\/v1\/client\/sign_ups/i;

export function isProtectedFrontendAuthError(text: string): boolean {
  return PROTECTED_AUTH_FAILURE.test(text);
}

export function isRoutineBrowserAbortNoise(input: {
  message?: string | null;
  type?: string | null;
}): boolean {
  const message = String(input.message ?? "").trim();
  const type = String(input.type ?? "").trim();
  const combined = type ? `${type}: ${message}` : message;
  if (isProtectedFrontendAuthError(combined)) return false;
  return (
    ROUTINE_BROWSER_ABORT_ERROR.test(message) ||
    ROUTINE_BROWSER_ABORT_ERROR.test(combined)
  );
}

function filenamesFromStack(stack: string | null | undefined): string[] {
  if (!stack) return [];
  const names: string[] = [];
  for (const line of stack.split(/\s+\|\s+|\n/)) {
    const match = line.match(
      /((?:chrome|moz|safari-web|safari|ms-browser)-extension:\/\/[^\s)\]>'"]+|webkit-masked-url:[^\s)\]>'"]+|app:\/\/[^\s)\]>'"]+|https?:\/\/[^\s)\]>'"]+|\/_next\/[^\s)\]>'"]+)/i,
    );
    if (match) names.push(match[1]);
  }
  return names;
}

export function isThirdPartyFrontendNoise(input: {
  message?: string | null;
  type?: string | null;
  stack?: string | null;
  filenames?: readonly string[] | null;
}): boolean {
  const message = String(input.message ?? "");
  if (isProtectedFrontendAuthError(message)) return false;
  if (isRoutineBrowserAbortNoise({ message, type: input.type })) return true;
  if (FOREIGN_BROWSER_API.test(message)) return true;

  const filenames = [
    ...(input.filenames ?? []),
    ...filenamesFromStack(input.stack),
  ];
  if (filenames.length === 0) return false;

  return (
    filenames.some((name) => INJECTED_FRAME_ORIGIN.test(name)) &&
    !filenames.some((name) => APP_FRAME.test(name))
  );
}
