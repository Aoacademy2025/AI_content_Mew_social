// verify-mcp-audit-insights.ts — HERO-93 verification:
//   1. NOT_READY in src/lib/mcp/edit-tools.ts carries retryAfterSeconds: 60 while other
//      EditToolFailure objects keep their exact 4-key envelope.
//   2. recordToolCall in src/lib/mcp/audit.ts throttles transient not_ready poll responses
//      for 60s under status-qualified keys, while recording the first not_ready, immediate
//      transitions to ok, and all real errors / denied calls without throttling.
//   3. readInsightsMcpUsage / summarizeInsightsMcpUsage accurately compute customer vs
//      internal/admin calls, active tokens, notReadyPolls vs realErrorCalls, quote-bound
//      jobs, top tools, and normalized client families with ZERO PII/secret leakage and
//      strict ADR 0062 compliance on /admin/insights.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-audit-insights.ts

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "mcp-audit-insights-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
const localPrismaBin = join(ROOT, "node_modules", ".bin", "prisma");
const prismaCmd = existsSync(localPrismaBin)
  ? `"${localPrismaBin}" db push --skip-generate`
  : "npx prisma db push --skip-generate";
execSync(prismaCmd, { stdio: "ignore", env: process.env, cwd: ROOT });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ── A. NOT_READY retryAfterSeconds contract ────────────────────────────────────────────────
async function verifyNotReadyFailureEnvelope() {
  console.log("A) edit-tools NOT_READY retryAfterSeconds contract");
  const { NOT_READY, UNKNOWN_JOB, editToolFailure } = await import("../src/lib/mcp/edit-tools");

  check("NOT_READY has error='not_ready' and code='not_ready'", NOT_READY.error === "not_ready" && NOT_READY.code === "not_ready");
  check("NOT_READY carries retryAfterSeconds === 60", NOT_READY.retryAfterSeconds === 60, JSON.stringify(NOT_READY));
  check(
    "NOT_READY keys are exact",
    JSON.stringify(Object.keys(NOT_READY).sort()) ===
      JSON.stringify(["code", "error", "message", "next", "retryAfterSeconds"]),
    JSON.stringify(Object.keys(NOT_READY)),
  );
  check(
    "UNKNOWN_JOB omits retryAfterSeconds key so existing failure shapes stay unchanged",
    !("retryAfterSeconds" in UNKNOWN_JOB) &&
      JSON.stringify(Object.keys(UNKNOWN_JOB).sort()) === JSON.stringify(["code", "error", "message", "next"]),
    JSON.stringify(Object.keys(UNKNOWN_JOB)),
  );
  const customNoRetry = editToolFailure("invalid_input", "ข้อมูลไม่ถูกต้อง", "ตรวจสอบพารามิเตอร์แล้วลองใหม่");
  check(
    "editToolFailure without retryAfterSeconds omits the key",
    !("retryAfterSeconds" in customNoRetry),
    JSON.stringify(customNoRetry),
  );
  const customWithRetry = editToolFailure("busy", "ระบบกำลังประมวลผล", "รอสักครู่แล้วลองใหม่", 30);
  check(
    "editToolFailure with retryAfterSeconds attaches the exact numeric value",
    customWithRetry.retryAfterSeconds === 30,
    JSON.stringify(customWithRetry),
  );
}

