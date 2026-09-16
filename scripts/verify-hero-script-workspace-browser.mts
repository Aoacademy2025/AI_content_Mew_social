import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const port = 8994;
const root = process.cwd();
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import HeroScriptPage from './src/app/(dashboard)/hero-script/page'; createRoot(document.getElementById('root')).render(<HeroScriptPage/>);`, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "fixture-stubs", setup(b) {
    b.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/use-me|@\/lib\/client-telemetry|@\/lib\/authenticated-fetch|sonner)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
      loader: "tsx", resolveDir: root,
      contents: args.path === "next/link" ? `export default function Link(p){return <a {...p}/>} `
        : args.path === "next/navigation" ? `export function useRouter(){return {push:(url)=>{window.__fixtureManageUrl=url;(window.__fixtureRoutes??=[]).push(url)}}}`
          : args.path === "@/lib/use-me" ? `export async function fetchMe(){return {id:'fixture-account',plan:'PRO'}}`
            : args.path === "@/lib/authenticated-fetch" ? `export const authenticatedFetch=fetch`
              : args.path === "sonner" ? `export const toast={error:()=>{},success:()=>{},warning:()=>{}}`
                : `export const trackEvent=()=>{}`,
    }));
  } }],
});
const js = bundle.outputFiles[0].text;

type FixtureScript = {
  id: string; topic: string; durationSec: number; hookFormula: string | null; structure: string | null;
  hookText: string; bodyText: string; ctaText: string; status: string; brandProfileId: string | null;
  editorProjectId: string | null; editorProjectAvailable: boolean; createdAt: string; updatedAt: string;
};
const iso = "2026-09-17T00:00:00.000Z";
const script = (value: Partial<FixtureScript> & Pick<FixtureScript, "id" | "topic">): FixtureScript => ({
  durationSec: 60, hookFormula: "question-poll", structure: "how-to", hookText: `Hook ${value.topic}`,
  bodyText: `Body ${value.topic}`, ctaText: `CTA ${value.topic}`, status: "draft", brandProfileId: null,
  editorProjectId: null, editorProjectAvailable: false, createdAt: iso, updatedAt: iso, ...value,
});
const records = new Map<string, FixtureScript>([
  ["recent-draft", script({ id: "recent-draft", topic: "Recent fixture", durationSec: 90 })],
  ["fast-record", script({ id: "fast-record", topic: "Fast detail", durationSec: 30, brandProfileId: "legacy-revision-zero" })],
  ["slow-record", script({ id: "slow-record", topic: "Slow detail" })],
  ["sent-record", script({ id: "sent-record", topic: "Sent available", status: "sent", editorProjectId: "owned-project", editorProjectAvailable: true })],
  ["missing-record", script({ id: "missing-record", topic: "Sent missing", status: "sent" })],
  ["delete-race", script({ id: "delete-race", topic: "Delete race" })],
]);
let legacyUpdate: Record<string, unknown> | null = null;
let createCount = 0;
let libraryListCount = 0;
const detailGets: string[] = [];
const saveBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
const handoffPosts: string[] = [];
let nextSaveDelayMs = 0;
let failNextSave = false;
let nextHandoffDelayMs = 0;
let slowDetailDelayMs = 0;

const html = `<!doctype html><html class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  if (url.pathname === "/app.js") { res.end(js); return; }
  if (url.pathname.startsWith("/api/brand-profiles/") && req.method === "PUT") {
    const body = await readBody();
    if (url.pathname.endsWith("published-profile")) return json({ code: "VERSIONED_PROFILE_READ_ONLY", error: "read only", manageUrl: "/brands" }, 409);
    legacyUpdate = body; return json({ id: "legacy-revision-zero", ...body });
  }
  if (url.pathname === "/api/brand-profiles" && req.method === "GET") return setTimeout(() => json([
    { id: "legacy-revision-zero", name: "Legacy fixture", niche: "niche", audience: "audience", tone: "tone", bannedWords: [], ctaStyle: "follow", language: "th", sampleText: null, sampleUrl: null, analysisNotes: "notes", createdAt: "", updatedAt: "" },
    { id: "published-profile", name: "Published fixture", niche: "niche", audience: "audience", tone: "tone", bannedWords: [], ctaStyle: "follow", language: "th", sampleText: null, sampleUrl: null, analysisNotes: "notes", createdAt: "", updatedAt: "" },
  ]), 500);
  if (url.pathname === "/api/scripts/library") {
    const summaries = [...records.values()].map((row) => ({
      id: row.id, topic: row.topic, brandProfileId: row.brandProfileId,
      brandName: row.brandProfileId ? "Legacy fixture" : null,
      durationSec: row.durationSec, status: row.status,
      editorProjectId: row.editorProjectId, editorProjectAvailable: row.editorProjectAvailable,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    if (url.searchParams.get("status") === "draft" && url.searchParams.get("pageSize") === "1") {
      const item = summaries.find((row) => row.id === "recent-draft");
      return json({ items: item ? [item] : [], brandOptions: [], total: item ? 1 : 0, page: 1, pageSize: 1, hasNextPage: false });
    }
    libraryListCount += 1;
    return json({ items: summaries, brandOptions: [{ id: "legacy-revision-zero", name: "Legacy fixture" }], total: summaries.length, page: 1, pageSize: 20, hasNextPage: false });
  }
  if (url.pathname === "/api/scripts/hooks") return json({ hooks: [{ formula: "question-poll", text: "Hook fixture" }] });
  if (url.pathname === "/api/scripts/generate") return json({ structure: "how-to", bodyText: "Body fixture", ctaText: "CTA fixture" });
  const handoffMatch = url.pathname.match(/^\/api\/scripts\/([^/]+)\/send-to-editor$/);
  if (handoffMatch && req.method === "POST") {
    const id = decodeURIComponent(handoffMatch[1]);
    handoffPosts.push(id);
    const delay = nextHandoffDelayMs; nextHandoffDelayMs = 0;
    if (delay) await wait(delay);
    const current = records.get(id);
    if (!current) return json({ error: "missing" }, 404);
    records.set(id, { ...current, status: "sent", editorProjectId: `project-${handoffPosts.length}`, editorProjectAvailable: true });
    return json({ projectId: `project-${handoffPosts.length}` });
  }
  const detailMatch = url.pathname.match(/^\/api\/scripts\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const id = decodeURIComponent(detailMatch[1]); detailGets.push(id);
    if ((id === "slow-record" || id === "delete-race") && slowDetailDelayMs) await wait(slowDetailDelayMs);
    const current = records.get(id);
    return current ? json(current) : json({ error: "missing" }, 404);
  }
  if (detailMatch && req.method === "PUT") {
    const id = decodeURIComponent(detailMatch[1]); const body = await readBody();
    saveBodies.push({ id, body });
    const delay = nextSaveDelayMs; nextSaveDelayMs = 0;
    if (delay) await wait(delay);
    if (failNextSave) { failNextSave = false; return json({ error: "save failed" }, 500); }
    const current = records.get(id);
    if (!current) return json({ error: "missing" }, 404);
    const updated = { ...current, ...body, id, updatedAt: new Date().toISOString() } as FixtureScript;
    records.set(id, updated); return json(updated);
  }
  if (detailMatch && req.method === "DELETE") {
    const id = decodeURIComponent(detailMatch[1]); records.delete(id); return json({ message: "deleted" });
  }
  if (url.pathname === "/api/scripts" && req.method === "POST") {
    const body = await readBody(); const id = `draft-${++createCount}`;
    const created = script({ ...body, id, status: "draft", topic: String(body.topic) });
    records.set(id, created); return json(created, 201);
  }
  if (url.pathname.startsWith("/api/")) return json({});
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html);
});

