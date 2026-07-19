import { prisma } from "@/lib/prisma";
import {
  redactTelemetryString,
  TELEMETRY_MAX_PROPERTIES_BYTES,
  TELEMETRY_MAX_STRING,
  TELEMETRY_SECRET_KEY_RE,
  telemetryStringLimit,
} from "@/lib/telemetry-sanitize";

export type TelemetryInput = {
  name: string;
  category?: "product" | "pipeline" | "performance" | "error";
  source?: "client" | "server";
  sessionId?: string | null;
  path?: string | null;
  step?: string | null;
  status?: string | null;
  durationMs?: number | null;
  value?: number | null;
  properties?: Record<string, unknown> | null;
};

const MAX_EVENTS = 20;

function cleanString(value: unknown, max = TELEMETRY_MAX_STRING): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  return v.slice(0, max);
}

function cleanNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function cleanFloat(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function serializeTelemetryProperties(properties: unknown): string | null {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;

  const cleaned: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(properties as Record<string, unknown>)) {
    const key = cleanString(rawKey, 64);
    if (!key || TELEMETRY_SECRET_KEY_RE.test(key)) continue;

    if (typeof rawValue === "string") {
      // Stack strings commonly contain harmless identifiers such as useSession or
      // tokenizer; key-name filtering is the reliable privacy boundary here. Preserve
      // enough stack to identify the failing component while retaining a hard cap.
      const isErrorStack = key === "stack" || key === "componentStack";
      const value = redactTelemetryString(rawValue).slice(0, telemetryStringLimit(key));
      if (!isErrorStack && TELEMETRY_SECRET_KEY_RE.test(value)) continue;
      const candidate = JSON.stringify({ ...cleaned, [key]: value });
      if (Buffer.byteLength(candidate, "utf8") <= TELEMETRY_MAX_PROPERTIES_BYTES) cleaned[key] = value;
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      const candidate = JSON.stringify({ ...cleaned, [key]: rawValue });
      if (Buffer.byteLength(candidate, "utf8") <= TELEMETRY_MAX_PROPERTIES_BYTES) cleaned[key] = rawValue;
    } else if (typeof rawValue === "boolean" || rawValue === null) {
      const candidate = JSON.stringify({ ...cleaned, [key]: rawValue });
      if (Buffer.byteLength(candidate, "utf8") <= TELEMETRY_MAX_PROPERTIES_BYTES) cleaned[key] = rawValue;
    }
  }

  const json = JSON.stringify(cleaned);
  if (json === "{}") return null;
  return json;
}

export function normalizeTelemetry(input: unknown): TelemetryInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = cleanString(raw.name, 96);
  if (!name || !/^[a-z0-9_.:-]+$/i.test(name)) return null;

  const category = cleanString(raw.category, 32);
  const source = cleanString(raw.source, 32);
  const durationMs = cleanNumber(raw.durationMs);

  return {
    name,
    category: category === "pipeline" || category === "performance" || category === "error" ? category : "product",
    source: source === "server" ? "server" : "client",
    sessionId: cleanString(raw.sessionId, 120),
    path: cleanString(raw.path, 160),
    step: cleanString(raw.step, 64),
    status: cleanString(raw.status, 32),
    durationMs: durationMs != null && durationMs >= 0 ? durationMs : null,
    value: cleanFloat(raw.value),
    properties: raw.properties && typeof raw.properties === "object" ? (raw.properties as Record<string, unknown>) : null,
  };
}

export function normalizeTelemetryBatch(payload: unknown): TelemetryInput[] {
  const rawEvents = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown[] }).events)
      ? (payload as { events: unknown[] }).events
      : [payload];

  return rawEvents.slice(0, MAX_EVENTS).map(normalizeTelemetry).filter(Boolean) as TelemetryInput[];
}

export async function recordTelemetryEvent(userId: string | null, input: TelemetryInput) {
  return prisma.telemetryEvent.create({
    data: {
      userId,
      sessionId: input.sessionId ?? null,
      name: input.name,
      category: input.category ?? "product",
      source: input.source ?? "client",
      path: input.path ?? null,
      step: input.step ?? null,
      status: input.status ?? null,
      durationMs: input.durationMs ?? null,
      value: input.value ?? null,
      properties: serializeTelemetryProperties(input.properties),
    },
  });
}

export async function recordTelemetryBatch(userId: string | null, events: TelemetryInput[]) {
  if (events.length === 0) return { count: 0 };
  await prisma.telemetryEvent.createMany({
    data: events.map((event) => ({
      userId,
      sessionId: event.sessionId ?? null,
      name: event.name,
      category: event.category ?? "product",
      source: event.source ?? "client",
      path: event.path ?? null,
      step: event.step ?? null,
      status: event.status ?? null,
      durationMs: event.durationMs ?? null,
      value: event.value ?? null,
      properties: serializeTelemetryProperties(event.properties),
    })),
  });
  return { count: events.length };
}
