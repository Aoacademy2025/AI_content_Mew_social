"use client";

import { authenticatedFetch } from "@/lib/authenticated-fetch";

export type ClientJsonResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CacheEntry = {
  settled: boolean;
  expiresAt: number;
  promise: Promise<ClientJsonResult<unknown>>;
};

type ClientRequestCacheOptions = {
  fetcher?: Fetcher;
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 750;
const responseCache = new Map<string, CacheEntry>();

function cacheKey(input: string | URL, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  return `${method}:${String(input)}`;
}

export function clearClientJsonCache(input?: string | URL): void {
  if (input === undefined) {
    responseCache.clear();
    return;
  }
  const suffix = `:${String(input)}`;
  for (const key of responseCache.keys()) {
    if (key.endsWith(suffix)) responseCache.delete(key);
  }
}

/**
 * Coalesces concurrent authenticated GETs and keeps the parsed response for a
 * sub-second remount window. Errors are never cached. The deliberately short
 * TTL removes request bursts without turning quota/credit data into an
 * application-level stale cache.
 */
export function fetchClientJson<T>(
  input: string | URL,
  init?: RequestInit,
  options: ClientRequestCacheOptions = {},
): Promise<ClientJsonResult<T>> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("fetchClientJson only supports GET requests");

  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
  const key = cacheKey(input, init);
  const cached = responseCache.get(key);
  if (cached && (!cached.settled || cached.expiresAt >= now())) {
    return cached.promise as Promise<ClientJsonResult<T>>;
  }
  if (cached) responseCache.delete(key);

  const fetcher = options.fetcher ?? authenticatedFetch;
  let entry: CacheEntry;
  const promise = fetcher(input, init)
    .then(async (response): Promise<ClientJsonResult<unknown>> => {
      const data = await response.json().catch(() => null) as unknown;
      if (responseCache.get(key) === entry) {
        if (response.ok) {
          entry.settled = true;
          entry.expiresAt = now() + ttlMs;
        } else {
          responseCache.delete(key);
        }
      }
      return { ok: response.ok, status: response.status, data };
    })
    .catch((error) => {
      if (responseCache.get(key) === entry) responseCache.delete(key);
      throw error;
    });
  entry = { settled: false, expiresAt: 0, promise };
  responseCache.set(key, entry);
  return promise as Promise<ClientJsonResult<T>>;
}
