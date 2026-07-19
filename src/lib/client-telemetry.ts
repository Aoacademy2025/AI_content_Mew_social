"use client";

import {
  redactTelemetryString,
  TELEMETRY_MAX_STRING,
  TELEMETRY_SECRET_KEY_RE,
  telemetryStringLimit,
} from "@/lib/telemetry-sanitize";

type TelemetryCategory = "product" | "pipeline" | "performance" | "error";
type TelemetryStatus = "started" | "done" | "error" | "running" | "skip" | "info";

type TelemetryOptions = {
  category?: TelemetryCategory;
  path?: string;
  step?: string;
  status?: TelemetryStatus | string;
  durationMs?: number;
  value?: number;
  properties?: Record<string, unknown> | null;
};

const SESSION_KEY = "heroTelemetrySessionId";

function hasBrowser() {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

function browserStorage() {
  if (!hasBrowser()) return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function getTelemetrySessionId() {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const existing = storage.getItem(SESSION_KEY);
    if (existing) return existing;
    const next = createSessionId();
    storage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function cleanValue(value: unknown, depth = 0, propertyKey?: string): unknown {
  if (depth > 2) return "[trimmed]";
  if (value == null) return value;
  if (typeof value === "string") {
    return redactTelemetryString(value).slice(0, telemetryStringLimit(propertyKey));
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => cleanValue(item, depth + 1, propertyKey));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      output[key] = TELEMETRY_SECRET_KEY_RE.test(key) ? "[redacted]" : cleanValue(nestedValue, depth + 1, key);
    }
    return output;
  }
  return String(value).slice(0, Math.min(160, TELEMETRY_MAX_STRING));
}

export function sanitizeClientTelemetryProperties(properties?: Record<string, unknown> | null) {
  if (!properties || typeof properties !== "object") return null;
  return cleanValue(properties) as Record<string, unknown>;
}

export function trackEvent(name: string, options: TelemetryOptions = {}) {
  if (!hasBrowser() || !name) return;

  const payload = {
    sessionId: getTelemetrySessionId(),
    name,
    category: options.category ?? "product",
    source: "client",
    path: options.path ?? window.location.pathname,
    step: options.step,
    status: options.status,
    durationMs: Number.isFinite(options.durationMs) ? Math.max(0, Math.round(options.durationMs ?? 0)) : undefined,
    value: Number.isFinite(options.value) ? options.value : undefined,
    properties: sanitizeClientTelemetryProperties(options.properties),
  };

  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/telemetry", blob)) return;
    }

    void fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry must never block the creator workflow.
  }
}
