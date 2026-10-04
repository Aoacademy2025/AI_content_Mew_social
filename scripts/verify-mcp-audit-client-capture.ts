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

// Throwaway DB FIRST, before any module that imports @/lib/prisma is loaded: the prisma
// client reads DATABASE_URL once at import time, so overriding it later (after section A's
// `import("../src/lib/mcp/audit")` pulled prisma in) left the client pointed at whatever the
// environment preset. CI presets DATABASE_URL=file:./ci.db (an empty file) → P2021 "table
// main.User does not exist". Same pattern as the other verify-mcp-* scripts.
const dir = mkdtempSync(join(tmpdir(), "mcp-audit-client-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

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

  // PR-A security low S2: every Unicode Cc (C0 + DEL + C1) and Cf (bidi embeddings/overrides
  // U+202A–202E, isolates U+2066–2069, LRM/RLM, ZWSP-family, BOM, soft hyphen) is stripped,
  // plus the U+2028/U+2029 line/paragraph separators — all of them can spoof or split a log
  // line or an admin view.
  const BIDI_AND_FORMAT = [
    "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
    "\u2066", "\u2067", "\u2068", "\u2069",
    "\u200B", "\u200E", "\u200F", "\uFEFF", "\u00AD", "\u2060",
  ];
  for (const ch of BIDI_AND_FORMAT) {
    const out = sanitizeUserAgent(`Claude${ch}Code/1.0`);
    check(`Cf U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} is stripped`, out === "ClaudeCode/1.0", JSON.stringify(out));
  }
  const c1 = sanitizeUserAgent("Claude\u0085\u009BCode/1.0");
  check("C1 controls (U+0085 NEL, U+009B CSI) are stripped", c1 === "ClaudeCode/1.0", JSON.stringify(c1));
  const separators = sanitizeUserAgent("Claude\u2028\u2029Code/1.0");
  check("U+2028/U+2029 line/paragraph separators are stripped", separators === "ClaudeCode/1.0", JSON.stringify(separators));
  const spoof = sanitizeUserAgent("Claude-Code/1.0 \u202Egnp.exe\u202C");
  check("a right-to-left override spoof is neutralised", spoof === "Claude-Code/1.0 gnp.exe", JSON.stringify(spoof));
  check("ordinary non-ASCII text is kept", sanitizeUserAgent("ไคลเอนต์/1.0 (ทดสอบ)") === "ไคลเอนต์/1.0 (ทดสอบ)");

  // Truncation counts code points, so an astral character (emoji = a UTF-16 surrogate pair)
  // at the 200 boundary is either kept whole or dropped whole — never split into a lone
  // surrogate.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const emojiAtBoundary = sanitizeUserAgent("A".repeat(199) + "😀😀");
  check("truncation at 200 code points keeps the emoji at the boundary whole",
    emojiAtBoundary === "A".repeat(199) + "😀", JSON.stringify(emojiAtBoundary?.slice(195)));
  check("truncation never leaves a lone surrogate", emojiAtBoundary != null && !LONE_SURROGATE.test(emojiAtBoundary));
  const allEmoji = sanitizeUserAgent("😀".repeat(250));
  check("an all-astral user-agent is capped at 200 code points with no lone surrogate",
    allEmoji != null && Array.from(allEmoji).length === 200 && !LONE_SURROGATE.test(allEmoji));

  const longWithControl = "B".repeat(195) + "\r\n\r\n" + "C".repeat(50);
  const sanitizedLong = sanitizeUserAgent(longWithControl);
  check("sanitize happens before truncate (control chars don't eat into the 200-char budget)",
    sanitizedLong?.length === 200 && sanitizedLong === "B".repeat(195) + "C".repeat(5),
    String(sanitizedLong));
}

// ── B. recordToolCall persists the sanitized, truncated user-agent (DB) ────────────────
async function verifyAuditRow() {
  console.log("B) recordToolCall — ToolCallAudit.userAgent carries the sanitized value");
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

  await recordToolCall({ userId: user.id, toolName: "get_video_options", status: "ok", userAgent: "Agent\u202E/1.0\u2066" });
  const row5 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "get_video_options" } });
  check("a stored row never carries a bidi control", row5?.userAgent === "Agent/1.0", JSON.stringify(row5?.userAgent));

  await recordToolCall({ userId: user.id, toolName: "download_video", status: "ok" });
  const row3 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "download_video" } });
  check("no user-agent given → column stays null (recordToolCall never throws)", row3?.userAgent === null);

  await recordToolCall({ userId: user.id, toolName: "create_video_job", status: "denied", userAgent: "DeniedClient/0.9" });
  const row4 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "create_video_job" } });
  check("a denied call still carries the user-agent (captured before the plan gate)", row4?.userAgent === "DeniedClient/0.9");

  await recordToolCall({ userId: user.id, toolName: "export_video", status: "error", responseJson: { error: "missing_key" } });
  const row6 = await prisma.toolCallAudit.findFirst({ where: { userId: user.id, toolName: "export_video" } });
  check("an error row stores its error summary in responseJson", row6?.responseJson === '{"error":"missing_key"}', JSON.stringify(row6?.responseJson));
  check("an ok row leaves responseJson null", row?.responseJson === null);

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
  check("runTool stores the error summary on every non-ok row (denied/in-band/thrown)",
    (routeSrc.match(/recordToolCall\(\{[^}]*responseJson/g) ?? []).length >= 3);
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
