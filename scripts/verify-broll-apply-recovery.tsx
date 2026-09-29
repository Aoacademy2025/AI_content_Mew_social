import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const root = process.cwd();
const directory = mkdtempSync(join(tmpdir(), "hero-broll-apply-"));
const bundlePath = join(directory, "bundle.js");
const hookPath = resolve(root, "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts");

const entry = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePostPhaseEditor } from ${JSON.stringify(hookPath)};

const projectId = new URLSearchParams(location.search).get("project") ?? "project-a";
const preview = { videoUrl: "/source.mp4", preview: { captions: [], audioDurationMs: 4000,
  config: { bgVideos: [{ start: 0, end: 4, src: "/source.mp4" }] } } };
const job = { phase: "done", jobId: "source-job", projectId, contentPreflightId: null,
  output: preview, jobType: "preview", currentStep: null, progress: 100,
  queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null, mediaState: null };
window.__adopted = [];
const accountId = new URLSearchParams(location.search).get("account") ?? "account-a";
function Probe() {
  const [version, setVersion] = useState(0);
  const ed = usePostPhaseEditor(job, "", { projectId, accountId,
    narrativeSourceKind: "manual", onExportJob: async () => ({ ok: true }),
    onAdoptJob: (value) => window.__adopted.push(value), onNewProject: () => {} });
  useEffect(() => { window.__ed = ed; window.__version = version; });
  return <><button id="stage" onClick={() => ed.setWindowEdit(0, { src: "/new.mp4", kind: "upload" })}>stage</button>
    <button id="stage-new" onClick={() => ed.setWindowEdit(0, { src: "/newer.mp4", kind: "upload" })}>stage new</button>
    <button id="apply" onClick={() => void ed.applyWindowEdits()}>apply</button>
    <output id="phase">{JSON.stringify(ed.applyingWindows)}</output>
    <output id="edits">{ed.windowEdits.size}</output>
    <output id="label">{ed.applyingWindowsLabel}</output></>;
}
const root = createRoot(document.getElementById("root"));
root.render(<Probe />);
window.__unmount = () => root.unmount();
`;

async function main() {
  await build({ stdin: { contents: entry, loader: "tsx", resolveDir: root, sourcefile: "broll-apply-probe.tsx" },
    bundle: true, outfile: bundlePath, platform: "browser", format: "iife",
    banner: { js: "var process = { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "synthetic-auth-fetch", setup(plugin) {
      plugin.onResolve({ filter: /^@\/lib\/authenticated-fetch$/ }, () => ({ path: "auth-fetch", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const authenticatedFetch = (...args) => fetch(...args);",
        loader: "js",
      }));
    } }] });
  const bundle = readFileSync(bundlePath);
  const server = createServer((request, response) => {
    if (request.url === "/bundle.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(bundle); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const executablePath = process.env.CHROME_BIN || (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : puppeteer.executablePath());
  const browser = await puppeteer.launch({ executablePath, headless: true,
    args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("dialog", (dialog) => { void dialog.accept(); });
    await page.evaluateOnNewDocument(() => {
      const original = window.setTimeout;
      window.setTimeout = ((task: TimerHandler, ms?: number, ...args: unknown[]) =>
        original(task, ms === 2000 ? 0 : ms, ...args)) as typeof window.setTimeout;
      const storage = window.localStorage;
      storage.setItem("editor-v2-project-account", new URLSearchParams(location.search).get("account") ?? "account-a");
      let polls = 0;
      window.__postCount = 0;
      window.__postKeys = [];
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/videos/jobs" && init?.method === "POST") {
          window.__postCount++;
          const key = JSON.parse(String(init.body)).idempotencyKey;
          window.__postKeys.push(key);
          if (window.__postAmbiguous && window.__postCount === 1) throw new TypeError("connection lost after submit");
          return new Response(JSON.stringify({ jobId: "apply-job", idempotencyKey: key }), { status: 200 });
        }
        if (url === "/api/videos/jobs/apply-job") {
          polls++;
          window.__polls = polls;
          if (window.__pollHttpError) return new Response("{}", { status: 401 });
          if (window.__terminalStatus) return new Response(JSON.stringify({ id: "apply-job",
            projectId: "project-a", status: window.__terminalStatus, errorMessage: "synthetic terminal failure" }), { status: 200 });
          return new Response(JSON.stringify(!window.__finish
            ? { id: "apply-job", projectId: "project-a", status: window.__processing ? "processing" : "queued",
                queuePosition: 2, progress: window.__processing ? 37 : 0 }
            : { id: "apply-job", projectId: "project-a", status: "done", output: {
                videoUrl: "/done.mp4", preview: { config: { bgVideos: [{ start: 0, end: 4, src: "/new.mp4" }] } }
              } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
    });
    await page.goto(`http://127.0.0.1:${address.port}/video-editor`);
    await page.waitForSelector("#stage", { timeout: 5_000 }).catch((error) => {
      throw new Error(`probe failed to mount: ${errors.join(" | ")}`, { cause: error });
    });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => (window as unknown as { __polls?: number }).__polls! >= 450, { timeout: 30_000 });
    assert.deepEqual(errors, []);
    const after450 = await page.evaluate(() => ({
      phase: document.querySelector("#phase")?.textContent,
      edits: document.querySelector("#edits")?.textContent,
      adopted: (window as unknown as { __adopted: unknown[] }).__adopted.length,
    }));
    assert.match(after450.phase ?? "", /queued/, "a long queue remains pending after 450 polls");
    assert.equal(await page.$eval("#label", (element) => element.textContent), "รอคิวอัปเดต B-roll #2");
    assert.equal(after450.edits, "1", "submitted edits remain until done");
    await page.click("#stage-new");
    assert.equal(await page.evaluate(() => (window as unknown as { __ed: { windowEdits: Map<number, { src?: string }> } })
      .__ed.windowEdits.get(0)?.src), "/new.mp4", "editing is locked while an older apply is pending");
    await page.evaluate(() => { (window as unknown as { __processing: boolean }).__processing = true; });
    await page.waitForFunction(() => document.querySelector("#label")?.textContent === "กำลังอัปเดต B-roll 37%");
    await page.evaluate(() => { (window as unknown as { __finish: boolean }).__finish = true; });
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 1,
      { timeout: 30_000 });
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "0");
    console.log("PASS: real hook keeps the queued job past 450 polls and adopts eventual done");

    // A POST can commit before its response is lost. Retry must replay the saved key.
    await page.evaluate(() => {
      const state = window as unknown as { __finish: boolean; __postAmbiguous: boolean;
        __postCount: number; __postKeys: string[]; __processing: boolean };
      state.__finish = false; state.__postAmbiguous = true; state.__postCount = 0; state.__postKeys = [];
      state.__processing = false;
    });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("disconnected"));
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "1");
    const ambiguousKey = await page.evaluate(() => {
      const state = window as unknown as { __postKeys: string[] };
      return state.__postKeys[0];
    });
    await page.click("#apply");
    await page.waitForFunction(() => (window as unknown as { __postCount: number }).__postCount === 2);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __postKeys: string[] }).__postKeys),
      [ambiguousKey, ambiguousKey]);
    await page.evaluate(() => { (window as unknown as { __finish: boolean }).__finish = true; });
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 2);
    console.log("PASS: ambiguous POST replays the same operation identity");

    // A mounted editor can disappear while the VideoJob is queued; remount reads the journal.
    await page.evaluate(() => {
      const state = window as unknown as { __finish: boolean; __postAmbiguous: boolean };
      state.__finish = false; state.__postAmbiguous = false;
    });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("queued"));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("queued"));
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "1");
    assert.equal(await page.evaluate(() => (window as unknown as { __postCount: number }).__postCount), 0,
      "known job is polled after refresh without a new POST");
    await page.goto(`http://127.0.0.1:${address.port}/video-editor?account=account-b`);
    await page.waitForSelector("#stage");
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "0");
    assert.equal(await page.$eval("#phase", (element) => element.textContent), "null");
    assert.equal(await page.evaluate(() => (window as unknown as { __polls?: number }).__polls ?? 0), 0);
    await page.goto(`http://127.0.0.1:${address.port}/video-editor?account=account-a&project=project-b`);
    await page.waitForSelector("#stage");
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "0");
    assert.equal(await page.evaluate(() => (window as unknown as { __polls?: number }).__polls ?? 0), 0);
    await page.goto(`http://127.0.0.1:${address.port}/video-editor?account=account-a`);
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("queued"));
    assert.equal(await page.evaluate(() => (window as unknown as { __postCount: number }).__postCount), 0);
    await page.evaluate(() => { (window as unknown as { __finish: boolean }).__finish = true; });
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 1);
    console.log("PASS: refresh/remount resumes known job and isolates another account");

    // A genuine terminal job failure releases the logical operation but keeps staged edits.
    await page.evaluate(() => { (window as unknown as { __terminalStatus: string }).__terminalStatus = "failed"; });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => (window as unknown as { __polls: number }).__polls > 0
      && document.querySelector("#phase")?.textContent === "null");
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("editor-v2-broll-apply:account-a:project-a")), null);
    await page.evaluate(() => {
      const state = window as unknown as { __terminalStatus: string | null; __finish: boolean };
      state.__terminalStatus = null; state.__finish = true;
    });
    await page.click("#apply");
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 2);
    console.log("PASS: genuine failed job preserves edits for intentional retry");

    // An auth/transport interruption is uncertain, so resume polls the known job.
    await page.evaluate(() => {
      const state = window as unknown as { __finish: boolean; __pollHttpError: boolean; __postCount: number };
      state.__finish = false; state.__pollHttpError = true; state.__postCount = 0;
    });
    await page.click("#stage");
    await page.click("#apply");
    await page.click("#apply");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("disconnected"));
    assert.equal(await page.evaluate(() => (window as unknown as { __postCount: number }).__postCount), 1);
    await page.evaluate(() => {
      const state = window as unknown as { __finish: boolean; __pollHttpError: boolean };
      state.__pollHttpError = false; state.__finish = true;
    });
    await page.click("#apply");
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 3);
    assert.equal(await page.evaluate(() => (window as unknown as { __postCount: number }).__postCount), 1);
    console.log("PASS: interrupted status poll resumes without resubmission");

    // A refresh before the POST response is known replays its original key.
    await page.evaluate(() => {
      const state = window as unknown as { __finish: boolean; __postAmbiguous: boolean;
        __postCount: number; __postKeys: string[] };
      state.__finish = false; state.__postAmbiguous = true; state.__postCount = 0; state.__postKeys = [];
    });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("disconnected"));
    const keyBeforeRefresh = await page.evaluate(() => (window as unknown as { __postKeys: string[] }).__postKeys[0]);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent?.includes("queued"));
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __postKeys: string[] }).__postKeys),
      [keyBeforeRefresh]);
    await page.evaluate(() => { (window as unknown as { __finish: boolean }).__finish = true; });
    await page.waitForFunction(() => (window as unknown as { __adopted: unknown[] }).__adopted.length === 1);
    console.log("PASS: refresh after an uncertain POST replays the original key");

    await page.evaluate(() => { (window as unknown as { __terminalStatus: string }).__terminalStatus = "canceled"; });
    await page.click("#stage");
    await page.click("#apply");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent === "null");
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("editor-v2-broll-apply:account-a:project-a")), null);
    console.log("PASS: canceled job preserves edits and releases the operation");

    // Corrupt journal contents cannot be replaced by a fresh key and duplicate POST.
    await page.evaluate(() => {
      localStorage.setItem("editor-v2-broll-apply:account-a:project-a", "{broken");
      (window as unknown as { __postCount: number }).__postCount = 0;
    });
    await page.click("#apply");
    assert.equal(await page.evaluate(() => (window as unknown as { __postCount: number }).__postCount), 0);
    assert.equal(await page.$eval("#edits", (element) => element.textContent), "1");
    console.log("PASS: corrupt storage blocks unsafe fresh submission");
  } finally {
    await browser.close(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
