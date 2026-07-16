export type VideoJobOperation = "preview" | "export" | "broll-rerender";

type JsonObject = Record<string, unknown>;

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

export function videoJobOperationKind(body: JsonObject): VideoJobOperation {
  if (body.mode === "export") return "export";
  if (body.mode === "broll-rerender") return "broll-rerender";
  return "preview";
}

export function canonicalVideoJobRequest(
  operation: VideoJobOperation,
  rawBody: JsonObject,
): string {
  const body = { ...rawBody };
  delete body.idempotencyKey;
  return JSON.stringify(canonicalizeJson({
    version: 1,
    operation,
    body,
  }));
}

export async function fingerprintVideoJobRequest(
  operation: VideoJobOperation,
  body: JsonObject,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalVideoJobRequest(operation, body));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
