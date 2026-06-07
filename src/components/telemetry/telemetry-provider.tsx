"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/client-telemetry";

type PerformanceEntryWithValue = PerformanceEntry & {
  value?: number;
  hadRecentInput?: boolean;
  startTime: number;
  duration: number;
};

function supportedEntry(type: string) {
  return typeof PerformanceObserver !== "undefined"
    && Array.isArray(PerformanceObserver.supportedEntryTypes)
    && PerformanceObserver.supportedEntryTypes.includes(type);
}

export function TelemetryProvider() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;

    trackEvent("page_viewed", {
      category: "product",
      path: pathname,
      properties: { title: document.title },
    });

    if (pathname === "/video-editor") {
      trackEvent("editor_opened", {
        category: "product",
        path: pathname,
        properties: { page: "Video Editor" },
      });
    }
  }, [pathname]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      trackEvent("frontend_error", {
        category: "error",
        status: "error",
        properties: {
          message: event.message,
          source: event.filename?.split("/").pop(),
          line: event.lineno,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "");
      trackEvent("frontend_error", {
        category: "error",
        status: "error",
        properties: { message: reason || "Unhandled promise rejection" },
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    const observers: PerformanceObserver[] = [];
    let lcp = 0;
    let cls = 0;
    let inp = 0;

    const flushVitals = () => {
      if (lcp > 0) trackEvent("web_vital", { category: "performance", value: Math.round(lcp), properties: { metric: "LCP" } });
      if (cls > 0) trackEvent("web_vital", { category: "performance", value: Number(cls.toFixed(4)), properties: { metric: "CLS" } });
      if (inp > 0) trackEvent("web_vital", { category: "performance", value: Math.round(inp), properties: { metric: "INP" } });
    };

    try {
      if (supportedEntry("largest-contentful-paint")) {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const latest = entries[entries.length - 1];
          if (latest) lcp = latest.startTime;
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
        observers.push(lcpObserver);
      }

      if (supportedEntry("layout-shift")) {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceEntryWithValue[]) {
            if (!entry.hadRecentInput) cls += Number(entry.value ?? 0);
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
        observers.push(clsObserver);
      }

      if (supportedEntry("event")) {
        const inpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceEntryWithValue[]) {
            if (entry.duration > inp) inp = entry.duration;
          }
        });
        inpObserver.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
        observers.push(inpObserver);
      }
    } catch {
      return undefined;
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushVitals();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushVitals);
    return () => {
      flushVitals();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushVitals);
      observers.forEach((observer) => observer.disconnect());
    };
  }, []);

  return null;
}