await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(() => localStorage.setItem("hero-script-writing:fixture-account", JSON.stringify({ profileId: "legacy-revision-zero", durationSec: 90 })));
  await page.goto(`http://127.0.0.1:${port}/hero-script`);
  await page.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "", "recent summary never auto-opens the record");
  assert.deepEqual(detailGets, [], "initial recovery metadata does not fetch a full record");
  assert.equal(libraryListCount, 0, "the hidden library does not load its full page");

  const duration = page.locator('[role="combobox"]');
  await duration.click();
  await page.locator('::-p-text(30 วิ)').click();
  await page.locator('::-p-text(ทำร่างล่าสุดต่อ)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Recent fixture");
  assert.deepEqual(detailGets, ["recent-draft"], "explicit recovery fetches the full owned detail once");
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  assert.equal(await page.$eval('[role="combobox"]', (element) => element.textContent), "30 วิ", "historical restore does not replace explicit new-writing defaults");

  assert.equal(await page.evaluate(() => document.body.innerText.includes("เลือก Hook")), false, "Hook is hidden before a topic");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("h2")].some((heading) => heading.textContent === "สคริปต์เต็ม" && heading.getClientRects().length > 0)), false, "full script is hidden before a Hook");
  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("หัวข้อทดสอบ");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();
  await page.locator('::-p-text(สร้างสคริปต์เต็ม)').click();
  await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some((node) => node.value === "Body fixture"));
  await page.waitForFunction(() => document.body.innerText.includes("บันทึกแล้ว"));
  const fullLibraryCallsBeforeEdit = libraryListCount;
  await page.evaluate(() => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].find((node) => node.value === "Body fixture")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "Body edited");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval('[role="tab"][aria-selected="false"]', (element) => (element as HTMLElement).click());
  await page.waitForFunction(() => document.body.innerText.includes("Fast detail"));
  await new Promise((resolve) => setTimeout(resolve, 1_350));
  assert.equal(records.get("draft-1")?.bodyText, "Body edited", "the mounted save owner commits while the writing tab is hidden");
  assert.equal(libraryListCount, fullLibraryCallsBeforeEdit + 1, "opening the library loads one page instead of refreshing for hidden edits");
  await page.$eval('[role="tab"][aria-selected="false"]', (element) => { (element as HTMLElement).focus(); (element as HTMLElement).click(); });
  assert.deepEqual(await page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).map((input) => input.value).slice(-3)), ["Hook fixture", "Body edited", "CTA fixture"]);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="หัวข้อสคริปต์"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.body.textContent?.includes("ร่างเดิมยังอยู่"));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("h2")].some((heading) => heading.textContent === "เลือก Hook" && heading.getClientRects().length > 0)), false);
  assert.equal(await page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.some((input) => input.value === "Body edited")), true, "new-generation context keeps the mounted draft");
  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("หัวข้อใหม่");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();

  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  const createsBeforeBrief = createCount;
  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("Brief fixture");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();
  await page.evaluate(() => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].find((node) => node.getClientRects().length > 0)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "Edited brief hook");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.locator('[role="tab"]::-p-text(เขียนสคริปต์)').click();
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Brief fixture", "ordinary tab changes do not prompt or discard");
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.waitForFunction(() => document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?"));
  await page.locator('button::-p-text(ยกเลิก)').click();
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Brief fixture");
  assert.equal(await page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.some((input) => input.value === "Edited brief hook")), true, "cancel preserves the exact selected Hook edit");
  assert.equal(createCount, createsBeforeBrief, "pre-generation input never creates a blank Script row");
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  assert.equal(createCount, createsBeforeBrief, "explicit discard still creates no Script row");

  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("Brief before open");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();
  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Fast detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?"));
  await page.locator('button::-p-text(ยกเลิก)').click();
  await page.locator('[role="tab"]::-p-text(เขียนสคริปต์)').click();
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Brief before open", "canceling record replacement preserves the unsaved brief");
  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Fast detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Fast detail");

  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  slowDetailDelayMs = 350;
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Slow detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => document.body.textContent?.includes("กำลังเปิด") || true);
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Sent available"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Sent available");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Sent available", "a delayed prior detail cannot replace the newest selection");

  const handoffsBeforeOpen = handoffPosts.length;
  await page.locator('button::-p-text(เปิดงานตัดต่อเดิม)').click();
  await page.waitForFunction(() => (window as unknown as { __fixtureManageUrl?: string }).__fixtureManageUrl?.includes("owned-project"));
  assert.equal(handoffPosts.length, handoffsBeforeOpen, "opening an existing project performs zero handoff POSTs");
  nextHandoffDelayMs = 250;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("สร้างงานตัดต่อใหม่"))!;
    button.click(); button.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(handoffPosts.length, handoffsBeforeOpen + 1, "explicit create-new sends exactly one POST while pending");

  await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter((node) => node.getClientRects().length > 0);
    const input = visible.slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "Latest before another record");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  nextSaveDelayMs = 250;
  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  const detailCountBeforeMissing = detailGets.length;
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Sent missing"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(detailGets.length, detailCountBeforeMissing, "opening another record waits for the latest serialized save");
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Sent missing");
  assert.equal(records.get("sent-record")?.bodyText, "Latest before another record");
  assert.equal(await page.evaluate(() => document.body.innerText.includes("งานตัดต่อเดิมไม่พร้อมใช้งาน")), true, "missing projects remain truthful and offer explicit create-new");

  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Fast detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Fast detail");
  await page.setViewport({ width: 320, height: 844 });
  assert.equal(await page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).slice(-3).every((input) => Number.parseFloat(getComputedStyle(input).fontSize) >= 16)), true, "editable Hook/body/CTA text stays at least 16px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "editor actions do not cause 320px horizontal scrolling");
  const fillBodyEditor = async (value: string) => page.evaluate((next) => {
    const visible = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter((node) => node.getClientRects().length > 0);
    const input = visible.slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const readBodyEditor = async () => page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).slice(-3)[1]?.value);
  await fillBodyEditor("Latest before failed handoff");
  failNextSave = true;
  const handoffsBeforeFailure = handoffPosts.length;
  await page.locator('button::-p-text(ส่งไปตัดต่อ)').click();
  await page.waitForFunction(() => document.body.innerText.includes("บันทึกไม่สำเร็จ ลองอีกครั้ง"));
  assert.equal(handoffPosts.length, handoffsBeforeFailure, "a failed latest save blocks stale handoff");
  assert.equal(await readBodyEditor(), "Latest before failed handoff", "save failure preserves working text");
  const routesBeforeRetry = await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  nextSaveDelayMs = 250;
  await page.locator('button::-p-text(ส่งไปตัดต่อ)').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(handoffPosts.length, handoffsBeforeFailure, "handoff waits for a delayed latest save");
  await page.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeRetry);
  assert.equal(records.get("fast-record")?.bodyText, "Latest before failed handoff", "handoff follows the latest committed body");
  assert.equal(handoffPosts.length, handoffsBeforeFailure + 1);

  await fillBodyEditor("Delayed replacement body");
  nextSaveDelayMs = 300;
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Fast detail", "replacement waits for delayed serialized save");
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  assert.equal(records.get("fast-record")?.bodyText, "Delayed replacement body");

  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Fast detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Fast detail");
  await fillBodyEditor("Unsaved replacement body");
  failNextSave = true;
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.waitForFunction(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้"));
  await page.locator('button::-p-text(ยกเลิก)').click();
  assert.equal(await readBodyEditor(), "Unsaved replacement body", "cancel after save failure keeps the exact working text");
  failNextSave = true;
  await page.locator('::-p-text(สคริปต์ใหม่)').click();
  await page.waitForFunction(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้"));
  await page.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");

  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  slowDetailDelayMs = 400;
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Delete race"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await page.evaluate(() => {
    const article = [...document.querySelectorAll("article")].find((node) => node.textContent?.includes("Delete race"))!;
    (article.querySelector("summary") as HTMLElement).click();
    ([...article.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("ลบสคริปต์")))?.click();
  });
  await page.waitForFunction(() => document.body.textContent?.includes("ลบสคริปต์นี้?"));
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "ลบ" && button.getClientRects().length > 0)?.click());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(records.has("delete-race"), false);
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "", "delete invalidates a racing detail response without clearing a newer writer");

  await page.locator('[role="tab"]::-p-text(เขียนสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("summary")].find((summary) => summary.textContent?.includes("วิธีใช้"))?.click());
  await page.waitForFunction(() => localStorage.getItem("hero-script-guide:fixture-account") === "open");
  assert.equal(await page.evaluate(() => localStorage.getItem("hero-script-guide:fixture-account")), "open");
  await page.evaluate(() => [...document.querySelectorAll("summary")].find((summary) => summary.textContent?.includes("จัดการโปรไฟล์"))?.click());
  await page.waitForFunction(() => document.body.textContent?.includes("Legacy fixture"));
  await page.locator('button[aria-label="แก้ไข Legacy fixture"]').click();
  await page.locator('input[placeholder="เช่น ช่องการเงิน"]').fill("Legacy edited");
  await page.locator('input[placeholder*="การเงินสาย"]').fill("niche edited");
  await page.locator('input[placeholder*="มนุษย์เงินเดือน"]').fill("audience edited");
  await page.locator('input[placeholder*="เป็นกันเอง"]').fill("tone edited");
  await page.locator('textarea[placeholder="แนวทางเพิ่มเติมสำหรับการเขียน"]').fill("notes edited");
  await page.locator('textarea[placeholder*="โกหก"]').fill("word-a, word-b");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "บันทึก")?.click());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(legacyUpdate && { niche: legacyUpdate.niche, audience: legacyUpdate.audience, tone: legacyUpdate.tone, bannedWords: legacyUpdate.bannedWords, ctaStyle: legacyUpdate.ctaStyle, analysisNotes: legacyUpdate.analysisNotes }, { niche: "niche edited", audience: "audience edited", tone: "tone edited", bannedWords: ["word-a", "word-b"], ctaStyle: "follow", analysisNotes: "notes edited" });
  await page.locator('button[aria-label="แก้ไข Published fixture"]').click();
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "บันทึก")?.click());
  await page.waitForFunction(() => (window as unknown as { __fixtureManageUrl?: string }).__fixtureManageUrl === "/brands");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(saveBodies.some(({ body }) => body.bodyText === "Latest before failed handoff"), true);
  console.log("verify-hero-script-workspace-browser: PASS explicit recovery, mounted saves, replacement guards, detail/delete races, and handoff semantics");
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
