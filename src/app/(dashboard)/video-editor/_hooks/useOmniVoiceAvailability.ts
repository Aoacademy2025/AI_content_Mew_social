"use client";

import { useEffect, useState } from "react";
import { OMNIVOICE_UI_ENABLED } from "@/lib/tts-providers";

/** Per-account + live-worker UI gate. null means the canary check is in flight. */
export function useOmniVoiceAvailability(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(OMNIVOICE_UI_ENABLED ? null : false);

  useEffect(() => {
    if (!OMNIVOICE_UI_ENABLED) return;
    let alive = true;
    fetch("/api/omnivoice/status", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((status) => { if (alive) setAvailable(status?.enabled === true); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, []);

  return available;
}
