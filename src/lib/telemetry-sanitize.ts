/** Browser-safe telemetry privacy/size policy shared by collection and ingestion. */
export const TELEMETRY_MAX_STRING = 240;
export const TELEMETRY_MAX_ERROR_STRING = 2_048;
export const TELEMETRY_MAX_PROPERTIES_BYTES = 4_000;

export const TELEMETRY_SECRET_KEY_RE = /(api.?key|token|secret|password|authorization|stripe|webhook|cookie|session)/i;

const INLINE_SECRET_RE = /((?:api.?key|token|secret|password|authorization|stripe|webhook|cookie|session)\s*(?:=|:|%3d)\s*)([^&\s|,;"')]+)/gi;
const BEARER_SECRET_RE = /(bearer\s+)([a-z0-9._~+\/-]+=*)/gi;

export function telemetryStringLimit(propertyKey?: string): number {
  return propertyKey === "stack" || propertyKey === "componentStack"
    ? TELEMETRY_MAX_ERROR_STRING
    : TELEMETRY_MAX_STRING;
}

export function redactTelemetryString(value: string): string {
  return value
    .replace(INLINE_SECRET_RE, "$1[redacted]")
    .replace(BEARER_SECRET_RE, "$1[redacted]");
}