// ── B. recordToolCall transient not_ready poll throttling ─────────────────────────────────
async function verifyNotReadyPollThrottling() {
  console.log("B) recordToolCall — transient not_ready poll throttling & immediate state transitions");
  const { prisma } = await import("../src/lib/prisma");
  const { recordToolCall } = await import("../src/lib/mcp/audit");
  const { NOT_READY } = await import("../src/lib/mcp/edit-tools");

  const pollUser = await prisma.user.create({
    data: { name: "Poll User", email: "poll-user@test.invalid", plan: "PRO" },
  });

  const realDateNow = Date.now;
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;
  try {
    const countRows = (toolName: string) =>
      prisma.toolCallAudit.count({ where: { userId: pollUser.id, toolName } });

    // 1. First not_ready in a 60s window IS recorded; duplicates inside 60s are skipped.
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
      userAgent: "Claude-Code/1.2.3",
    });
    check("1st get_edit_state not_ready is recorded in ToolCallAudit", (await countRows("get_edit_state")) === 1);

    fakeNow += 5_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
      userAgent: "Claude-Code/1.2.3",
    });
    fakeNow += 54_000; // +59s total (< 60s)
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: { error: "not_ready" },
      userAgent: "Claude-Code/1.2.3",
    });
    check(
      "duplicate get_edit_state not_ready polls within 60s are throttled (no extra SQLite writes)",
      (await countRows("get_edit_state")) === 1,
    );

    // 2. Transition from not_ready -> ok is recorded immediately and throttles subsequent ok calls.
    fakeNow += 500; // still inside original 60s window!
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "ok",
      userAgent: "Claude-Code/1.2.3",
    });
    check(
      "transition from not_ready -> ok is recorded immediately even inside 60s",
      (await countRows("get_edit_state")) === 2,
    );

    fakeNow += 2_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "ok",
      userAgent: "Claude-Code/1.2.3",
    });
    check("repeat ok poll within 60s stays throttled", (await countRows("get_edit_state")) === 2);

    // 3. Because ok deleted :not_ready, a fresh not_ready after ok IS recorded once, then throttled.
    fakeNow += 2_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
    });
    check(
      "transition from ok -> not_ready records the new not_ready window's first row",
      (await countRows("get_edit_state")) === 3,
    );

    // 4. Real errors (not_editable, invalid_input, internal_error) and denied are NEVER throttled
    //    and clear both :ok and :not_ready throttle keys.
    fakeNow += 1_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: { error: "not_editable", code: "not_editable" },
    });
    fakeNow += 1_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: { error: "invalid_input", code: "invalid_input" },
    });
    fakeNow += 1_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "denied",
      responseJson: { error: "plan_required", code: "plan_required" },
    });
    check(
      "real errors (not_editable, invalid_input) and denied are always recorded immediately",
      (await countRows("get_edit_state")) === 6,
    );

    // 5. Because denied/real error cleared :not_ready, next not_ready records immediately, then throttles until +60s.
    fakeNow += 1_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
    });
    fakeNow += 10_000;
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
    });
    check(
      "post-error not_ready records 1st row and throttles 2nd row",
      (await countRows("get_edit_state")) === 7,
    );

    fakeNow += 60_001; // advance past 60s window
    await recordToolCall({
      userId: pollUser.id,
      toolName: "get_edit_state",
      status: "error",
      responseJson: NOT_READY,
    });
    check(
      "after 60s throttle window expires, next not_ready is recorded again",
      (await countRows("get_edit_state")) === 8,
    );

    // 6. Non-poll tools are never throttled even if they return not_ready.
    await recordToolCall({
      userId: pollUser.id,
      toolName: "export_video",
      status: "error",
      responseJson: NOT_READY,
    });
    await recordToolCall({
      userId: pollUser.id,
      toolName: "export_video",
      status: "error",
      responseJson: NOT_READY,
    });
    check(
      "non-poll tools (export_video) are never throttled on not_ready",
      (await countRows("export_video")) === 2,
    );
  } finally {
    Date.now = realDateNow;
  }
}

