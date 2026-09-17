/**
 * Third-party browser noise shared by Sentry `beforeSend` and first-party
 * `frontend_error` telemetry. One rule, two capture points — so insights cannot
 * keep writing rows that Sentry already drops.
 *
 * Never treat Clerk SDK-load or sign-in/sign-up failures as noise. Those leave
 * the visitor without auth and must stay visible.
 */

export const FOREIGN_BROWSER_API =
  /(?:Failed to connect to MetaMask|Java object is gone|Java exception was raised during method invocation|window\.webkit\.messageHandlers)/i;

export const INJECTED_FRAME_ORIGIN =
  /^(?:(?:chrome|moz|safari-web|safari|ms-browser)-extension:\/\/|webkit-masked-url:|app:\/\/[^/]|app:\/\/\/scripts\/)/i;

export const APP_FRAME = /(?:\/?_next\/|\.next\/|^node:|\.tsx?(?::\d+)*$)/i;

const PROTECTED_AUTH_FAILURE =
  /failed_to_load_clerk_js|Failed to load Clerk JS|\/v1\/client\/sign_ins|\/v1\/client\/sign_ups/i;

export function isProtectedFrontendAuthError(text: string): boolean {
  return PROTECTED_AUTH_FAILURE.test(text);
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
  stack?: string | null;
  filenames?: readonly string[] | null;
}): boolean {
  const message = String(input.message ?? "");
  if (isProtectedFrontendAuthError(message)) return false;
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
