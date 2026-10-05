// HERO-70 (Sentry WEB-1E, WEB-J): an MCP client that hangs up mid-request must not leave an
// unhandled rejection in the web process — and nothing else may be swallowed.
//
// mcp-handler 1.1.0 runs each MCP request in a detached promise (`void fn(res)`), so:
//   - a client that disconnects while its body is still arriving makes the handler's own
//     `req.json()` reject with `Error: aborted` (ECONNRESET) → unhandledRejection;
//   - a client that disconnects while a slow tool runs makes Next cancel the response stream,
//     and the handler's later write throws `Controller is already closed` → unhandledRejection.
// Production saw both on 2026-10-04/05 while transactions stalled for 20-40 s.
//
// Runs the REAL mcp-handler (same createMcpHandler options as src/app/api/[transport]/route.ts)
// with a tool gated on a promise, and drives the client side the way Next does: abort the
// request signal and cancel the response stream. A control run WITHOUT the guard must reproduce
// both rejections (so this test can never pass vacuously); the guarded run must not.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-transport-disconnect.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMcpHandler } from "mcp-handler";
import { NextRequest } from "next/server";
import { withClientDisconnectGuard } from "../src/lib/mcp/transport-disconnect";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const URL_MCP = "http://localhost/api/mcp";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const toolCall = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

// One gate per scenario: the slow tool waits on it, like create_upload_url waiting on SQLite.
let gate: Promise<void> = Promise.resolve();
let toolRuns = 0;
let toolFinishes = 0;
const handler = createMcpHandler(
  (server) => {
    server.registerTool("slow", { title: "slow", description: "waits on the test gate", inputSchema: {} }, async () => {
      toolRuns += 1;
      await gate;
      toolFinishes += 1;
      return { content: [{ type: "text", text: "slow-done" }] };
    });
    server.registerTool("fast", { title: "fast", description: "returns at once", inputSchema: {} }, async () => (
      { content: [{ type: "text", text: "fast-done" }] }
    ));
  },
  { serverInfo: { name: "verify", version: "0.0.0" }, capabilities: { tools: {} } },
  { basePath: "/api", maxDuration: 60 },
);
const guarded = withClientDisconnectGuard(handler);

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });
const describe = (reason: unknown) => (reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, sleep(ms).then(() => "timeout" as const)]);
}

/** The client hangs up while the slow tool runs, after Next started streaming the response. */
async function hangUpDuringTool(route: (req: Request) => Promise<Response>): Promise<{ status: number | "timeout"; unhandled: string[]; finished: boolean }> {
  unhandled.length = 0;
  let open!: () => void;
  gate = new Promise((resolve) => { open = resolve; });
  const finishesBefore = toolFinishes;
  const client = new AbortController();
  const response = await withTimeout(route(new Request(URL_MCP, { method: "POST", headers: HEADERS, body: toolCall("slow"), signal: client.signal })), 2000);
  if (response === "timeout") return { status: "timeout", unhandled: [], finished: false };
  const reader = response.body!.getReader();
  // What Next does on a client disconnect: the request signal aborts and pipeTo cancels the body.
  client.abort();
  await reader.cancel();
  open();
  await sleep(200);
  return { status: response.status, unhandled: unhandled.map(describe), finished: toolFinishes > finishesBefore };
}

/** The client hangs up while its request body is still arriving. */
async function hangUpDuringBody(route: (req: Request) => Promise<Response>, error: Error, abortSignal: boolean) {
  unhandled.length = 0;
  const runsBefore = toolRuns;
  const client = new AbortController();
  const partial = new TextEncoder().encode(toolCall("slow").slice(0, 20));
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(partial); return; }
      if (abortSignal) client.abort();
      controller.error(error);
    },
  });
  const outcome = route(new Request(URL_MCP, {
    method: "POST", headers: HEADERS, body, signal: client.signal,
    // @ts-expect-error -- Node's Request needs duplex for a streamed body
    duplex: "half",
  })).then((response) => ({ status: response.status as number | "rejected", error: undefined as unknown }), (rejection: unknown) => ({ status: "rejected" as const, error: rejection }));
  const settled = await withTimeout(outcome, 500);
  await sleep(100);
  return { settled, unhandled: unhandled.map(describe), toolRan: toolRuns > runsBefore };
}

