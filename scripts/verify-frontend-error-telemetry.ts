import assert from "node:assert/strict";
import { sanitizeClientTelemetryProperties } from "../src/lib/client-telemetry";
import { serializeTelemetryProperties } from "../src/lib/telemetry";

const longStack = Array.from({ length: 24 }, (_, index) => (
  `at Component${index} (https://studio.example/_next/static/chunks/editor-${index}.js:${index + 1}:20)`
)).join("\n");

const client = sanitizeClientTelemetryProperties({
  message: "m".repeat(500),
  stack: `${longStack}\nat fetch (?token=must-not-leak)` ,
  componentStack: longStack,
  apiKey: "must-not-leak",
});
assert.equal((client?.message as string).length, 240, "ordinary telemetry strings stay bounded");
assert.ok((client?.stack as string).length > 240, "error stack keeps enough frames to identify a component");
assert.ok((client?.stack as string).length <= 2_048, "error stack has a strict upper bound");
assert.equal((client?.stack as string).includes("must-not-leak"), false, "stack query secrets are redacted client-side");
assert.equal(client?.apiKey, "[redacted]", "secret-named client fields are redacted");

const serialized = serializeTelemetryProperties(client);
assert.ok(serialized, "server keeps sanitized error properties");
assert.ok(Buffer.byteLength(serialized!, "utf8") <= 4_000, "server payload respects the 4 KB cap");
const server = JSON.parse(serialized!) as Record<string, unknown>;
assert.ok((server.stack as string).length > 240, "server does not truncate the useful stack back to 240 chars");
assert.equal((server.stack as string).includes("must-not-leak"), false, "stack query secrets stay redacted server-side");
assert.equal(Object.hasOwn(server, "apiKey"), false, "server drops secret-named fields");

console.log("frontend-error-telemetry: all checks passed");
