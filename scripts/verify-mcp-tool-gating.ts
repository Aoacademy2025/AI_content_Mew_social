// verify-mcp-tool-gating.ts — Task 4 (PR-A, docs/plans/2026-10-03-mcp-edit-before-export.md,
// G1/G13/G14): per-principal tool registration on the stateless MCP route.
//
// Spike result (full writeup: docs/plans/reports/2026-10-03-mcp-edit-before-export/task-4.md):
// mcp-handler builds a brand new McpServer per HTTP POST and calls its factory as
// `initializeServer(server)` — no request, no auth. route.ts threads the already-verified
// McpPrincipal into that factory via an AsyncLocalStorage set once inside verifyToken
// (src/lib/mcp/request-principal.ts), so `registerGatedTool` (src/lib/mcp/tool-gating.ts) can
// decide, per request and with no second DB lookup, whether to call `server.registerTool()` at
// all. Skipping registration is what keeps a gated tool out of `tools/list` for a non-beta
// principal; `registerGatedTool` separately wraps the low-level `tools/call` dispatch (once per
// server) so a DIRECT call of that exact (unregistered) name still gets the G14 envelope
// `{error, code, message, next}` instead of the SDK's generic "tool not found" — and every other
// call, including every existing/real tool, is forwarded completely unmodified.
//
// This script builds two throwaway McpServer instances end-to-end over the SDK's own
// Client/InMemoryTransport (the exact `tools/list` + `tools/call` JSON-RPC path production
// uses), NOT just unit calls into tool-gating.ts — the thing under test is request-level
// behavior, so the test has to go through a request.
//
// The dummy gated tool used here exists only in this script. Task 6 wired registerGatedTool
// into the live route (the edit tools); scripts/verify-mcp-edit-draft.ts drives that real route.
// Task 6 also added: gate refusals audit as "denied", registration order independence (E) and
// an SDK shape guard over the soft-private internals the interceptor relies on (F).
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-tool-gating.ts

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "mcp-tool-gating-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
for (const key of ["MCP_EDITOR_PROJECT_PUBLIC", "INTERNAL_AI_ALLOWED_EMAILS", "INTERNAL_AI_ALLOWED_DOMAINS"]) {
  delete process.env[key];
}
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const GATED_TOOL_NAME = "dummy_gated_tool_for_test";
const REAL_TOOL_NAME = "real_tool_for_test";

