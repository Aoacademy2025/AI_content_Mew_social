"use client";

import { useCallback, useState } from "react";
import type { HeygenAvatar } from "../_v2/avatar-filter";

/**
 * Lazy loader for the user's OWN HeyGen avatars (GET /api/heygen/my-avatars — their avatar
 * groups → looks, ~2s). Mirrors the useBgm pattern. Maps the route's HTTP statuses to a
 * typed error so the picker can show the right message:
 *   400 → no-key · 403 → not-paid · 401 → bad-key · other → failed.
 */

export type HeygenAvatarsError = "no-key" | "not-paid" | "bad-key" | "failed";

export function useHeygenAvatars() {
  const [avatars, setAvatars] = useState<HeygenAvatar[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<HeygenAvatarsError | null>(null);
  const [stale, setStale] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/heygen/my-avatars");
      if (res.status === 400) { setError("no-key"); setAvatars([]); return; }
      if (res.status === 403) { setError("not-paid"); setAvatars([]); return; }
      if (res.status === 401) { setError("bad-key"); setAvatars([]); return; }
      if (!res.ok) { setError("failed"); setAvatars([]); return; }
      const d = await res.json().catch(() => null);
      setAvatars(Array.isArray(d?.avatars) ? (d.avatars as HeygenAvatar[]) : []);
      setStale(!!d?.stale);
      setLoaded(true);
    } catch {
      setError("failed");
      setAvatars([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy: fetch on first open. After a success it's a no-op (cached); after an
  // error `loaded` stays false so reopening retries (e.g. once the key is fixed).
  const load = useCallback(() => {
    if (loaded || loading) return;
    void fetchList();
  }, [loaded, loading, fetchList]);

  const reload = useCallback(() => { void fetchList(); }, [fetchList]);

  return { avatars, loading, loaded, error, stale, load, reload };
}
