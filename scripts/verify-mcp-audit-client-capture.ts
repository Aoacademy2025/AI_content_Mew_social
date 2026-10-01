// verify-mcp-audit-client-capture.ts — T7: client capture in the MCP audit.
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T7). Spike result (recorded in
// docs/plans/reports/2026-10-01-mcp-upgrade-p0-p1/task-7.md): mcp-handler's streamable-HTTP
// transport (the one this route uses — no `sessionIdGenerator`, so it is fully stateless)
// constructs a BRAND NEW `McpServer` on every HTTP POST (mcp-handler/dist/index.js,
// `initializeMcpApiHandler`'s POST branch: `new McpServer(...)` then `initializeServer(server)`
// per request). The underlying SDK's `Server._clientVersion` (clientInfo.name/version) is set
// only by its own `_oninitialize` handler, which only runs when THIS request's JSON-RPC method
// is "initialize" (@modelcontextprotocol/sdk/dist/cjs/server/index.js:276). A `tools/call`
// request is a separate HTTP POST against a freshly constructed server with no prior
// `initialize` in its own history, so `getClientVersion()` is unset at tool-call time — there
// is no persisted session to recover it from. Per the plan's own fallback clause ("user-agent
// alone is acceptable"), this verifies user-agent-only capture.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-audit-client-capture.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

// ── A. sanitizeUserAgent: pure, no DB ───────────────────────────────────────────────────
async function verifySanitize() {
  console.log("A) sanitizeUserAgent — control-char stripping + 200-char truncation");
  const { sanitizeUserAgent } = await import("../src/lib/mcp/audit");

  check("plain user-agent passes through unchanged", sanitizeUserAgent("Claude-Code/1.2.3") === "Claude-Code/1.2.3");
  check("null/undefined → null", sanitizeUserAgent(null) === null && sanitizeUserAgent(undefined) === null);
  check("empty string → null", sanitizeUserAgent("") === null);
  check("whitespace-only → null", sanitizeUserAgent("   ") === null);

  const withControlChars = "Claude\r\nX-Injected: evil\x00\x07agent/1.0";
  const sanitized = sanitizeUserAgent(withControlChars);
  check("control characters (CR/LF/NUL/BEL) are stripped", sanitized !== null && !/[\x00-\x1F\x7F]/.test(sanitized!));
  check("stripped content still carries the surrounding text", sanitized === "ClaudeX-Injected: evilagent/1.0", String(sanitized));

  const long = "A".repeat(500);
  check("truncates to 200 chars", sanitizeUserAgent(long)?.length === 200);

  const longWithControl = "B".repeat(195) + "\r\n\r\n" + "C".repeat(50);
  const sanitizedLong = sanitizeUserAgent(longWithControl);
  check("sanitize happens before truncate (control chars don't eat into the 200-char budget)",
    sanitizedLong?.length === 200 && sanitizedLong === "B".repeat(195) + "C".repeat(5),
    String(sanitizedLong));
}

// ── B. recordToolCall persists the sanitized, truncated user-agent (DB) ────────────────
async function verifyAuditRow() {
  console.log("B) recordToolCall — ToolCallAudit.userAgent carries the sanitized value");
  const dir = mkdtempSync(join(tmpdir(), "mcp-audit-client-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { prisma } = await import("../src/lib/prisma");
  const { recordToolCall } = await import("../src/lib/mcp/audit");

  const user = await prisma.user.create({ data: { name: "u", email: "u@t.test", plan: "PRO" } });

  await recordToolCall({ userId: user.id, toolName: "get_current_user", status: "ok", userAgent: "Claude-Code/1.2.3 (mcp-client)" });
  const row = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "get_current_user" } });
  check("a tool call audit row carries the user-agent", row?.userAgent === "Claude-Code/1.2.3 (mcp-client)");

  const hostile = "evil\r\nSet-Cookie: x\x00" + "A".repeat(250);
  await recordToolCall({ userId: user.id, toolName: "get_video_status", status: "ok", userAgent: hostile });
  const row2 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "get_video_status" } });
  check("a hostile/oversized user-agent is sanitized and truncated to <=200 chars before storage",
    row2?.userAgent != null && row2.userAgent.length <= 200 && !/[\x00-\x1F\x7F]/.test(row2.userAgent));

  await recordToolCall({ userId: user.id, toolName: "download_video", status: "ok" });
  const row3 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "download_video" } });
  check("no user-agent given → column stays null (recordToolCall never throws)", row3?.userAgent === null);

  await recordToolCall({ userId: user.id, toolName: "create_video_job", status: "denied", userAgent: "DeniedClient/0.9" });
  const row4 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "create_video_job" } });
  check("a denied call still carries the user-agent (captured before the plan gate)", row4?.userAgent === "DeniedClient/0.9");

  await prisma.$disconnect();
}

// ── C. route.ts wiring: verifyToken reads the header, carries it through to recordToolCall ─
function verifyRouteWiring() {
  console.log("C) [transport]/route.ts wiring");
  const routeSrc = readFileSync(join(__dirname, "..", "src", "app", "api", "[transport]", "route.ts"), "utf8");

  check("verifyToken reads the User-Agent header off the Request",
    routeSrc.includes('req.headers.get("user-agent")'));
  check("verifyToken's req param is used (not the pre-T7 `_req` placeholder)",
    !/const verifyToken = async \(\s*_req: Request/.test(routeSrc));
  check("the captured user-agent is carried into AuthInfo.extra",
    /extra:\s*\{[^}]*userAgent/.test(routeSrc));
  check("principalFrom reads userAgent back out of authInfo.extra",
    /function principalFrom[\s\S]{0,400}userAgent/.test(routeSrc));
  check("runTool forwards userAgent into every recordToolCall call (denied/ok/error)",
    (routeSrc.match(/recordToolCall\(\{[^}]*userAgent/g) ?? []).length >= 3);
}

verifySanitize()
  .then(verifyAuditRow)
  .then(verifyRouteWiring)
  .catch((error) => {
    failed += 1;
    console.error("  FAIL: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("❌ MCP audit client capture verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP audit client capture: all checks passed");
    process.exit(0);
  });