async function main() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerGatedTool, mcpSdkGatingShapeProblem } = await import("../src/lib/mcp/tool-gating");
  const { isInBandError } = await import("../src/lib/mcp/audit");
  const { prisma } = await import("../src/lib/prisma");
  const { mcpEditorProjectEnabledFor } = await import("../src/lib/mcp/chain-export");

  const betaUser = await prisma.user.create({ data: { name: "beta", email: "duckyhero@gmail.com", plan: "PRO" } });
  const nonBetaUser = await prisma.user.create({ data: { name: "nonbeta", email: "nonbeta@random-test-domain.test", plan: "PRO" } });
  const betaPrincipal = { userId: betaUser.id, user: betaUser };
  const nonBetaPrincipal = { userId: nonBetaUser.id, user: nonBetaUser };

  // Sanity on the fixtures themselves, independent of the MCP transport, so a failure below
  // is never mistaken for a fixture mistake.
  check("fixture: beta user passes mcpEditorProjectEnabledFor", mcpEditorProjectEnabledFor(betaUser) === true);
  check("fixture: non-beta user fails mcpEditorProjectEnabledFor", mcpEditorProjectEnabledFor(nonBetaUser) === false);

  // Build one server the way route.ts's factory would — base tool(s) first, then any gated
  // tool(s) via registerGatedTool — for a given principal. Mirrors "one new McpServer per POST".
  function buildServer(principal: { userId: string; user: typeof betaUser }) {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.registerTool(
      REAL_TOOL_NAME,
      { title: "Real tool", description: "unchanged existing tool", inputSchema: { echo: z.string().default("x") } },
      async (args: { echo: string }) => ({ content: [{ type: "text" as const, text: JSON.stringify({ echo: args.echo }) }] }),
    );
    registerGatedTool(
      server,
      principal,
      GATED_TOOL_NAME,
      { title: "Dummy gated tool", description: "test-only — never registered in production code", inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ranRealHandler: true }) }] }),
      { next: "get_video_options" },
    );
    return server;
  }

  async function connectedClient(server: InstanceType<typeof McpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  await section("A) beta principal: tools/list includes the gated tool, and existing tools are unaffected", async () => {
    const client = await connectedClient(buildServer(betaPrincipal));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check("real tool is listed", names.includes(REAL_TOOL_NAME));
    check("gated tool IS listed for a beta principal", names.includes(GATED_TOOL_NAME));

    const result = await client.callTool({ name: GATED_TOOL_NAME, arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    check("beta principal's direct call runs the REAL handler, not a refusal", body.ranRealHandler === true, JSON.stringify(body));

    const realResult = await client.callTool({ name: REAL_TOOL_NAME, arguments: { echo: "hi" } });
    const realBody = JSON.parse((realResult.content as Array<{ text: string }>)[0].text);
    check("the real tool's own call shape is unchanged", realBody.echo === "hi", JSON.stringify(realBody));
  });

  await section("B) non-beta principal: tools/list excludes the gated tool, existing tools unaffected", async () => {
    const client = await connectedClient(buildServer(nonBetaPrincipal));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check("real tool is still listed", names.includes(REAL_TOOL_NAME));
    check("gated tool is NOT listed for a non-beta principal", !names.includes(GATED_TOOL_NAME));

    const realResult = await client.callTool({ name: REAL_TOOL_NAME, arguments: { echo: "hi2" } });
    const realBody = JSON.parse((realResult.content as Array<{ text: string }>)[0].text);
    check("the real tool's own call shape is unchanged for a non-beta principal too", realBody.echo === "hi2", JSON.stringify(realBody));
  });

  await section("C) non-beta principal: a DIRECT call of the hidden tool name gets the G14 envelope, not 'tool not found'", async () => {
    const client = await connectedClient(buildServer(nonBetaPrincipal));
    const result = await client.callTool({ name: GATED_TOOL_NAME, arguments: {} });
    check("the call succeeds at the protocol level (no thrown McpError)", true); // would have thrown above otherwise
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    check("error === feature_not_enabled", body.error === "feature_not_enabled", JSON.stringify(body));
    check("code === feature_not_enabled", body.code === "feature_not_enabled", JSON.stringify(body));
    check("message is Thai (non-empty, non-ASCII)", typeof body.message === "string" && /[฀-๿]/.test(body.message), JSON.stringify(body));
    check("next names what to call instead", body.next === "get_video_options", JSON.stringify(body));
    check("isInBandError classifies the envelope as an in-band error (G14 audit requirement)", isInBandError(body) === true);

    const audited = await prisma.toolCallAudit.findFirst({
      where: { userId: nonBetaUser.id, toolName: GATED_TOOL_NAME },
      orderBy: { createdAt: "desc" },
    });
    check("the refusal was audited via the normal recordToolCall path as denied", audited != null && audited.status === "denied", JSON.stringify(audited));
  });

  await section("D) an UNKNOWN tool name (never registered by anyone) still gets the SDK's own generic refusal, unaffected by gating", async () => {
    const client = await connectedClient(buildServer(nonBetaPrincipal));
    const result = await client.callTool({ name: "totally_unknown_tool_xyz", arguments: {} });
    // McpServer's own default handler catches "not found" as an McpError and turns it into
    // isError:true (not a thrown protocol error) — gating only special-cases KNOWN gated
    // names (the hiddenToolNames map), so a name nobody ever registered falls straight
    // through to that unmodified SDK behavior, never our feature_not_enabled envelope.
    check("isError is true", result.isError === true, JSON.stringify(result));
    const message = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    check("the message is the SDK's generic 'not found', not our envelope", message.includes("not found") && !message.includes("feature_not_enabled"), message);
  });

  await section("E) registration order does not matter: a gated tool registered BEFORE any real tool", async () => {
    function gatedFirst(principal: { userId: string; user: typeof betaUser }) {
      const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
      registerGatedTool(
        server,
        principal,
        GATED_TOOL_NAME,
        { title: "Dummy gated tool", description: "test-only", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ranRealHandler: true }) }] }),
        { next: "get_video_options" },
      );
      server.registerTool(
        REAL_TOOL_NAME,
        { title: "Real tool", description: "unchanged existing tool", inputSchema: { echo: z.string().default("x") } },
        async (args: { echo: string }) => ({ content: [{ type: "text" as const, text: JSON.stringify({ echo: args.echo }) }] }),
      );
      return server;
    }
    let nonBetaServer: InstanceType<typeof McpServer> | null = null;
    try {
      nonBetaServer = gatedFirst(nonBetaPrincipal);
      check("non-beta: gated-first registration does not throw", true);
    } catch (error) {
      check("non-beta: gated-first registration does not throw", false, String(error));
    }
    if (nonBetaServer) {
      const client = await connectedClient(nonBetaServer);
      const names = (await client.listTools()).tools.map((t) => t.name);
      check("non-beta: real tool listed, gated tool hidden", names.includes(REAL_TOOL_NAME) && !names.includes(GATED_TOOL_NAME), names.join(","));
      const refused = JSON.parse(((await client.callTool({ name: GATED_TOOL_NAME, arguments: {} })).content as Array<{ text: string }>)[0].text);
      check("non-beta: direct call still gets feature_not_enabled", refused.error === "feature_not_enabled", JSON.stringify(refused));
      const real = JSON.parse(((await client.callTool({ name: REAL_TOOL_NAME, arguments: { echo: "e" } })).content as Array<{ text: string }>)[0].text);
      check("non-beta: the real tool registered afterwards still runs", real.echo === "e", JSON.stringify(real));
    }
    const betaClient = await connectedClient(gatedFirst(betaPrincipal));
    const betaNames = (await betaClient.listTools()).tools.map((t) => t.name);
    check("beta: both tools listed", betaNames.includes(REAL_TOOL_NAME) && betaNames.includes(GATED_TOOL_NAME), betaNames.join(","));
  });

  await section("F) SDK shape guard: the soft-private internals the interceptor needs still exist", async () => {
    const problem = mcpSdkGatingShapeProblem(new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } }));
    // If this fails after an SDK upgrade, tool-gating.ts must be updated before shipping: the
    // route keeps working (gated tools fall back to not-found) but the G14 envelope is lost.
    check("the installed @modelcontextprotocol/sdk still has server._requestHandlers (Map) + setToolRequestHandlers()", problem === null, String(problem));

    // Simulate a changed SDK: registerGatedTool must neither throw nor register the tool.
    const changed = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    const low = changed.server as unknown as Record<string, unknown>;
    const realHandlers = low._requestHandlers;
    low._requestHandlers = {};
    const originalWarn = console.warn;
    let warned = "";
    console.warn = (...parts: unknown[]) => { warned += parts.join(" "); };
    try {
      registerGatedTool(
        changed,
        nonBetaPrincipal,
        GATED_TOOL_NAME,
        { title: "Dummy gated tool", description: "test-only", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
        { next: "get_video_options" },
      );
      check("changed SDK shape: registerGatedTool does not throw", true);
    } catch (error) {
      check("changed SDK shape: registerGatedTool does not throw", false, String(error));
    } finally {
      console.warn = originalWarn;
      low._requestHandlers = realHandlers;
    }
    check("changed SDK shape: one warning names the problem", warned.includes("_requestHandlers"), warned);
    const registered = (changed as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    check("changed SDK shape: the gated tool was NOT registered (fail closed)", !(GATED_TOOL_NAME in registered));
  });

  await prisma.toolCallAudit.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error("FAIL: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("❌ MCP tool gating verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP tool gating: all checks passed");
    process.exit(0);
  });