// ── C. readInsightsMcpUsage / summarizeInsightsMcpUsage + Zero-PII & ADR 0062 ─────────────
async function verifyInsightsMcpUsage() {
  console.log("C) insights-mcp-usage — customer/internal split, outcomes, tokens, quoteJobs, zero PII");
  const { prisma } = await import("../src/lib/prisma");
  const {
    buildInternalOrAdminUserIds,
    normalizeMcpClientFamily,
    readInsightsMcpUsage,
    summarizeInsightsMcpUsage,
  } = await import("../src/lib/insights-mcp-usage.server");

  const windowSince = new Date("2026-11-01T00:00:00.000Z");
  const windowNow = new Date("2026-11-08T00:00:00.000Z");
  const beforeWindow = new Date("2026-10-20T00:00:00.000Z");

  const cust1 = await prisma.user.create({
    data: { name: "Cust Alpha", email: "alpha-secret@customer.invalid", role: "USER", plan: "PRO" },
  });
  const cust2 = await prisma.user.create({
    data: { name: "Cust Beta", email: "beta-secret@customer.invalid", role: "USER", plan: "BUSINESS" },
  });
  const cust3 = await prisma.user.create({
    data: { name: "Cust Gamma", email: "gamma-secret@customer.invalid", role: "USER", plan: "PRO" },
  });
  const internalTeam = await prisma.user.create({
    data: { name: "Internal Team", email: "staff@aoacademy.invalid", role: "USER", plan: "BUSINESS" },
  });
  const adminAccount = await prisma.user.create({
    data: { name: "External Admin", email: "root-admin@corp.invalid", role: "ADMIN", plan: "BUSINESS" },
  });

  // Tokens:
  // - cust1: active + used
  // - cust2: revoked + used (counts in customerUsersEverUsed, NOT active)
  // - cust3: 1 expired unused + 1 active unused (counts in customerActive, NOT customerUsersEverUsed)
  // - internalTeam: active + used (counts in tokens.active, NOT customerActive or customerUsersEverUsed)
  // - adminAccount: active + used (counts in tokens.active, NOT customerActive or customerUsersEverUsed)
  await prisma.mcpToken.createMany({
    data: [
      {
        userId: cust1.id,
        name: "Alpha Claude",
        tokenHash: "hash_secret_alpha_001",
        lastUsedAt: new Date("2026-11-05T10:00:00.000Z"),
      },
      {
        userId: cust2.id,
        name: "Beta Cursor",
        tokenHash: "hash_secret_beta_002",
        revokedAt: new Date("2026-11-06T00:00:00.000Z"),
        lastUsedAt: new Date("2026-11-04T10:00:00.000Z"),
      },
      {
        userId: cust3.id,
        name: "Gamma Expired",
        tokenHash: "hash_secret_gamma_003",
        expiresAt: new Date("2026-11-02T00:00:00.000Z"),
      },
      {
        userId: cust3.id,
        name: "Gamma Fresh",
        tokenHash: "hash_secret_gamma_004",
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      },
      {
        userId: internalTeam.id,
        name: "AO Internal",
        tokenHash: "hash_secret_internal_005",
        lastUsedAt: new Date("2026-11-07T00:00:00.000Z"),
      },
      {
        userId: adminAccount.id,
        name: "Admin Token",
        tokenHash: "hash_secret_admin_006",
        lastUsedAt: new Date("2026-11-07T01:00:00.000Z"),
      },
    ],
  });

  // Audit rows (deliberately populate requestJson + ipAddress with sensitive canary strings)
  const sensitiveReq = JSON.stringify({
    script: "SENSITIVE_CUSTOMER_SCRIPT_DO_NOT_LEAK",
    mediaUrl: "https://cdn.customer.invalid/private-video.mp4",
  });
  const sensitiveIp = "198.51.100.77";

  await prisma.toolCallAudit.createMany({
    data: [
      // Out of window — must NOT be counted
      {
        userId: cust1.id,
        toolName: "create_video_job",
        status: "ok",
        requestJson: sensitiveReq,
        ipAddress: sensitiveIp,
        userAgent: "Claude-Code/1.2.3",
        createdAt: beforeWindow,
      },
      // In window — customer calls (5 customer calls: cust1 x2, cust2 x2, null userId denied x1)
      {
        userId: cust1.id,
        toolName: "create_video_job",
        status: "ok",
        requestJson: sensitiveReq,
        ipAddress: sensitiveIp,
        userAgent: "Claude-Code/1.2.3",
        createdAt: new Date("2026-11-03T01:00:00.000Z"),
      },
      {
        userId: cust1.id,
        toolName: "get_edit_state",
        status: "error",
        requestJson: sensitiveReq,
        responseJson: JSON.stringify({ error: "not_ready", code: "not_ready", retryAfterSeconds: 60 }),
        ipAddress: sensitiveIp,
        userAgent: "Claude-Code/1.2.3",
        createdAt: new Date("2026-11-03T01:01:00.000Z"),
      },
      {
        userId: cust2.id,
        toolName: "get_edit_state",
        status: "ok",
        requestJson: sensitiveReq,
        ipAddress: sensitiveIp,
        userAgent: "Cursor/0.49.1",
        createdAt: new Date("2026-11-04T02:00:00.000Z"),
      },
      {
        userId: cust2.id,
        toolName: "apply_edit_operations",
        status: "error",
        requestJson: sensitiveReq,
        responseJson: JSON.stringify({ error: "stale_revision", code: "stale_revision" }),
        ipAddress: sensitiveIp,
        userAgent: "Cursor/0.49.1",
        createdAt: new Date("2026-11-04T02:05:00.000Z"),
      },
      {
        userId: null,
        toolName: "create_video_job",
        status: "denied",
        requestJson: sensitiveReq,
        responseJson: JSON.stringify({ error: "unauthorized" }),
        ipAddress: sensitiveIp,
        userAgent: null,
        createdAt: new Date("2026-11-05T03:00:00.000Z"),
      },
      // In window — internal & admin calls (2 internal calls)
      {
        userId: internalTeam.id,
        toolName: "get_edit_state",
        status: "ok",
        requestJson: sensitiveReq,
        ipAddress: sensitiveIp,
        userAgent: "codex-cli/0.2.0",
        createdAt: new Date("2026-11-06T04:00:00.000Z"),
      },
      {
        userId: adminAccount.id,
        toolName: "get_video_status",
        status: "ok",
        requestJson: sensitiveReq,
        ipAddress: sensitiveIp,
        userAgent: "python-httpx/0.27.2",
        createdAt: new Date("2026-11-06T05:00:00.000Z"),
      },
    ],
  });

  // VideoJob rows (quote-bound vs web, customer vs internal/admin, in-window vs out-of-window)
  await prisma.videoJob.createMany({
    data: [
      {
        userId: cust1.id,
        status: "done",
        budgetQuoteId: "quote_cust_done",
        inputJson: sensitiveReq,
        createdAt: new Date("2026-11-03T01:00:00.000Z"),
      },
      {
        userId: cust1.id,
        status: "failed",
        budgetQuoteId: "quote_cust_failed",
        inputJson: sensitiveReq,
        createdAt: new Date("2026-11-03T02:00:00.000Z"),
      },
      {
        userId: cust2.id,
        status: "canceled",
        budgetQuoteId: "quote_cust_canceled",
        inputJson: sensitiveReq,
        createdAt: new Date("2026-11-04T02:00:00.000Z"),
      },
      {
        userId: cust2.id,
        status: "processing",
        budgetQuoteId: "quote_cust_inflight",
        inputJson: sensitiveReq,
        createdAt: new Date("2026-11-04T03:00:00.000Z"),
      },
      // Non-quote web job (must NOT count in quoteJobs)
      {
        userId: cust1.id,
        status: "done",
        budgetQuoteId: null,
        inputJson: "{}",
        createdAt: new Date("2026-11-05T01:00:00.000Z"),
      },
      // Internal & admin quote-bound jobs (must NOT count in customer quoteJobs)
      {
        userId: internalTeam.id,
        status: "done",
        budgetQuoteId: "quote_internal_done",
        inputJson: "{}",
        createdAt: new Date("2026-11-06T01:00:00.000Z"),
      },
      {
        userId: adminAccount.id,
        status: "done",
        budgetQuoteId: "quote_admin_done",
        inputJson: "{}",
        createdAt: new Date("2026-11-06T02:00:00.000Z"),
      },
      // Out-of-window quote-bound job (must NOT count)
      {
        userId: cust1.id,
        status: "done",
        budgetQuoteId: "quote_old_done",
        inputJson: "{}",
        createdAt: beforeWindow,
      },
    ],
  });

  const allUsers = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  const excludedIds = buildInternalOrAdminUserIds(allUsers);
  check(
    "buildInternalOrAdminUserIds includes @aoacademy and ADMIN users, excludes customers",
    excludedIds.has(internalTeam.id) &&
      excludedIds.has(adminAccount.id) &&
      !excludedIds.has(cust1.id) &&
      !excludedIds.has(cust2.id),
  );

  const usage = await readInsightsMcpUsage({
    since: windowSince,
    now: windowNow,
    excludedUserIds: excludedIds,
  });

  // Note: pollUser from Section B also created 1 User + 0 tokens + 10 ToolCallAudit rows at real `now` (2026-11-14),
  // which is AFTER `windowNow` (2026-11-08), proving `[since, now]` upper-bound `lte: now` also works!
  check(
    "tokens summary counts active, customerActive, total, and distinct customerUsersEverUsed",
    usage.tokens.total === 6 &&
      usage.tokens.active === 4 &&
      usage.tokens.customerActive === 2 &&
      usage.tokens.customerUsersEverUsed === 2,
    JSON.stringify(usage.tokens),
  );

  // Window has 7 audit rows: 5 customer (cust1 x2, cust2 x2, anon denied x1) + 2 internal/admin.
  // Outcomes: 4 ok (cust1 create_video_job, cust2 get_edit_state, internal get_edit_state, admin get_video_status),
  //           1 notReadyPolls (cust1 get_edit_state),
  //           1 realErrorCalls (cust2 apply_edit_operations stale_revision),
  //           1 deniedCalls (anon create_video_job).
  // realSuccessPct = 4 / (4 + 1) * 100 = 80.
  check(
    "calls summary splits customer vs internal/admin and activeCustomerUsers",
    usage.calls.total === 7 &&
      usage.calls.customerCalls === 5 &&
      usage.calls.internalCalls === 2 &&
      usage.calls.activeCustomerUsers === 2,
    JSON.stringify(usage.calls),
  );
  check(
    "calls outcome separates notReadyPolls from realErrorCalls and computes realSuccessPct",
    usage.calls.okCalls === 4 &&
      usage.calls.notReadyPolls === 1 &&
      usage.calls.realErrorCalls === 1 &&
      usage.calls.deniedCalls === 1 &&
      usage.calls.realSuccessPct === 80,
    JSON.stringify(usage.calls),
  );

  check(
    "quoteJobs counts only in-window non-internal/non-admin quote-bound VideoJobs",
    usage.quoteJobs.total === 4 &&
      usage.quoteJobs.done === 1 &&
      usage.quoteJobs.failed === 1 &&
      usage.quoteJobs.canceled === 1 &&
      usage.quoteJobs.inFlight === 1,
    JSON.stringify(usage.quoteJobs),
  );

  const editStateTool = usage.topTools.find((t) => t.toolName === "get_edit_state");
  check(
    "topTools tracks calls, customerCalls, notReadyPolls, realErrors, and customerUsers per tool",
    editStateTool !== undefined &&
      editStateTool.calls === 3 &&
      editStateTool.customerCalls === 2 &&
      editStateTool.notReadyPolls === 1 &&
      editStateTool.realErrors === 0 &&
      editStateTool.customerUsers === 2,
    JSON.stringify(usage.topTools),
  );

  const clientFamilies = usage.topClients.map((c) => c.family);
  check(
    "topClients normalizes Claude, Cursor, Codex, Python, and Pre-capture / unknown",
    ["Claude", "Cursor", "Codex", "Python", "Pre-capture / unknown"].every((fam) =>
      clientFamilies.includes(fam),
    ),
    JSON.stringify(usage.topClients),
  );

  // Pure edge-case checks on normalizeMcpClientFamily & 0-settled realSuccessPct
  check(
    "normalizeMcpClientFamily caps unknown prefix to 24 chars and scrubs @ / URLs / tokens",
    normalizeMcpClientFamily("CustomAgentSuperLongIdentifierName/3.1") === "CustomAgentSuperLongIden" &&
      normalizeMcpClientFamily("accidental-email@customer.invalid/1.0") === "Other / custom" &&
      normalizeMcpClientFamily("https://internal.invalid/agent") === "Other / custom" &&
      normalizeMcpClientFamily("Bearer mcp_secret_token") === "Other / custom",
  );
  const zeroSettled = summarizeInsightsMcpUsage({
    now: windowNow,
    excludedUserIds: new Set(),
    tokens: [],
    auditRows: [
      {
        userId: "u1",
        toolName: "get_edit_state",
        status: "error",
        responseJson: '{"code":"not_ready"}',
        userAgent: "Claude/1.0",
      },
    ],
    quoteJobs: [],
  });
  check("realSuccessPct is null when 0 settled calls exist", zeroSettled.calls.realSuccessPct === null);

  // Strict zero-PII / zero-secret verification on serialized payload
  const serialized = JSON.stringify(usage);
  const forbiddenCanaries = [
    "SENSITIVE_CUSTOMER_SCRIPT_DO_NOT_LEAK",
    "private-video.mp4",
    "198.51.100.77",
    "alpha-secret",
    "beta-secret",
    "aoacademy",
    "hash_secret",
    "mcp_alph",
    cust1.id,
    cust2.id,
    internalTeam.id,
    adminAccount.id,
    "quote_cust_",
  ];
  check(
    "serialized mcpUsage JSON contains zero emails, userIds, scripts, media URLs, IPs, quote IDs, or token secrets",
    forbiddenCanaries.every((needle) => !serialized.includes(needle)),
    serialized,
  );

  await prisma.$disconnect();
}

