"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { onCLS, onINP, onLCP } from "web-vitals";
import { trackEvent, trackEventsBatch } from "@/lib/client-telemetry";
import { isThirdPartyFrontendNoise } from "@/lib/frontend-error-noise";
import {
  createWebVitalReporter,
  parseWebVitalSampleRate,
  shouldSampleWebVital,
  type WebVitalTelemetryEvent,
} from "@/lib/web-vitals-telemetry";

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
      const errorName = event.error instanceof Error ? event.error.name : "ErrorEvent";
      const stack = stackSnippet(event.error);
      if (isThirdPartyFrontendNoise({ type: errorName, message, stack, filenames: event.filename ? [event.filename] : [] })) {
        return;
      }
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
      if (isThirdPartyFrontendNoise({ type: errorName, message, stack })) {
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

    // HERO-128: sample document navigations deterministically (default 20%) and
    // batch settled LCP/CLS/INP reports into a single beacon instead of writing
    // every intermediate change as its own SQLite transaction.
    const sampleRate = parseWebVitalSampleRate(process.env.NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE);
    if (!shouldSampleWebVital(navigationId, sampleRate)) return;

    const pending: WebVitalTelemetryEvent[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      trackEventsBatch(
        batch.map((event) => ({
          name: "web_vital",
          options: {
            category: "performance",
            path: event.path,
            value: event.value,
            properties: event.properties,
          },
        })),
      );
    };

    const report = createWebVitalReporter(vitalsPath, navigationId, (event) => {
      pending.push(event);
      if (pending.length >= 3) flush();
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Final settled lifecycle reports only (default reportAllChanges=false so each
    // document emits at most one LCP, CLS, and INP instead of 10-15 intermediate updates).
    onLCP(report);
    onCLS(report);
    onINP(report);

    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
