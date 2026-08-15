"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/client-telemetry";
import { createWebVitalsAccumulator } from "@/lib/web-vitals-telemetry";

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

function errorSignature(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function stackSnippet(error: unknown) {
  return error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(0, 12).join(" | ").slice(0, 2_048)
    : null;
}

export function TelemetryProvider() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);
  const vitalsPathRef = useRef<string | null>(pathname);
  const navigationIdRef = useRef<string | null>(null);

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
      const message = event.message || "Window error";
      const stack = stackSnippet(event.error);
      const errorName = event.error instanceof Error ? event.error.name : "ErrorEvent";
      trackEvent("frontend_error", {
        category: "error",
        status: "error",
        properties: {
          message,
          errorName,
          signature: errorSignature(`${errorName}:${message}:${event.filename}:${event.lineno}:${event.colno}:${stack ?? ""}`),
          source: event.filename?.split("/").pop(),
          line: event.lineno,
          column: event.colno,
          stack,
          path: window.location.pathname,
          isRangeError: event.error instanceof RangeError || /Maximum call stack size exceeded/i.test(message),
          userAgent: navigator.userAgent,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "");
      const errorName = event.reason instanceof Error ? event.reason.name : "UnhandledRejection";
      const stack = stackSnippet(event.reason);
      const message = reason || "Unhandled promise rejection";
      trackEvent("frontend_error", {
        category: "error",
        status: "error",
        properties: {
          message,
          errorName,
          signature: errorSignature(`${errorName}:${message}:${stack ?? ""}`),
          stack,
          path: window.location.pathname,
          isRangeError: event.reason instanceof RangeError || /Maximum call stack size exceeded/i.test(message),
          userAgent: navigator.userAgent,
        },
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
    const vitals = createWebVitalsAccumulator();
    const vitalsPath = vitalsPathRef.current ?? window.location.pathname;
    const navigationId = navigationIdRef.current ?? (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `nav_${Math.round(performance.timeOrigin)}_${Math.random().toString(36).slice(2)}`
    );
    navigationIdRef.current = navigationId;

    const flushVitals = () => {
      for (const emission of vitals.flush()) {
        trackEvent("web_vital", {
          category: "performance",
          path: vitalsPath,
          value: emission.value,
          properties: {
            metric: emission.metric,
            navigationId,
            scope: "document",
          },
        });
      }
    };

    try {
      if (supportedEntry("largest-contentful-paint")) {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const latest = entries[entries.length - 1];
          if (latest) vitals.recordLcp(latest.startTime);
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
        observers.push(lcpObserver);
      }

      if (supportedEntry("layout-shift")) {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceEntryWithValue[]) {
            if (!entry.hadRecentInput) vitals.recordCls(Number(entry.value ?? 0));
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
        observers.push(clsObserver);
      }

      if (supportedEntry("event")) {
        const inpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceEntryWithValue[]) {
            vitals.recordInp(entry.duration);
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
