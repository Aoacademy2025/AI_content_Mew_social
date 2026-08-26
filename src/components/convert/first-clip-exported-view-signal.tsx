"use client";

import { useEffect } from "react";
import { emitFirstClipExportedView } from "@/lib/first-clip-convert-events";

/**
 * Renders nothing; announces "the exported clip is on screen".
 *
 * A component (not a bare hook) so the Editor's exported views — which are
 * conditional early returns — can signal without breaking the rules of hooks.
 */
export function FirstClipExportedViewSignal() {
  useEffect(() => {
    emitFirstClipExportedView();
  }, []);
  return null;
}
