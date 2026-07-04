"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Slim top-of-page progress bar that animates whenever the pathname changes.
 * Only listens to pathname (not searchParams) to avoid forcing the whole tree
 * into dynamic rendering on every page.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const firstRenderRef = useRef(true);

  useEffect(() => {
    // Skip the first render so the bar doesn't flash on initial page load
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }

    setVisible(true);
    setProgress(15);

    const t1 = setTimeout(() => setProgress(70), 80);
    const t2 = setTimeout(() => setProgress(95), 220);
    const t3 = setTimeout(() => setProgress(100), 380);
    const t4 = setTimeout(() => { setVisible(false); setProgress(0); }, 600);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [pathname]);

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 9999,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 200ms ease-out",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "linear-gradient(90deg, hsl(258 90% 66%), hsl(252 83% 60%))",
          boxShadow: "0 0 8px hsl(252 83% 60% / 0.6)",
          transition: "width 280ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      />
    </div>
  );
}
