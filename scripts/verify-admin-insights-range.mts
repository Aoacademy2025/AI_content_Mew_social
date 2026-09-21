import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const baseline = process.argv.includes("--baseline");
const root = process.cwd();
const pagePath = "src/app/(dashboard)/admin/insights/page.tsx";
const baselinePage = baseline
  ? execFileSync("git", ["show", `2f1208e189c8263995b898490eefd2bb9a1b5631:${pagePath}`], { cwd: root, encoding: "utf8" })
  : "";

const navigationFixture = `
  import { useSyncExternalStore } from "react";
  let lastSearch = "";
  let lastParams = new URLSearchParams();
  const snapshot = () => {
    if (lastSearch !== location.search) {
      lastSearch = location.search;
      lastParams = new URLSearchParams(lastSearch);
    }
    return lastParams;
  };
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name].bind(history);
    history[name] = (...args) => {
      const result = original(...args);
      dispatchEvent(new Event("fixture-url-change"));
      return result;
    };
  }
  const subscribe = (callback) => {
    addEventListener("popstate", callback);
    addEventListener("fixture-url-change", callback);
    return () => {
      removeEventListener("popstate", callback);
      removeEventListener("fixture-url-change", callback);
    };
  };
  export function useSearchParams() {
    return useSyncExternalStore(subscribe, snapshot, () => new URLSearchParams());
  }
`;

const bundle = await build({
  stdin: {
    contents: `import React from "react"; import { createRoot } from "react-dom/client"; import AdminInsightsPage from ${JSON.stringify(baseline ? "fixture-baseline-page" : `./${pagePath}`)}; createRoot(document.getElementById("root")).render(<AdminInsightsPage />);`,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  jsx: "automatic",
  define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "insights-fixture-seams",
    setup(context) {
      context.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "fixture" }));
      context.onResolve({ filter: /^fixture-baseline-page$/ }, () => ({ path: "baseline-page", namespace: "fixture" }));
      context.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        loader: "tsx",
        resolveDir: root,
        contents: args.path === "next/navigation" ? navigationFixture : baselinePage,
      }));
    },
  }],
});

type RequestRecord = { days: number; id: number };

const requests: RequestRecord[] = [];
let deferred: { days: number; release: Promise<void> } | null = null;

function response(days: number, id: number) {
  const videoJobs = {
    total: 0, settled: 0, inFlight: 0, completed: 0, processing: 0, failed: 0, pending: 0,
    canceled: 0, outputReady: 0, statusStuckWithOutput: 0, processingWithoutOutput: 0, completionPct: 0, outputReadyPct: 0,
  };
  const summary = {
    totals: {
      sessions: 0, users: 0, editorSessions: 0, editorOpens: 0, pipelineJobs: 0, pipelineStarts: 0,
      events: days, errors: 0, byokErrorCount: 0, quotaErrorCount: 0, rawErrors: 0, noiseEvents: 0,
      frontendErrors: 0, serverErrors: 0, renderSuccessPct: 0, videoCompletionPct: 0, renderTaskSuccessPct: 0,
      healthScore: 100, funnelMode: "run", funnelRuns: 0, videoJobs,
    },
    funnel: [], steps: [], errors: [], byokErrors: [], noise: [], vitals: [], vitalsMeasurementVersion: "fixture",
    broll: {}, playback: {}, staleProcessing: { total: 0, completeCandidates: 0, failCandidates: 0, existingOutput: 0, oldestAgeMinutes: null },
    telemetry: { truncated: false, readRows: 0, cap: 0 }, recommendations: [`range fixture ${days}-${id}`],
  };
  return { range: { days, since: "", until: "" }, current: summary, previous: summary };
}

const server = createServer(async (request, result) => {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  if (url.pathname === "/app.js") {
    result.writeHead(200, { "Content-Type": "application/javascript" });
    result.end(bundle.outputFiles[0].text);
    return;
  }
  if (url.pathname === "/api/admin/insights") {
    const record = { days: Number(url.searchParams.get("days")), id: requests.length + 1 };
    requests.push(record);
    if (deferred?.days === record.days) await deferred.release;
    result.writeHead(200, { "Content-Type": "application/json" });
    result.end(JSON.stringify(response(record.days, record.id)));
    return;
  }
  result.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
  result.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T | null, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await wait(20);
  }
  throw new Error(message);
}

function label(days: number) { return days === 1 ? "24 ชม." : `${days} วัน`; }

async function clickRange(page: import("puppeteer").Page, days: number) {
  const clicked = await page.evaluate((text) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
    button?.click();
    return Boolean(button);
  }, label(days));
  assert.ok(clicked, `the ${days}-day range control is available`);
}

async function assertActiveRange(page: import("puppeteer").Page, days: number) {
  const className = await page.evaluate((text) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text)?.className ?? "", label(days));
  assert.match(className, /bg-white/, `${days}-day control is visibly selected`);
}

