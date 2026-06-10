"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface FadeSwapProps {
  ready: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  /** Minimum time to show skeleton even if ready instantly (ms). Prevents flicker on fast loads. */
  minSkeletonMs?: number;
  className?: string;
}

/**
 * Crossfade between a skeleton and real content.
 * - Skeleton fades out, content fades in (240ms each, overlapped).
 * - `minSkeletonMs` (default 250) keeps skeleton visible long enough to feel smooth.
 */
export function FadeSwap({ ready, skeleton, children, minSkeletonMs = 250, className }: FadeSwapProps) {
  // If ready on first render, skip the skeleton entirely — happens on client-side
  // route changes where the data was already loaded before this component mounted.
  const [showContent, setShowContent] = useState(ready);
  const [removeSkeleton, setRemoveSkeleton] = useState(ready);
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!ready) {
      setShowContent(false);
      setRemoveSkeleton(false);
      return;
    }
    // Already shown — nothing to schedule
    if (showContent && removeSkeleton) return;
    const elapsed = Date.now() - mountedAt;
    const wait = Math.max(0, minSkeletonMs - elapsed);
    const t1 = setTimeout(() => setShowContent(true), wait);
    // Remove skeleton from DOM after fade completes so it doesn't block clicks
    const t2 = setTimeout(() => setRemoveSkeleton(true), wait + 280);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, minSkeletonMs, mountedAt]);

  return (
    <div className={cn("relative", className)}>
      {!removeSkeleton && (
        <div
          aria-hidden
          className={cn(
            "transition-opacity duration-300 ease-out",
            showContent ? "opacity-0 pointer-events-none" : "opacity-100"
          )}
          style={{ position: showContent ? "absolute" : "relative", inset: 0 }}
        >
          {skeleton}
        </div>
      )}
      <div
        className={cn(
          "transition-opacity duration-300 ease-out",
          showContent ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
      >
        {children}
      </div>
    </div>
  );
}