async function main(): Promise<void> {
  const disconnect = () => Object.assign(new Error("aborted"), { code: "ECONNRESET" });

  console.log("\nA) control: the unguarded handler reproduces both production rejections");
  {
    const response = await hangUpDuringTool(handler);
    check(
      "unguarded: hang-up during a slow tool → unhandled 'Controller is already closed'",
      response.unhandled.some((m) => /Controller is already closed/.test(m)),
      JSON.stringify(response),
    );
    const body = await hangUpDuringBody(handler, disconnect(), true);
    check(
      "unguarded: hang-up during the body → unhandled 'aborted'",
      body.unhandled.some((m) => /aborted/.test(m)),
      JSON.stringify(body),
    );
  }

  console.log("\nB) guarded: a disconnect leaves nothing unhandled");
  {
    const response = await hangUpDuringTool(guarded);
    check("hang-up during a slow tool: no unhandled rejection", response.status === 200 && response.unhandled.length === 0, JSON.stringify(response));
    check("…and the tool still ran to completion (its output was drained, not lost mid-write)", response.finished, JSON.stringify(response));
    const body = await hangUpDuringBody(guarded, disconnect(), true);
    check(
      "hang-up during the body: quiet 499, no unhandled rejection, tool never runs",
      body.settled !== "timeout" && body.settled.status === 499 && body.unhandled.length === 0 && !body.toolRan,
      JSON.stringify(body),
    );
    const resetOnly = await hangUpDuringBody(guarded, disconnect(), false);
    check(
      "an ECONNRESET body error is a disconnect even before the signal fires",
      resetOnly.settled !== "timeout" && resetOnly.settled.status === 499 && resetOnly.unhandled.length === 0,
      JSON.stringify(resetOnly),
    );
  }

  console.log("\nC) guarded: every other error still surfaces");
  {
    const boom = new Error("disk on fire");
    const body = await hangUpDuringBody(guarded, boom, false);
    check(
      "a non-disconnect body error rejects the request with that exact error",
      body.settled !== "timeout" && body.settled.status === "rejected" && body.settled.error === boom,
      JSON.stringify({ settled: body.settled === "timeout" ? "timeout" : body.settled.status }),
    );
    const streamBoom = new Error("handler stream broke");
    const broken = withClientDisconnectGuard(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      pull(controller) { controller.error(streamBoom); },
    }), { status: 200 }));
    let readError: unknown;
    try {
      await (await broken(new Request(URL_MCP, { method: "GET" }))).text();
    } catch (error) {
      readError = error;
    }
    check("a response stream that errors before any disconnect still errors the response", readError === streamBoom, describe(readError));
    unhandled.length = 0;
    const lateBoom = new Error("handler stream broke after the client left");
    let failInner!: () => void;
    const lateFailure = new Promise<void>((resolve) => { failInner = resolve; });
    const late = await withClientDisconnectGuard(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      async pull(controller) { await lateFailure; controller.error(lateBoom); },
    }), { status: 200 }))(new Request(URL_MCP, { method: "GET" }));
    const lateReader = late.body!.getReader();
    await lateReader.read();
    await lateReader.cancel();
    failInner();
    await sleep(50);
    check("a non-disconnect error while draining after a hang-up still surfaces (not swallowed)", unhandled.includes(lateBoom), unhandled.map(describe).join(" | "));
    const thrown = new Error("handler threw");
    let routeError: unknown;
    try {
      await withClientDisconnectGuard(async () => { throw thrown; })(new Request(URL_MCP, { method: "POST", headers: HEADERS, body: "{}" }));
    } catch (error) {
      routeError = error;
    }
    check("an exception from the handler itself is rethrown untouched", routeError === thrown, describe(routeError));
  }

  console.log("\nD) guarded: normal traffic is unchanged");
  {
    unhandled.length = 0;
    const plain = await handler(new Request(URL_MCP, { method: "POST", headers: HEADERS, body: toolCall("fast") }));
    const plainBody = await plain.text();
    const wrapped = await guarded(new Request(URL_MCP, { method: "POST", headers: HEADERS, body: toolCall("fast") }));
    const wrappedBody = await wrapped.text();
    check("same status", plain.status === wrapped.status && wrapped.status === 200, `${plain.status} vs ${wrapped.status}`);
    check("same content-type", plain.headers.get("content-type") === wrapped.headers.get("content-type"), `${plain.headers.get("content-type")} vs ${wrapped.headers.get("content-type")}`);
    check("same body", plainBody === wrappedBody && wrappedBody.includes("fast-done"), wrappedBody.slice(0, 200));
    const get = await guarded(new Request(URL_MCP, { method: "GET", headers: { accept: "text/event-stream" } }));
    const getPlain = await handler(new Request(URL_MCP, { method: "GET", headers: { accept: "text/event-stream" } }));
    check("a bodyless GET passes through with the same status", get.status === getPlain.status, `${get.status} vs ${getPlain.status}`);
    await get.body?.cancel();
    await getPlain.body?.cancel();
    // Production hands the route a NextRequest with a streamed body, and withMcpAuth has set
    // `auth` on it. The guard must pass that SAME object on, body still readable.
    const chunks = ['{"jsonrpc":"2.0",', '"id":1,"method":"ping"}'];
    let next = 0;
    const streamed = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[next++]));
        else controller.close();
      },
    });
    const nextRequest = new NextRequest(URL_MCP, {
      method: "POST", headers: HEADERS, body: streamed,
      // @ts-expect-error -- Node's Request needs duplex for a streamed body
      duplex: "half",
    });
    const authInfo = { clientId: "verify-user" };
    Object.assign(nextRequest, { auth: authInfo });
    let seen: { same: boolean; auth: unknown; path: string; body: unknown } | undefined;
    await withClientDisconnectGuard(async (req) => {
      seen = { same: req === nextRequest, auth: (req as { auth?: unknown }).auth, path: (req as NextRequest).nextUrl.pathname, body: await req.json() };
      return new Response(null, { status: 204 });
    })(nextRequest);
    check(
      "a streamed NextRequest reaches the handler as the same object, auth and full body intact",
      seen?.same === true && seen.auth === authInfo && seen.path === "/api/mcp" && JSON.stringify(seen.body) === chunks.join(""),
      JSON.stringify(seen),
    );
    await sleep(50);
    check("no unhandled rejection from normal traffic", unhandled.length === 0, unhandled.map(describe).join(" | "));
  }

  console.log("\nE) the MCP route is wrapped");
  {
    const route = readFileSync(path.join(__dirname, "..", "src", "app", "api", "[transport]", "route.ts"), "utf8");
    check("route.ts imports the guard", /from "@\/lib\/mcp\/transport-disconnect"/.test(route));
    check(
      "the guard sits inside withMcpAuth (no body read before auth) and the route still exports the auth handler",
      /withMcpAuth\(withClientDisconnectGuard\(handler\), verifyToken,/.test(route)
        && /runWithRequestPrincipalSlot\(\(\) => authHandler\(req\)\)/.test(route)
        && /export \{ routeHandler as GET, routeHandler as POST, routeHandler as DELETE \};/.test(route),
    );
  }

  console.log(`\nverify-mcp-transport-disconnect: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