async function waitForFixture(page: import("puppeteer").Page, record: RequestRecord) {
  const marker = `range fixture ${record.days}-${record.id}`;
  await page.waitForFunction((value) => document.body.textContent?.includes(value), {}, marker);
  return marker;
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
let releaseSlow: (() => void) | null = null;
try {
  browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [] });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/admin/insights?days=30`);
  const direct = await waitFor(() => requests[0] ?? null, "Insights did not request its initial range");
  assert.equal(direct.days, 30, "a direct ?days=30 load requests the 30-day API range");
  await waitForFixture(page, direct);
  await assertActiveRange(page, 30);
  if (baseline) throw new Error("baseline unexpectedly honored ?days=30");

  const beforeMissing = requests.length;
  await page.goto(`http://127.0.0.1:${port}/admin/insights`);
  const missing = await waitFor(() => requests.slice(beforeMissing).find((record) => record.days === 1) ?? null, "a missing range did not fall back to one day");
  await waitForFixture(page, missing);
  await assertActiveRange(page, 1);

  const beforeInvalid = requests.length;
  await page.goto(`http://127.0.0.1:${port}/admin/insights?source=fixture&days=2`);
  const invalid = await waitFor(() => requests.slice(beforeInvalid).find((record) => record.days === 1) ?? null, "an unsupported range did not fall back to one day");
  await waitForFixture(page, invalid);
  await assertActiveRange(page, 1);

  const beforeDuplicate = requests.length;
  await page.goto(`http://127.0.0.1:${port}/admin/insights?days=7&days=30`);
  const duplicate = await waitFor(() => requests.slice(beforeDuplicate).find((record) => record.days === 1) ?? null, "a duplicate range did not fall back to one day");
  await waitForFixture(page, duplicate);
  await assertActiveRange(page, 1);

  const beforeReturnToInvalid = requests.length;
  await page.goto(`http://127.0.0.1:${port}/admin/insights?source=fixture&days=2`);
  const returnedInvalid = await waitFor(() => requests.slice(beforeReturnToInvalid).find((record) => record.days === 1) ?? null, "the invalid range did not remain bounded when revisited");
  await waitForFixture(page, returnedInvalid);

  const beforeSeven = requests.length;
  await clickRange(page, 7);
  const selectedSeven = await waitFor(() => requests.slice(beforeSeven).find((record) => record.days === 7) ?? null, "selecting 7 days did not call the 7-day API range");
  await waitForFixture(page, selectedSeven);
  assert.match(page.url(), /\/admin\/insights\?source=fixture&days=7$/, "selection writes the selected range and preserves other URL state");
  await assertActiveRange(page, 7);

  const beforeReload = requests.length;
  await page.reload();
  const reloadedSeven = await waitFor(() => requests.slice(beforeReload).find((record) => record.days === 7) ?? null, "reload did not retain the seven-day API range");
  await waitForFixture(page, reloadedSeven);
  await assertActiveRange(page, 7);

  const beforeThirty = requests.length;
  await clickRange(page, 30);
  const selectedThirty = await waitFor(() => requests.slice(beforeThirty).find((record) => record.days === 30) ?? null, "selecting 30 days did not call the 30-day API range");
  await waitForFixture(page, selectedThirty);
  const beforeBack = requests.length;
  await page.goBack();
  const backSeven = await waitFor(() => requests.slice(beforeBack).find((record) => record.days === 7) ?? null, "back navigation did not restore seven days");
  await waitForFixture(page, backSeven);
  await assertActiveRange(page, 7);
  const beforeForward = requests.length;
  await page.goForward();
  const forwardThirty = await waitFor(() => requests.slice(beforeForward).find((record) => record.days === 30) ?? null, "forward navigation did not restore 30 days");
  await waitForFixture(page, forwardThirty);
  await assertActiveRange(page, 30);

  let release!: () => void;
  deferred = { days: 7, release: new Promise<void>((resolve) => { release = resolve; }) };
  releaseSlow = release;
  const beforeSlow = requests.length;
  await clickRange(page, 7);
  await waitFor(() => requests.slice(beforeSlow).find((record) => record.days === 7) ?? null, "the stale-response fixture never received seven days");
  const beforeFresh = requests.length;
  await clickRange(page, 30);
  const freshThirty = await waitFor(() => requests.slice(beforeFresh).find((record) => record.days === 30) ?? null, "a newer 30-day request did not follow the slow seven-day request");
  const freshMarker = await waitForFixture(page, freshThirty);
  release();
  deferred = null;
  await wait(100);
  assert.equal(await page.evaluate(() => document.body.textContent?.includes("range fixture 7-")), false, "a superseded seven-day response cannot replace newer data");
  assert.equal(await page.evaluate((marker) => document.body.textContent?.includes(marker), freshMarker), true, "the latest response remains visible after the stale response arrives");
  assert.deepEqual(errors, [], "the real Insights component produced no browser errors in the local fixture");

  console.log("verify-admin-insights-range: PASS — direct URL, selection, reload, back/forward, and stale response use the real Insights component");
} finally {
  releaseSlow?.();
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
