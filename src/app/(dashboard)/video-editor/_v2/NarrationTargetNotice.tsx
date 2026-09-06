"use client";

import { narrationTargetFeedback } from "@/lib/hero-script-duration";

/** An advisory estimate only; changing text/voice never creates audio here. */
export function NarrationTargetNotice(props: Parameters<typeof narrationTargetFeedback>[0]) {
  const feedback = narrationTargetFeedback(props);
  if (!feedback) return null;
  return (
    <p role="status" className="mb-3 rounded-lg border px-3 py-2 text-xs leading-relaxed"
      style={{ color: "var(--ui-text-muted, #666)", borderColor: "rgba(128,128,128,.3)" }}>
      {feedback.message}
    </p>
  );
}
