"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { onCLS, onINP, onLCP } from "web-vitals";
import { trackEvent } from "@/lib/client-telemetry";
import { isThirdPartyFrontendNoise } from "@/lib/frontend-error-noise";
import { createWebVitalReporter } from "@/lib/web-vitals-telemetry";

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
      if (isThirdPartyFrontendNoise({ message, stack, filenames: event.filename ? [event.filename] : [] })) {
        return;
      }
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
      if (isThirdPartyFrontendNoise({ message, stack })) {
        return;
      }
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
    const vitalsPath = vitalsPathRef.current ?? window.location.pathname;
    const navigationId = navigationIdRef.current ?? (
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `nav_${Math.round(performance.timeOrigin)}_${Math.random().toString(36).slice(2)}`
    );
    navigationIdRef.current = navigationId;
    const report = createWebVitalReporter(vitalsPath, navigationId, (event) => {
      trackEvent("web_vital", {
        category: "performance",
        path: event.path,
        value: event.value,
        properties: event.properties,
      });
    });

    // The library owns CLS session windows, INP interaction selection, BFCache and lifecycle reports.
    // Repeated lifecycle callbacks are idempotent in the reporter and aggregation boundary.
    onLCP(report, { reportAllChanges: true });
    onCLS(report, { reportAllChanges: true });
    onINP(report, { reportAllChanges: true });
  }, []);

  return null;
}
