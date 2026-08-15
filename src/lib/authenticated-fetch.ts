"use client";

import { getToken } from "@clerk/nextjs";
import { trackEvent } from "@/lib/client-telemetry";

type FetchInput = string | URL;
type Fetcher = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export type AuthRecoveryEvent =
  | { status: "refreshing"; path: string; initialStatus: 401 }
  | { status: "recovered" | "retry_failed"; path: string; initialStatus: 401; retryStatus: number }
  | { status: "signed_out" | "refresh_failed"; path: string; initialStatus: 401 };

type AuthRecoveryDependencies = {
  fetcher: Fetcher;
  getFreshToken: () => Promise<string | null>;
  onEvent?: (event: AuthRecoveryEvent) => void;
};

function telemetryPath(input: FetchInput): string {
  const raw = String(input);
  try {
    return new URL(raw, "https://local.invalid").pathname;
  } catch {
    return raw.split("?", 1)[0].slice(0, 160);
  }
}

function emit(deps: AuthRecoveryDependencies, event: AuthRecoveryEvent) {
  try { deps.onEvent?.(event); } catch { /* recovery must not depend on telemetry */ }
}

/**
 * Replays one same-origin request after a forced Clerk token refresh when the
 * server rejects the first attempt with 401. Callers pass replayable bodies
 * (JSON strings/FormData), never a consumed Request stream.
 *
 * A 401 from our authenticated API routes is emitted before route side
 * effects, so this narrow retry does not blindly replay provider failures or
 * arbitrary 5xx responses. There is no third attempt and no retry when Clerk
 * reports that the user is signed out.
 */
export async function fetchWithAuthRecovery(
  input: FetchInput,
  init: RequestInit | undefined,
  deps: AuthRecoveryDependencies,
): Promise<Response> {
  const initial = await deps.fetcher(input, init);
  if (initial.status !== 401) return initial;

  const path = telemetryPath(input);
  emit(deps, { status: "refreshing", path, initialStatus: 401 });

  let token: string | null;
  try {
    token = await deps.getFreshToken();
  } catch {
    emit(deps, { status: "refresh_failed", path, initialStatus: 401 });
    return initial;
  }
  if (!token) {
    emit(deps, { status: "signed_out", path, initialStatus: 401 });
    return initial;
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const retry = await deps.fetcher(input, { ...init, headers });
  emit(deps, {
    status: retry.ok ? "recovered" : "retry_failed",
    path,
    initialStatus: 401,
    retryStatus: retry.status,
  });
  return retry;
}

/** Browser-facing wrapper used only for authenticated application APIs. */
export function authenticatedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  return fetchWithAuthRecovery(input, init, {
    fetcher: (requestInput, requestInit) => fetch(requestInput, requestInit),
    getFreshToken: () => getToken({ skipCache: true }),
    onEvent: (event) => {
      trackEvent("auth_request_recovery", {
        category: event.status === "recovered" ? "product" : "error",
        path: event.path,
        step: "session_refresh",
        status: event.status === "recovered" ? "done" : event.status,
        properties: {
          initialStatus: event.initialStatus,
          ...(event.status === "recovered" || event.status === "retry_failed"
            ? { retryStatus: event.retryStatus }
            : {}),
        },
      });
    },
  });
}