// ── D. Source-level privacy, ADR 0062, and ops docs checks ────────────────────────────────
function verifySourceContracts() {
  console.log("D) source contracts — column minimization, ADR 0062, and heroai-audit-ro docs");

  const serverSrc = readFileSync(join(ROOT, "src", "lib", "insights-mcp-usage.server.ts"), "utf8");
  check(
    "insights-mcp-usage.server.ts never selects requestJson or ipAddress",
    !/requestJson\s*:/.test(serverSrc) && !/ipAddress\s*:/.test(serverSrc),
  );

  const schemaSrc = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  const toolCallAuditModel = schemaSrc.match(/model ToolCallAudit \{[\s\S]*?\n\}/)?.[0] ?? "";
  check(
    "prisma/schema.prisma defines additive @@index([createdAt]) on ToolCallAudit",
    toolCallAuditModel.includes("@@index([createdAt])"),
  );

  const pageSrc = readFileSync(join(ROOT, "src", "app", "(dashboard)", "admin", "insights", "page.tsx"), "utf8");
  const mcpPanelSlice = pageSrc.slice(
    pageSrc.indexOf("function McpUsagePanel"),
    pageSrc.indexOf("function Panel("),
  );
  check("admin/insights/page.tsx defines and renders McpUsagePanel", mcpPanelSlice.length > 100 && pageSrc.includes("<McpUsagePanel"));
  const bannedMoneyTermsInPanel = ["บาท", "฿", "เครดิต", "รายได้", "MRR", "จ่ายจริง", "ใบเสนอราคา"];
  check(
    "McpUsagePanel contains zero money/baht/credit terms (ADR 0062)",
    bannedMoneyTermsInPanel.every((term) => !mcpPanelSlice.includes(term)),
  );

  const runbookSrc = readFileSync(join(ROOT, "docs", "ops", "ops-guardrails-runbook.md"), "utf8");
  const supportAuditSrc = readFileSync(
    join(ROOT, ".agents", "skills", "hero-studio-ops", "references", "support-audit.md"),
    "utf8",
  );
  check(
    "ops-guardrails-runbook.md documents ssh heroai-audit-ro and /usr/local/sbin/hero-audit-ro",
    runbookSrc.includes("heroai-audit-ro") && runbookSrc.includes("/usr/local/sbin/hero-audit-ro"),
  );
  check(
    "support-audit.md documents ssh heroai-audit-ro vs hostinger_heroai_codex",
    supportAuditSrc.includes("heroai-audit-ro") && supportAuditSrc.includes("hostinger_heroai_codex"),
  );
}

verifyNotReadyFailureEnvelope()
  .then(verifyNotReadyPollThrottling)
  .then(verifyInsightsMcpUsage)
  .then(verifySourceContracts)
  .catch((error) => {
    failed += 1;
    console.error("  FAIL: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("❌ MCP audit & insights verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP audit & insights: all checks passed");
    process.exit(0);
  });
