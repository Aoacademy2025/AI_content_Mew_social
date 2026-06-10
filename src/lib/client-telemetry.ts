"use client";

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
const SECRET_KEY_RE = /(api.?key|token|secret|password|authorization|stripe|webhook|cookie|session)/i;

function hasBrowser() {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function getTelemetrySessionId() {
  if (!hasBrowser()) return null;
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const next = createSessionId();
    localStorage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function cleanValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return "[trimmed]";
  if (value == null) return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => cleanValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      output[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : cleanValue(nestedValue, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 160);
}

function cleanProperties(properties?: Record<string, unknown> | null) {
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
    properties: cleanProperties(options.properties),
  };

  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/telemetry", blob);
      return;
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
