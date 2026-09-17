import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import puppeteer from "puppeteer";
import tailwindcss from "@tailwindcss/postcss";

const port = 8994;
const root = process.cwd();
// This fixture mounts the client page directly to keep Clerk/Prisma outside the
// browser seam. Compile the actual product stylesheet so viewport measurements
// and screenshots exercise the shipped theme and responsive utilities.
const productCss = (await postcss([tailwindcss()]).process(
  readFileSync("src/app/globals.css", "utf8"),
  { from: "src/app/globals.css" },
)).css;
// Faithful dashboard viewport allocation for the isolated client fixture:
// TopNav is 64px, the desktop Sidebar is 240px, and mobile BottomTabs reserve
// 64px. Server-only shell data/auth stays out of this browser seam.
const dashboardShellCss = `
  body { margin: 0; }
  .fixture-shell { display: flex; height: 100vh; flex-direction: column; overflow: hidden; background: hsl(var(--background)); }
  .fixture-topbar { height: 64px; flex: 0 0 64px; border-bottom: 1px solid var(--ui-nav-border); background: var(--ui-nav-bg); }
  .fixture-shell-body { display: flex; min-height: 0; flex: 1; overflow: hidden; }
  .fixture-sidebar { display: none; flex: 0 0 240px; border-right: 1px solid var(--ui-sidebar-border); background: var(--ui-sidebar-bg); }
  .fixture-main { display: flex; min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
  .fixture-root { display: flex; min-width: 0; min-height: 0; flex: 1; }
  .fixture-bottom-tabs { height: 64px; flex: 0 0 64px; border-top: 1px solid var(--ui-nav-border); background: var(--ui-nav-bg); }
  @media (min-width: 1024px) { .fixture-sidebar { display: block; } .fixture-bottom-tabs { display: none; } }
`;
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
              : args.path === "sonner" ? `export const toast={error:(message)=>(window.__fixtureToasts??=[]).push(String(message)),success:()=>{},warning:()=>{}}`
                : `export const trackEvent=()=>{}`,
    }));
  } }],
});
const js = bundle.outputFiles[0].text;
const lockedBundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {HeroScriptLockedPreview} from './src/app/(dashboard)/hero-script/_components/HeroScriptLockedPreview'; createRoot(document.getElementById('root')).render(<HeroScriptLockedPreview entitlementSource="fixture" isTrial={true}/>);`, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "locked-fixture-stubs", setup(b) {
    b.onResolve({ filter: /^(next\/link|@\/lib\/client-telemetry)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
      loader: "tsx", resolveDir: root,
      contents: args.path === "next/link" ? `export default function Link(p){return <a {...p}/>} ` : `export const trackEvent=()=>{}`,
    }));
  } }],
});
const lockedJs = lockedBundle.outputFiles[0].text;

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
const profileFixtures = Array.from({ length: 20 }, (_, index) => ({
  id: index === 0 ? "legacy-revision-zero" : index === 1 ? "published-profile" : `fixture-brand-${index + 1}`,
  name: index === 0 ? "Legacy fixture" : index === 1 ? "Published fixture" : `Fixture Brand ${index + 1}`,
}));
const records = new Map<string, FixtureScript>([
  ["recent-draft", script({ id: "recent-draft", topic: "Recent fixture", durationSec: 90 })],
  ["fast-record", script({ id: "fast-record", topic: "Fast detail", durationSec: 30, brandProfileId: "legacy-revision-zero" })],
  ["slow-record", script({ id: "slow-record", topic: "Slow detail" })],
  ["sent-record", script({ id: "sent-record", topic: "Sent available", status: "sent", editorProjectId: "owned-project", editorProjectAvailable: true })],
  ["missing-record", script({ id: "missing-record", topic: "Sent missing", status: "sent" })],
  ["delete-race", script({ id: "delete-race", topic: "Delete race" })],
  ...Array.from({ length: 494 }, (_, index) => {
    const number = index + 1;
    const id = `scale-${String(number).padStart(4, "0")}`;
    return [id, script({
      id,
      topic: number === 421 ? "หัวข้อทดสอบภาษาไทยที่ยาวสำหรับค้นหาจากทั้งคลัง" : `หัวข้อจำลองในคลัง ${number}`,
      status: number % 2 === 0 ? "sent" : "draft",
      brandProfileId: number % 4 === 0 ? null : profileFixtures[(number % 18) + 2]?.id ?? "fixture-brand-3",
      editorProjectId: number === 500 ? "owned-project" : null,
      editorProjectAvailable: number === 500,
      updatedAt: new Date(Date.parse(iso) - number * 1_000).toISOString(),
    })] as const;
  }),
]);
let legacyUpdate: Record<string, unknown> | null = null;
let createCount = 0;
let libraryListCount = 0;
const libraryRequests: string[] = [];
let libraryMode: "success" | "empty" | "error" = "success";
const detailGets: string[] = [];
const saveBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
const handoffPosts: string[] = [];
let nextSaveDelayMs = 0;
let nextSaveRelease: Promise<void> | null = null;
let failNextSave = false;
let nextHandoffDelayMs = 0;
let nextHandoffRelease: Promise<void> | null = null;
let failNextHandoff = false;
let slowDetailDelayMs = 0;
type DeferredReply = { delayMs?: number; release?: Promise<void>; status?: number; body: Record<string, unknown> };
const generationReplies: DeferredReply[] = [];
const regenReplies: Array<DeferredReply & { target: "hook" | "body" | "cta" }> = [];
const deferredReply = () => {
  let resolve!: () => void;
  const release = new Promise<void>((done) => { resolve = done; });
  return { release, resolve };
};

const fixtureShell = (scriptPath: string) => `<!doctype html><html class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div class="fixture-shell"><header class="fixture-topbar" aria-label="Dashboard top navigation"></header><div class="fixture-shell-body"><aside class="fixture-sidebar" aria-label="Dashboard sidebar"></aside><main class="fixture-main"><div class="fixture-root" id="root"></div></main></div><nav class="fixture-bottom-tabs" aria-label="Dashboard bottom navigation"></nav></div><script src="${scriptPath}"></script></body></html>`;
const html = fixtureShell("/app.js");
const lockedHtml = fixtureShell("/locked.js");
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  if (url.pathname === "/app.js") { res.end(js); return; }
  if (url.pathname === "/locked.js") { res.end(lockedJs); return; }
  if (url.pathname === "/app.css") { res.writeHead(200, { "Content-Type": "text/css" }); res.end(`${productCss}\n${dashboardShellCss}`); return; }
  if (url.pathname === "/locked-preview") { res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(lockedHtml); return; }
  if (url.pathname.startsWith("/api/brand-profiles/") && req.method === "PUT") {
    const body = await readBody();
    if (url.pathname.endsWith("published-profile")) return json({ code: "VERSIONED_PROFILE_READ_ONLY", error: "read only", manageUrl: "/brands" }, 409);
    legacyUpdate = body; return json({ id: "legacy-revision-zero", ...body });
  }
  if (url.pathname === "/api/brand-profiles" && req.method === "GET") return setTimeout(() => json(profileFixtures.map((profile) => ({
    ...profile, niche: "niche", audience: "audience", tone: "tone", bannedWords: [], ctaStyle: "follow", language: "th", sampleText: null, sampleUrl: null, analysisNotes: "notes", createdAt: "", updatedAt: "",
  }))), 500);
  if (url.pathname === "/api/scripts/library") {
    const summaries = [...records.values()].map((row) => ({
      id: row.id, topic: row.topic, brandProfileId: row.brandProfileId,
      brandName: profileFixtures.find((profile) => profile.id === row.brandProfileId)?.name ?? null,
      durationSec: row.durationSec, status: row.status,
      editorProjectId: row.editorProjectId, editorProjectAvailable: row.editorProjectAvailable,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    if (url.searchParams.get("status") === "draft" && url.searchParams.get("pageSize") === "1") {
      const item = summaries.find((row) => row.id === "recent-draft");
      return json({ items: item ? [item] : [], brandOptions: [], total: item ? 1 : 0, page: 1, pageSize: 1, hasNextPage: false });
    }
    libraryListCount += 1;
    libraryRequests.push(url.search);
    if (libraryMode === "error") return json({ error: "fictional fixture failure" }, 500);
    const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? "";
    const status = url.searchParams.get("status") ?? "all";
    const brandProfileId = url.searchParams.get("brandProfileId");
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
    const filtered = libraryMode === "empty" ? [] : summaries.filter((row) =>
      (!query || row.topic.toLocaleLowerCase().includes(query))
      && (status === "all" || row.status === status)
      && (!brandProfileId || (brandProfileId === "none" ? row.brandProfileId === null : row.brandProfileId === brandProfileId)),
    ).sort((a, b) => {
      const fixturePriority = Number(a.id.startsWith("scale-")) - Number(b.id.startsWith("scale-"));
      return fixturePriority || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
    });
    const start = (page - 1) * pageSize;
    return json({ items: filtered.slice(start, start + pageSize), brandOptions: profileFixtures, total: filtered.length, page, pageSize, hasNextPage: start + pageSize < filtered.length });
  }
  if (url.pathname === "/api/scripts/hooks") return json({ hooks: [{ formula: "question-poll", text: "Hook fixture" }] });
  if (url.pathname === "/api/scripts/generate") {
    const reply = generationReplies.shift();
    if (reply?.release) await reply.release;
    if (reply?.delayMs) await wait(reply.delayMs);
    return json(reply?.body ?? { structure: "how-to", bodyText: "Body fixture", ctaText: "CTA fixture" }, reply?.status ?? 200);
  }
  if (url.pathname === "/api/scripts/regen-section") {
    const requestBody = await readBody();
    const reply = regenReplies.shift();
    assert.equal(requestBody.target, reply?.target, "fixture regen target follows the expected request");
    if (reply?.release) await reply.release;
    if (reply?.delayMs) await wait(reply.delayMs);
    return json(reply?.body ?? { text: "Regenerated fixture" }, reply?.status ?? 200);
  }
  const handoffMatch = url.pathname.match(/^\/api\/scripts\/([^/]+)\/send-to-editor$/);
  if (handoffMatch && req.method === "POST") {
    const id = decodeURIComponent(handoffMatch[1]);
    handoffPosts.push(id);
    const delay = nextHandoffDelayMs; nextHandoffDelayMs = 0;
    const release = nextHandoffRelease; nextHandoffRelease = null;
    if (release) await release;
    if (delay) await wait(delay);
    if (failNextHandoff) { failNextHandoff = false; return json({ error: "handoff failed" }, 500); }
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
    const release = nextSaveRelease; nextSaveRelease = null;
    if (release) await release;
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
  browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [] });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const screenshotDir = "docs/plans/reports/hero-script-workspace-ux/fixtures";
  mkdirSync(screenshotDir, { recursive: true });
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => localStorage.setItem("hero-script-writing:fixture-account", JSON.stringify({ profileId: "legacy-revision-zero", durationSec: 90 })));
  await page.goto(`http://127.0.0.1:${port}/hero-script`);
  await page.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  await page.locator('details:has([role="listbox"]) > summary').click();
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 21);
  await page.locator('details:has([role="listbox"]) > summary').click();
  const topicInput = await page.$('input[aria-label="หัวข้อสคริปต์"]');
  const topicBox = await topicInput?.boundingBox();
  assert.ok(topicBox && topicBox.y + topicBox.height <= 768, "the topic stays in the initial 1366×768 desktop viewport with 20 profiles");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the desktop workspace has no horizontal overflow");
  await page.screenshot({ path: `${screenshotDir}/hero-script-workspace-desktop.png` });
  await page.setViewport({ width: 390, height: 844 });
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
  const routesBeforeBriefProjectOpen = await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const handoffsBeforeBriefProjectOpen = handoffPosts.length;
  await page.evaluate(() => {
    const article = [...document.querySelectorAll("article")].find((node) => node.textContent?.includes("Sent available"));
    [...(article?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("เปิดงานตัดต่อเดิม"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?"));
  await page.locator('button::-p-text(ยกเลิก)').click();
  assert.equal(await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), routesBeforeBriefProjectOpen, "library existing-project cancel preserves a pre-generation brief");
  await page.evaluate(() => {
    const article = [...document.querySelectorAll("article")].find((node) => node.textContent?.includes("Sent available"));
    [...(article?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("เปิดงานตัดต่อเดิม"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await page.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeBriefProjectOpen);
  assert.equal(handoffPosts.length, handoffsBeforeBriefProjectOpen, "library existing-project discard navigates with zero handoff POSTs");
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

  const fillBodyEditor = async (value: string) => page.evaluate((next) => {
    const visible = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter((node) => node.getClientRects().length > 0);
    const input = visible.slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const fillMountedBodyEditor = async (value: string) => page.evaluate((next) => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const readBodyEditor = async () => page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).slice(-3)[1]?.value);

  const handoffsBeforeOpen = handoffPosts.length;
  await fillBodyEditor("Existing project save began");
  const existingOpenGate = deferredReply();
  nextSaveRelease = existingOpenGate.release;
  const routesBeforeExistingSave = await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const existingFirstSavePromise = page.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Existing project save began");
  await page.locator('button::-p-text(เปิดงานตัดต่อเดิม)').click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), routesBeforeExistingSave, "existing-project navigation waits for the latest save");
  const existingFirstSave = await existingFirstSavePromise;
  assert.ok(existingFirstSave);
  await fillBodyEditor("Latest while existing project awaited save");
  existingOpenGate.resolve();
  await page.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeExistingSave);
  assert.equal(records.get("sent-record")?.bodyText, "Latest while existing project awaited save", "existing-project navigation drains edits made after save begins");
  assert.equal(handoffPosts.length, handoffsBeforeOpen, "opening an existing project performs zero handoff POSTs");
  await fillBodyEditor("Existing project save failure");
  failNextSave = true;
  const routesBeforeExistingFailure = await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const existingFailureResponse = page.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Existing project save failure");
  await page.locator('button::-p-text(เปิดงานตัดต่อเดิม)').click();
  await existingFailureResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), routesBeforeExistingFailure, "failed save blocks existing-project navigation");
  assert.equal(await readBodyEditor(), "Existing project save failure", "failed existing-project navigation preserves the latest text");
  nextHandoffDelayMs = 250;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("สร้างงานตัดต่อใหม่"))!;
    button.click(); button.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(handoffPosts.length, handoffsBeforeOpen + 1, "explicit create-new sends exactly one POST while pending");

  await fillBodyEditor("Snapshot when record open began");
  const recordOpenSaveGate = deferredReply();
  nextSaveRelease = recordOpenSaveGate.release;
  const recordOpenFirstSave = page.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Snapshot when record open began");
  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  const detailCountBeforeMissing = detailGets.length;
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Sent missing"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await recordOpenFirstSave;
  assert.equal(detailGets.length, detailCountBeforeMissing, "opening another record waits for the latest serialized save");
  await fillMountedBodyEditor("Latest edit while record open awaited save");
  recordOpenSaveGate.resolve();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Sent missing");
  assert.equal(records.get("sent-record")?.bodyText, "Latest edit while record open awaited save", "record open drains edits made after save begins");
  assert.equal(await page.evaluate(() => document.body.innerText.includes("งานตัดต่อเดิมไม่พร้อมใช้งาน")), true, "missing projects remain truthful and offer explicit create-new");

  await page.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await page.evaluate(() => [...document.querySelectorAll("article button")].find((button) => button.textContent?.includes("Fast detail"))?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Fast detail");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.setViewport({ width: 320, height: 844 });
  assert.equal(await page.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).slice(-3).every((input) => Number.parseFloat(getComputedStyle(input).fontSize) >= 16)), true, "editable Hook/body/CTA text stays at least 16px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "editor actions do not cause 320px horizontal scrolling");
  await fillBodyEditor("Latest before failed handoff");
  failNextSave = true;
  nextSaveDelayMs = 100;
  const handoffsBeforeFailure = handoffPosts.length;
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes("ส่งไปตัดต่อ") && !button.disabled));
  const failedHandoffSaveResponse = page.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Latest before failed handoff");
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("ส่งไปตัดต่อ") && button.getClientRects().length > 0)?.click());
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes("ส่งไปตัดต่อ") && button.disabled));
  await failedHandoffSaveResponse;
  assert.equal(handoffPosts.length, handoffsBeforeFailure, "a failed latest save blocks stale handoff");
  assert.equal(await readBodyEditor(), "Latest before failed handoff", "save failure preserves working text");
  await page.waitForFunction(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้"));
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("ทิ้งแล้วไปต่อ") && button.getClientRects().length > 0)?.click());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, handoffsBeforeFailure, "failed active handoff save exposes no stale discard-to-POST path");
  const routesBeforeRetry = await page.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  nextSaveDelayMs = 250;
  const retrySaveResponse = page.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Latest before failed handoff");
  const retryHandoffResponse = page.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await page.locator('button::-p-text(ลองบันทึกอีกครั้ง)').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(handoffPosts.length, handoffsBeforeFailure, "handoff waits for a delayed latest save");
  assert.equal((await retrySaveResponse).status(), 200);
  await retryHandoffResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeRetry);
  assert.equal(records.get("fast-record")?.bodyText, "Latest before failed handoff", "handoff follows the latest committed body");
  assert.equal(handoffPosts.length, handoffsBeforeFailure + 1);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes("สร้างงานตัดต่อใหม่") && !button.disabled));
  await page.reload();
  await page.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));

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

  records.set("fast-record", script({ id: "fast-record", topic: "Fast detail", durationSec: 30, brandProfileId: "legacy-revision-zero" }));
  const saveDrainPage = await browser.newPage();
  saveDrainPage.setDefaultTimeout(5_000);
  await saveDrainPage.setViewport({ width: 390, height: 844 });
  await saveDrainPage.goto(`http://127.0.0.1:${port}/hero-script`);
  await saveDrainPage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  const settleSaveDrainPage = async () => saveDrainPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const openOnSaveDrainPage = async (topicName: string) => {
    await saveDrainPage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
    await saveDrainPage.waitForFunction((topic) => [...document.querySelectorAll("article button")].some((button) => button.textContent?.includes(topic)), {}, topicName);
    await saveDrainPage.evaluate((topic) => [...document.querySelectorAll<HTMLButtonElement>("article button")].find((button) => button.textContent?.includes(topic))?.click(), topicName);
    await saveDrainPage.waitForFunction((topic) => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === topic, {}, topicName);
    await settleSaveDrainPage();
  };
  const fillSaveDrainBody = async (value: string) => saveDrainPage.evaluate((next) => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter((node) => node.getClientRects().length > 0).slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const fillMountedSaveDrainBody = async (value: string) => saveDrainPage.evaluate((next) => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const saveDrainBody = async () => saveDrainPage.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).slice(-3)[1]?.value);

  await openOnSaveDrainPage("Fast detail");
  await fillSaveDrainBody("Snapshot when New began");
  const newSaveGate = deferredReply();
  nextSaveRelease = newSaveGate.release;
  const newFirstSave = saveDrainPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Snapshot when New began");
  await saveDrainPage.locator('button::-p-text(สคริปต์ใหม่)').click();
  await newFirstSave;
  await fillSaveDrainBody("Latest edit while New awaited save");
  const newLatestSave = saveDrainPage.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Latest edit while New awaited save");
  newSaveGate.resolve();
  await newLatestSave;
  await saveDrainPage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  assert.equal(records.get("fast-record")?.bodyText, "Latest edit while New awaited save", "New commits edits made after its awaited save begins");

  await openOnSaveDrainPage("Fast detail");
  await fillSaveDrainBody("First snapshot before follow-up failure");
  const firstFollowupGate = deferredReply();
  nextSaveRelease = firstFollowupGate.release;
  const firstFollowupSave = saveDrainPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "First snapshot before follow-up failure");
  await saveDrainPage.locator('button::-p-text(สคริปต์ใหม่)').click();
  await firstFollowupSave;
  await fillSaveDrainBody("Latest text whose follow-up save fails");
  const secondFollowupGate = deferredReply();
  nextSaveRelease = secondFollowupGate.release;
  const secondFollowupSave = saveDrainPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Latest text whose follow-up save fails");
  firstFollowupGate.resolve();
  await secondFollowupSave;
  assert.equal(await saveDrainPage.evaluate(() => document.body.innerText.includes("บันทึกแล้ว")), false, "save state does not report saved while a newer visible snapshot is pending");
  failNextSave = true;
  secondFollowupGate.resolve();
  await saveDrainPage.waitForFunction(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้"));
  assert.equal(await saveDrainBody(), "Latest text whose follow-up save fails", "a failed follow-up save preserves its latest visible text");
  assert.equal(await saveDrainPage.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Fast detail", "failed follow-up save blocks replacement");
  await saveDrainPage.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await saveDrainPage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");

  await openOnSaveDrainPage("Fast detail");
  await fillSaveDrainBody("Snapshot when record open began");
  const openSaveGate = deferredReply();
  nextSaveRelease = openSaveGate.release;
  const openFirstSave = saveDrainPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Snapshot when record open began");
  await saveDrainPage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await saveDrainPage.waitForFunction(() => [...document.querySelectorAll("article button")].some((button) => button.textContent?.includes("Recent fixture")));
  await saveDrainPage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("article button")].find((button) => button.textContent?.includes("Recent fixture"))?.click());
  await openFirstSave;
  await fillMountedSaveDrainBody("Latest edit while record open awaited save");
  const openLatestSave = saveDrainPage.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Latest edit while record open awaited save");
  openSaveGate.resolve();
  await openLatestSave;
  await saveDrainPage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Recent fixture");
  assert.equal(records.get("fast-record")?.bodyText, "Latest edit while record open awaited save", "record open commits edits made after its awaited save begins");

  await openOnSaveDrainPage("Fast detail");
  await fillSaveDrainBody("Snapshot when create began");
  const createSaveGate = deferredReply();
  nextSaveRelease = createSaveGate.release;
  const createFirstSave = saveDrainPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Snapshot when create began");
  const createHandoffResponse = saveDrainPage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await saveDrainPage.locator('button::-p-text(ส่งไปตัดต่อ)').click();
  await createFirstSave;
  await fillSaveDrainBody("Latest edit while create awaited save");
  const createLatestSave = saveDrainPage.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Latest edit while create awaited save");
  createSaveGate.resolve();
  await createLatestSave;
  await createHandoffResponse;
  assert.equal(records.get("fast-record")?.bodyText, "Latest edit while create awaited save", "create handoff commits edits made after its awaited save begins");
  await saveDrainPage.close();

  const newHandoffPage = async () => {
    const nextPage = await browser.newPage();
    nextPage.setDefaultTimeout(5_000);
    await nextPage.setViewport({ width: 390, height: 844 });
    await nextPage.goto(`http://127.0.0.1:${port}/hero-script`);
    await nextPage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
    return nextPage;
  };
  const openFixtureRecord = async (fixturePage: import("puppeteer").Page, topicName: string) => {
    await fixturePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
    await fixturePage.waitForFunction((name) => [...document.querySelectorAll("article button")].some((button) => button.textContent?.includes(name)), {}, topicName);
    await fixturePage.evaluate((name) => [...document.querySelectorAll<HTMLButtonElement>("article button")].find((button) => button.textContent?.includes(name))?.click(), topicName);
    await fixturePage.waitForFunction((name) => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === name, {}, topicName);
  };
  const fillMountedFixtureBody = async (fixturePage: import("puppeteer").Page, value: string) => fixturePage.evaluate((next) => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].slice(-3)[1];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  const clickLibraryCreate = async (fixturePage: import("puppeteer").Page, topicName: string) => {
    await fixturePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
    await fixturePage.waitForFunction((name) => [...document.querySelectorAll("article")].some((article) => article.textContent?.includes(name)), {}, topicName);
    await fixturePage.evaluate((name) => {
      const article = [...document.querySelectorAll("article")].find((node) => node.textContent?.includes(name))!;
      (article.querySelector("summary") as HTMLElement).click();
      [...article.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("สร้างงานตัดต่อใหม่"))?.click();
    }, topicName);
  };

  // A non-active library handoff is still a workspace transition: it drains
  // the mounted writer and blocks the POST when the latest follow-up save fails.
  records.set("fast-record", script({ id: "fast-record", topic: "Fast detail", durationSec: 30, brandProfileId: "legacy-revision-zero" }));
  const librarySavePage = await newHandoffPage();
  await openFixtureRecord(librarySavePage, "Fast detail");
  await fillMountedFixtureBody(librarySavePage, "Library handoff save failure");
  failNextSave = true;
  const postsBeforeLibrarySaveFailure = handoffPosts.length;
  await clickLibraryCreate(librarySavePage, "Recent fixture");
  await librarySavePage.waitForFunction(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้"));
  assert.equal(handoffPosts.length, postsBeforeLibrarySaveFailure, "failed active-workspace save blocks a non-active library handoff");
  assert.equal(await librarySavePage.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.slice(-3)[1]?.value), "Library handoff save failure");
  await librarySavePage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("ทิ้งแล้วไปต่อ") && button.getClientRects().length > 0)?.click());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, postsBeforeLibrarySaveFailure, "failed library handoff save exposes no stale discard-to-POST path");
  await librarySavePage.locator('button::-p-text(ยกเลิก)').click();

  await fillMountedFixtureBody(librarySavePage, "Library handoff first snapshot");
  const librarySaveGate = deferredReply();
  nextSaveRelease = librarySaveGate.release;
  const libraryFirstSave = librarySavePage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Library handoff first snapshot");
  const libraryHandoffResponse = librarySavePage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickLibraryCreate(librarySavePage, "Recent fixture");
  await libraryFirstSave;
  await fillMountedFixtureBody(librarySavePage, "Library handoff latest snapshot");
  const libraryLatestSave = librarySavePage.waitForResponse((response) => response.request().method() === "PUT" && JSON.parse(response.request().postData() ?? "{}").bodyText === "Library handoff latest snapshot");
  librarySaveGate.resolve();
  await libraryLatestSave;
  await libraryHandoffResponse;
  assert.equal(records.get("fast-record")?.bodyText, "Library handoff latest snapshot", "non-active library handoff drains the current visible snapshot");
  await librarySavePage.close();

  // An unsaved topic/Hook requires the same explicit discard decision before a
  // non-active library POST.
  const libraryBriefPage = await newHandoffPage();
  await libraryBriefPage.locator('input[aria-label="หัวข้อสคริปต์"]').fill("Unsaved library handoff brief");
  const briefHookResponse = libraryBriefPage.waitForResponse((response) => response.url().endsWith("/api/scripts/hooks"));
  await libraryBriefPage.locator('button::-p-text(สร้าง Hook)').click();
  await briefHookResponse;
  await libraryBriefPage.locator('button::-p-text(Hook fixture)').click();
  const postsBeforeLibraryBrief = handoffPosts.length;
  await clickLibraryCreate(libraryBriefPage, "Recent fixture");
  await libraryBriefPage.waitForFunction(() => document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?"));
  await libraryBriefPage.locator('button::-p-text(ยกเลิก)').click();
  assert.equal(handoffPosts.length, postsBeforeLibraryBrief, "cancelling preserves a pre-generation brief without a library handoff");
  await clickLibraryCreate(libraryBriefPage, "Recent fixture");
  const briefHandoffResponse = libraryBriefPage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await libraryBriefPage.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await briefHandoffResponse;
  assert.equal(handoffPosts.length, postsBeforeLibraryBrief + 1, "explicit discard permits exactly one non-active library handoff");
  await libraryBriefPage.close();

  // Editor→library and library→editor competition share one non-idempotent
  // operation owner. The first request alone may navigate.
  const editorFirstPage = await newHandoffPage();
  await openFixtureRecord(editorFirstPage, "Fast detail");
  const editorFirstGate = deferredReply();
  nextHandoffRelease = editorFirstGate.release;
  const postsBeforeEditorFirst = handoffPosts.length;
  const editorFirstRequest = editorFirstPage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const editorFirstResponse = editorFirstPage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await editorFirstPage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => ["ส่งไปตัดต่อ", "สร้างงานตัดต่อใหม่"].includes(button.textContent?.trim() ?? "") && button.getClientRects().length > 0)?.click());
  await editorFirstRequest;
  assert.equal(handoffPosts.length, postsBeforeEditorFirst + 1);
  await clickLibraryCreate(editorFirstPage, "Recent fixture");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, postsBeforeEditorFirst + 1, "held editor handoff blocks a competing library handoff");
  editorFirstGate.resolve();
  await editorFirstResponse;
  await editorFirstPage.waitForFunction(() => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) === 1);
  assert.equal(await editorFirstPage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.at(-1)), `/video-editor?projectId=project-${postsBeforeEditorFirst + 1}`, "the editor-first handoff alone owns navigation");
  await editorFirstPage.close();

  const libraryFirstPage = await newHandoffPage();
  await openFixtureRecord(libraryFirstPage, "Fast detail");
  const libraryFirstGate = deferredReply();
  nextHandoffRelease = libraryFirstGate.release;
  const postsBeforeLibraryFirst = handoffPosts.length;
  const libraryFirstRequest = libraryFirstPage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const libraryFirstResponse = libraryFirstPage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickLibraryCreate(libraryFirstPage, "Recent fixture");
  await libraryFirstRequest;
  assert.equal(handoffPosts.length, postsBeforeLibraryFirst + 1);
  await libraryFirstPage.locator('[role="tab"]::-p-text(เขียนสคริปต์)').click();
  await libraryFirstPage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => ["ส่งไปตัดต่อ", "สร้างงานตัดต่อใหม่"].includes(button.textContent?.trim() ?? "") && button.getClientRects().length > 0)?.click());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, postsBeforeLibraryFirst + 1, "held library handoff blocks a competing editor handoff");
  libraryFirstGate.resolve();
  await libraryFirstResponse;
  await libraryFirstPage.waitForFunction(() => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) === 1);
  assert.equal(await libraryFirstPage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.at(-1)), `/video-editor?projectId=project-${postsBeforeLibraryFirst + 1}`, "the library-first handoff alone owns navigation");
  await libraryFirstPage.close();

  // An invalidated save continuation must not authorize itself through a newer
  // same-script operation (ABA): the immutable operation, not the script ID,
  // owns the single POST and navigation.
  records.set("fast-record", script({ id: "fast-record", topic: "Fast detail", durationSec: 30, brandProfileId: "legacy-revision-zero" }));
  const abaPage = await newHandoffPage();
  await openFixtureRecord(abaPage, "Fast detail");
  await fillMountedFixtureBody(abaPage, "Held save before ABA replacement");
  const abaSaveGate = deferredReply();
  nextSaveRelease = abaSaveGate.release;
  const abaFirstSave = abaPage.waitForRequest((request) => request.method() === "PUT" && JSON.parse(request.postData() ?? "{}").bodyText === "Held save before ABA replacement");
  await abaPage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => ["ส่งไปตัดต่อ", "สร้างงานตัดต่อใหม่"].includes(button.textContent?.trim() ?? "") && button.getClientRects().length > 0)?.click());
  await abaFirstSave;
  await abaPage.locator('input[aria-label="หัวข้อสคริปต์"]').fill("Context invalidates first operation");
  const postsBeforeAba = handoffPosts.length;
  const abaHandoffGate = deferredReply();
  nextHandoffRelease = abaHandoffGate.release;
  const abaHandoffRequest = abaPage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  await clickLibraryCreate(abaPage, "Fast detail");
  failNextSave = true;
  abaSaveGate.resolve();
  await abaHandoffRequest;
  assert.equal(await abaPage.evaluate(() => document.body.textContent?.includes("ข้อความล่าสุดยังอยู่ในหน้านี้")), false, "invalidated operation A cannot publish recovery over operation B");
  assert.equal(handoffPosts.length, postsBeforeAba + 1, "operation B alone reaches the POST boundary after A's save fails");
  const abaHandoffResponse = abaPage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  abaHandoffGate.resolve();
  await abaHandoffResponse;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(handoffPosts.length, postsBeforeAba + 1, "an old save continuation cannot consume a newer same-script handoff token");
  assert.equal(await abaPage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), 1, "only the newer same-script operation may navigate");
  await abaPage.close();

  const racePage = await browser.newPage();
  racePage.setDefaultTimeout(5_000);
  await racePage.setViewport({ width: 390, height: 844 });
  await racePage.goto(`http://127.0.0.1:${port}/hero-script`);
  await racePage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  const setTopic = async (value: string) => racePage.locator('input[aria-label="หัวข้อสคริปต์"]').fill(value);
  const settleReact = async () => racePage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const requestBody = (candidate: import("puppeteer").HTTPResponse) => JSON.parse(candidate.request().postData() ?? "{}");
  const waitForGeneration = (requestTopic: string) => racePage.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/scripts/generate") && requestBody(candidate).topic === requestTopic);
  const waitForRegen = (target: "hook" | "body" | "cta") => racePage.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/scripts/regen-section") && requestBody(candidate).target === target);
  const chooseHook = async () => {
    await settleReact();
    const activeTopic = await racePage.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value);
    const response = racePage.waitForResponse((candidate) => candidate.url().endsWith("/api/scripts/hooks") && requestBody(candidate).topic === activeTopic);
    await racePage.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => ["สร้าง Hook", "ขออีกชุด"].includes(button.textContent?.trim() ?? "") && button.getClientRects().length > 0));
    await racePage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => ["สร้าง Hook", "ขออีกชุด"].includes(button.textContent?.trim() ?? "") && button.getClientRects().length > 0)?.click());
    await response;
    await settleReact();
    await racePage.locator('button::-p-text(Hook fixture)').click();
  };
  const openRecord = async (name: string) => {
    await racePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
    await racePage.waitForFunction((topic) => [...document.querySelectorAll<HTMLButtonElement>("article button")].some((button) => button.textContent?.includes(topic)), {}, name);
    await racePage.evaluate((topic) => [...document.querySelectorAll<HTMLButtonElement>("article button")].find((button) => button.textContent?.includes(topic))?.click(), name);
    await racePage.waitForFunction((topic) => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === topic, {}, name);
  };
  const newWorkspace = async () => {
    await racePage.locator('button::-p-text(สคริปต์ใหม่)').click();
    const nextState = await racePage.waitForFunction(() => {
      const topic = (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value;
      if (topic === "") return "blank";
      return document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?") ? "discard" : false;
    }).then((handle) => handle.jsonValue());
    if (nextState === "discard") {
      await racePage.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
    }
    await racePage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "");
  };
  const clickRegen = async (label: "Hook" | "เนื้อหา" | "CTA") => racePage.evaluate((sectionLabel) => {
    const labelNode = [...document.querySelectorAll<HTMLSpanElement>("span")].find((node) => node.textContent === sectionLabel && node.getClientRects().length > 0)!;
    (labelNode.parentElement?.querySelector("button") as HTMLButtonElement).click();
  }, label);
  const clickCreateProject = async () => racePage.evaluate(() => {
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getClientRects().length > 0
      && ["ส่งไปตัดต่อ", "สร้างงานตัดต่อใหม่"].includes(button.textContent?.trim() ?? ""),
    )?.click();
  });
  const editorValues = async () => racePage.$$eval("textarea", (inputs: HTMLTextAreaElement[]) => inputs.filter((input) => input.getClientRects().length > 0).map((input) => input.value).slice(-3));

  // Full generation: explicit record replacement owns the workspace even when
  // the older generation finishes later.
  await setTopic("Full generation before open");
  await chooseHook();
  const fullOpenGate = deferredReply();
  generationReplies.push({ release: fullOpenGate.release, body: { structure: "how-to", bodyText: "STALE FULL OPEN", ctaText: "stale" } });
  const fullOpenResponse = waitForGeneration("Full generation before open");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await racePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await racePage.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("article button")].some((button) => button.textContent?.includes("Fast detail")));
  await racePage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("article button")].find((button) => button.textContent?.includes("Fast detail"))?.click());
  await racePage.waitForFunction(() => document.body.textContent?.includes("ทิ้งสิ่งที่กำลังเขียน?"));
  await racePage.locator('button::-p-text(ทิ้งแล้วไปต่อ)').click();
  await racePage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "Fast detail");
  fullOpenGate.resolve();
  await fullOpenResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE FULL OPEN"), false, "delayed full generation cannot overwrite an opened record");

  await newWorkspace();
  await setTopic("Full generation before New");
  await chooseHook();
  const fullNewGate = deferredReply();
  generationReplies.push({ release: fullNewGate.release, body: { structure: "how-to", bodyText: "STALE FULL NEW", ctaText: "stale" } });
  const fullNewResponse = waitForGeneration("Full generation before New");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await newWorkspace();
  fullNewGate.resolve();
  await fullNewResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE FULL NEW"), false, "delayed full generation cannot overwrite New");

  // Topic, duration and profile changes each invalidate the old generation.
  await newWorkspace();
  await setTopic("Old topic context");
  await chooseHook();
  const topicGate = deferredReply();
  generationReplies.push({ release: topicGate.release, body: { structure: "how-to", bodyText: "STALE TOPIC", ctaText: "stale" } });
  const topicResponse = waitForGeneration("Old topic context");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await setTopic("New topic context");
  topicGate.resolve();
  await topicResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE TOPIC"), false);

  await newWorkspace();
  await setTopic("Old duration context");
  await chooseHook();
  const durationGate = deferredReply();
  generationReplies.push({ release: durationGate.release, body: { structure: "how-to", bodyText: "STALE DURATION", ctaText: "stale" } });
  const durationResponse = waitForGeneration("Old duration context");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  const currentDuration = await racePage.$eval('[role="combobox"]', (element) => element.textContent?.trim());
  const nextDuration = currentDuration === "60 วิ" ? "90 วิ" : "60 วิ";
  await racePage.locator('[role="combobox"]').click();
  await racePage.waitForFunction((label) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((node) => node.textContent?.trim() === label && node.getClientRects().length > 0), {}, nextDuration);
  await racePage.evaluate((label) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.trim() === label && node.getClientRects().length > 0)?.click(), nextDuration);
  await racePage.waitForFunction((label) => document.querySelector('[role="combobox"]')?.textContent?.trim() === label, {}, nextDuration);
  durationGate.resolve();
  await durationResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE DURATION"), false);

  await newWorkspace();
  await setTopic("Old profile context");
  await chooseHook();
  const profileGate = deferredReply();
  generationReplies.push({ release: profileGate.release, body: { structure: "how-to", bodyText: "STALE PROFILE", ctaText: "stale" } });
  const profileResponse = waitForGeneration("Old profile context");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  const currentProfile = await racePage.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find((node) => node.getClientRects().length > 0 && (node.textContent?.includes("Legacy fixture") || node.textContent?.includes("ไม่ใช้โปรไฟล์")))?.textContent);
  const nextProfile = currentProfile?.includes("Legacy fixture") ? "ไม่ใช้โปรไฟล์" : "Legacy fixture";
  await racePage.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find((node) => node.getClientRects().length > 0 && (node.textContent?.includes("Legacy fixture") || node.textContent?.includes("ไม่ใช้โปรไฟล์")))?.click());
  await racePage.waitForSelector('[role="option"]');
  await racePage.evaluate((profileName) => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(profileName))?.click(), nextProfile);
  await racePage.evaluate(() => [...document.querySelectorAll<HTMLDetailsElement>("details")].find((node) => node.querySelector('[role="listbox"]'))?.removeAttribute("open"));
  profileGate.resolve();
  await profileResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE PROFILE"), false);

  // A stale failure is silent, and the first request's finally block cannot
  // clear the loading state owned by a newer generation.
  await setTopic("Stale failure context");
  await chooseHook();
  const toastsBeforeStaleFailure = await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0);
  const staleFailureGate = deferredReply();
  generationReplies.push({ release: staleFailureGate.release, status: 500, body: { error: "STALE GENERATION FAILURE" } });
  const staleFailureResponse = waitForGeneration("Stale failure context");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await setTopic("Context after stale failure");
  staleFailureGate.resolve();
  await staleFailureResponse;
  await settleReact();
  assert.equal(await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0), toastsBeforeStaleFailure);
  assert.equal(await racePage.evaluate(() => document.body.innerText.includes("STALE GENERATION FAILURE")), false);

  await newWorkspace();
  await setTopic("First generation request");
  await chooseHook();
  const firstGenerationGate = deferredReply();
  const secondGenerationGate = deferredReply();
  generationReplies.push(
    { release: firstGenerationGate.release, body: { structure: "how-to", bodyText: "STALE FIRST GENERATION", ctaText: "stale" } },
    { release: secondGenerationGate.release, body: { structure: "how-to", bodyText: "LATEST GENERATION", ctaText: "latest" } },
  );
  const firstGenerationResponse = waitForGeneration("First generation request");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await setTopic("Second generation request");
  await chooseHook();
  const secondGenerationResponse = waitForGeneration("Second generation request");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  firstGenerationGate.resolve();
  await firstGenerationResponse;
  await settleReact();
  assert.equal(await racePage.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes("กำลังสร้างสคริปต์…") && button.disabled)), true, "stale full-generation finalizer cannot clear newer loading state");
  secondGenerationGate.resolve();
  await secondGenerationResponse;
  await racePage.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].some((input) => input.value === "LATEST GENERATION"));
  assert.equal((await editorValues()).includes("STALE FIRST GENERATION"), false);

  // Each section target rejects replies from the previous Script/reset.
  await openRecord("Fast detail");
  const hookReplacementGate = deferredReply();
  regenReplies.push({ target: "hook", release: hookReplacementGate.release, body: { text: "STALE HOOK", formula: "question-poll" } });
  const hookReplacementResponse = waitForRegen("hook");
  await clickRegen("Hook");
  await openRecord("Sent missing");
  hookReplacementGate.resolve();
  await hookReplacementResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE HOOK"), false);

  await openRecord("Fast detail");
  const bodyResetGate = deferredReply();
  regenReplies.push({ target: "body", release: bodyResetGate.release, body: { text: "STALE BODY RESET" } });
  const bodyResetResponse = waitForRegen("body");
  await clickRegen("เนื้อหา");
  await newWorkspace();
  bodyResetGate.resolve();
  await bodyResetResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE BODY RESET"), false);

  await openRecord("Fast detail");
  const ctaReplacementGate = deferredReply();
  regenReplies.push({ target: "cta", release: ctaReplacementGate.release, body: { text: "STALE CTA" } });
  const ctaReplacementResponse = waitForRegen("cta");
  await clickRegen("CTA");
  await openRecord("Sent available");
  ctaReplacementGate.resolve();
  await ctaReplacementResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE CTA"), false);

  // Stale section failures are silent; stale finalizers do not enable controls
  // while the newer record's regeneration is still pending.
  const toastsBeforeRegenFailure = await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0);
  const staleRegenFailureGate = deferredReply();
  regenReplies.push({ target: "cta", release: staleRegenFailureGate.release, status: 500, body: { error: "STALE REGEN FAILURE" } });
  const staleRegenFailureResponse = waitForRegen("cta");
  await clickRegen("CTA");
  await openRecord("Fast detail");
  staleRegenFailureGate.resolve();
  await staleRegenFailureResponse;
  await settleReact();
  assert.equal(await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0), toastsBeforeRegenFailure);

  const firstRegenGate = deferredReply();
  const secondRegenGate = deferredReply();
  regenReplies.push(
    { target: "hook", release: firstRegenGate.release, body: { text: "STALE REGEN FINALIZER", formula: "question-poll" } },
    { target: "body", release: secondRegenGate.release, body: { text: "LATEST REGEN BODY" } },
  );
  const firstRegenResponse = waitForRegen("hook");
  await clickRegen("Hook");
  await openRecord("Sent available");
  const secondRegenResponse = waitForRegen("body");
  await clickRegen("เนื้อหา");
  firstRegenGate.resolve();
  await firstRegenResponse;
  await settleReact();
  assert.equal(await racePage.$$eval("button", (buttons: HTMLButtonElement[]) => buttons.filter((button) => button.textContent?.includes("เขียนใหม่") && button.getClientRects().length > 0).every((button) => button.disabled)), true, "stale regen finalizer cannot enable controls owned by a newer regen");
  secondRegenGate.resolve();
  await secondRegenResponse;
  await racePage.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].some((input) => input.value === "LATEST REGEN BODY"));
  assert.equal((await editorValues()).includes("STALE REGEN FINALIZER"), false);

  // Starting a handoff owns the current Script and invalidates generation work
  // that was already in flight before the handoff began.
  const generationBeforeHandoffGate = deferredReply();
  generationReplies.push({ release: generationBeforeHandoffGate.release, body: { structure: "how-to", bodyText: "STALE GENERATION DURING HANDOFF", ctaText: "stale" } });
  const generationBeforeHandoffRequest = racePage.waitForRequest((request) => request.url().endsWith("/api/scripts/generate"));
  const generationBeforeHandoffResponse = waitForGeneration("Sent available");
  await racePage.locator('button::-p-text(สร้างสคริปต์เต็ม)').click();
  await generationBeforeHandoffRequest;
  const generationHandoffGate = deferredReply();
  nextHandoffRelease = generationHandoffGate.release;
  const routesBeforeGenerationHandoff = await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const generationHandoffRequest = racePage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const generationHandoffResponse = racePage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickCreateProject();
  await generationHandoffRequest;
  generationBeforeHandoffGate.resolve();
  await generationBeforeHandoffResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE GENERATION DURING HANDOFF"), false, "handoff invalidates an already-running full generation");
  generationHandoffGate.resolve();
  await generationHandoffResponse;
  await racePage.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeGenerationHandoff);

  await racePage.reload();
  await racePage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  await openRecord("Fast detail");
  const regenBeforeHandoffGate = deferredReply();
  regenReplies.push({ target: "body", release: regenBeforeHandoffGate.release, body: { text: "STALE REGEN DURING HANDOFF" } });
  const regenBeforeHandoffRequest = racePage.waitForRequest((request) => request.url().endsWith("/api/scripts/regen-section"));
  const regenBeforeHandoffResponse = waitForRegen("body");
  await clickRegen("เนื้อหา");
  await regenBeforeHandoffRequest;
  const regenHandoffGate = deferredReply();
  nextHandoffRelease = regenHandoffGate.release;
  const routesBeforeRegenHandoff = await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const regenHandoffRequest = racePage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const regenHandoffResponse = racePage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickCreateProject();
  await regenHandoffRequest;
  regenBeforeHandoffGate.resolve();
  await regenBeforeHandoffResponse;
  await settleReact();
  assert.equal((await editorValues()).includes("STALE REGEN DURING HANDOFF"), false, "handoff invalidates an already-running section regeneration");
  regenHandoffGate.resolve();
  await regenHandoffResponse;
  await racePage.waitForFunction((count) => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > count, {}, routesBeforeRegenHandoff);

  // Replacing the workspace while the non-idempotent POST is held prevents the
  // old response from mutating or navigating away from the replacement.
  await racePage.reload();
  await racePage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  await openRecord("Fast detail");
  const openDuringHandoffGate = deferredReply();
  nextHandoffRelease = openDuringHandoffGate.release;
  const postsBeforeOpenDuringHandoff = handoffPosts.length;
  const routesBeforeOpenDuringHandoff = await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const openDuringHandoffRequest = racePage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const openDuringHandoffResponse = racePage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickCreateProject();
  await openDuringHandoffRequest;
  await openRecord("Sent missing");
  await clickCreateProject();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, postsBeforeOpenDuringHandoff + 1, "opening a record invalidates ownership without releasing the held POST gate");
  openDuringHandoffGate.resolve();
  await openDuringHandoffResponse;
  await settleReact();
  assert.equal(await racePage.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "Sent missing", "a held handoff cannot replace an opened record");
  assert.equal(await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), routesBeforeOpenDuringHandoff, "a handoff owned by the previous record cannot navigate away from an opened record");

  const heldHandoffGate = deferredReply();
  nextHandoffRelease = heldHandoffGate.release;
  const routesBeforeHeldHandoff = await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0);
  const toastsBeforeHeldHandoff = await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0);
  const heldHandoffRequest = racePage.waitForRequest((request) => request.method() === "POST" && request.url().includes("/send-to-editor"));
  const heldHandoffResponse = racePage.waitForResponse((response) => response.url().includes("/send-to-editor"));
  await clickCreateProject();
  await heldHandoffRequest;
  await newWorkspace();
  await clickLibraryCreate(racePage, "Recent fixture");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffPosts.length, postsBeforeOpenDuringHandoff + 2, "New invalidates ownership without releasing the held POST gate");
  failNextHandoff = true;
  heldHandoffGate.resolve();
  await heldHandoffResponse;
  await settleReact();
  assert.equal(await racePage.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "", "a held handoff cannot replace New");
  assert.equal(await racePage.evaluate(() => (window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0), routesBeforeHeldHandoff, "a handoff owned by the previous workspace cannot navigate away from New");
  assert.equal(await racePage.evaluate(() => (window as unknown as { __fixtureToasts?: string[] }).__fixtureToasts?.length ?? 0), toastsBeforeHeldHandoff, "a stale handoff failure stays silent after New");
  await racePage.close();

  // Scale and access QA use a fresh mounted page. Every record/profile below is
  // fictional, and requests stay inside this local server.
  for (const id of records.keys()) if (id.startsWith("draft-")) records.delete(id);
  records.set("delete-race", script({ id: "delete-race", topic: "Delete race" }));
  assert.equal(records.size, 500, "the scale fixture starts with exactly 500 fictional scripts");
  const scalePage = await browser.newPage();
  scalePage.setDefaultTimeout(5_000);
  await scalePage.setViewport({ width: 390, height: 844 });
  await scalePage.goto(`http://127.0.0.1:${port}/hero-script`);
  await scalePage.waitForFunction(() => document.body.textContent?.includes("ทำร่างล่าสุดต่อ"));
  const tabTo = async (selector: string, index = 0) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await scalePage.evaluate(({ selector: target, index: targetIndex }) => document.activeElement === document.querySelectorAll(target)[targetIndex], { selector, index })) return;
      await scalePage.keyboard.press("Tab");
    }
    assert.fail(`keyboard focus did not reach ${selector}[${index}]`);
  };
  await tabTo('[role="tab"]', 1);
  await scalePage.keyboard.press("Enter");
  await scalePage.waitForFunction(() => document.body.textContent?.includes("พบ 500 สคริปต์"));
  assert.equal(await scalePage.$$eval("article", (rows) => rows.length), 20, "the 500-script library mounts one bounded 20-row page");

  await tabTo("#script-library-search");
  await scalePage.keyboard.type("หัวข้อทดสอบภาษาไทยที่ยาวสำหรับค้นหาจากทั้งคลัง");
  await scalePage.waitForFunction(() => document.body.textContent?.includes("พบ 1 สคริปต์"));
  assert.equal(libraryRequests.some((request) => request.includes("q=%E0%B8%AB%E0%B8%B1%E0%B8%A7%E0%B8%82%E0%B9%89%E0%B8%AD")), true, "keyboard search reaches the server with the full Thai query");

  await tabTo("select", 0);
  await scalePage.keyboard.press("Home");
  await scalePage.keyboard.type("Fixture Brand 10");
  const targetBrandId = records.get("scale-0421")?.brandProfileId;
  assert.equal(targetBrandId, "fixture-brand-10");
  await scalePage.waitForFunction((brandProfileId) => (document.querySelectorAll("select")[0] as HTMLSelectElement | undefined)?.value === brandProfileId, {}, targetBrandId);
  const statusSelect = (await scalePage.$$("select"))[1];
  assert.ok(statusSelect);
  const combinedFilterResponse = scalePage.waitForResponse((response) => response.url().includes(`brandProfileId=${targetBrandId}`) && response.url().includes("status=draft"));
  await statusSelect.select("draft");
  await scalePage.waitForFunction(() => (document.querySelectorAll("select")[1] as HTMLSelectElement | undefined)?.value === "draft");
  await combinedFilterResponse;
  assert.equal(libraryRequests.some((request) => request.includes(`brandProfileId=${targetBrandId}`) && request.includes("status=draft")), true, "combined keyboard brand/status filters query the full library");

  await tabTo("article button");
  await scalePage.keyboard.press("Enter");
  await scalePage.waitForFunction(() => (document.querySelector('input[aria-label="หัวข้อสคริปต์"]') as HTMLInputElement)?.value === "หัวข้อทดสอบภาษาไทยที่ยาวสำหรับค้นหาจากทั้งคลัง");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const mainActionFocused = await scalePage.evaluate(() => document.activeElement instanceof HTMLButtonElement && document.activeElement.textContent?.includes("ส่งไปตัดต่อ"));
    if (mainActionFocused) break;
    await scalePage.keyboard.press("Tab");
  }
  assert.equal(await scalePage.evaluate(() => document.activeElement instanceof HTMLButtonElement && document.activeElement.textContent?.includes("ส่งไปตัดต่อ")), true, "keyboard focus reaches the writing main action");
  await scalePage.keyboard.press("Enter");
  await scalePage.waitForFunction(() => ((window as unknown as { __fixtureRoutes?: string[] }).__fixtureRoutes?.length ?? 0) > 0);
  assert.equal(await scalePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "390px retains the library and writing actions without horizontal overflow");
  await scalePage.screenshot({ path: `${screenshotDir}/hero-script-workspace-mobile.png` });
  await scalePage.setViewport({ width: 320, height: 844 });
  assert.equal(await scalePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "320px has no horizontal clipping");

  await scalePage.setViewport({ width: 390, height: 844 });
  await scalePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("ไม่พบสคริปต์ที่ตรงกับการค้นหา"));
  await scalePage.locator('button::-p-text(ล้างตัวกรอง)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("พบ 500 สคริปต์"));
  await scalePage.locator("#script-library-search").fill("ไม่พบในข้อมูลจำลอง");
  await scalePage.waitForFunction(() => document.body.textContent?.includes("ไม่พบสคริปต์ที่ตรงกับการค้นหา"));
  await scalePage.locator('button::-p-text(ล้างตัวกรอง)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("พบ 500 สคริปต์"));
  libraryMode = "empty";
  await scalePage.locator('[role="tab"]::-p-text(เขียนสคริปต์)').click();
  await scalePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("ยังไม่มีสคริปต์"));
  await scalePage.locator('button::-p-text(เริ่มเขียนสคริปต์)').click();
  libraryMode = "error";
  await scalePage.locator('[role="tab"]::-p-text(คลังสคริปต์)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("โหลดคลังสคริปต์ไม่สำเร็จ"));
  assert.equal(await scalePage.evaluate(() => document.body.textContent?.includes("ยังไม่มีสคริปต์")), false, "a failed library request never presents a false empty state");
  libraryMode = "success";
  await scalePage.locator('button::-p-text(ลองอีกครั้ง)').click();
  await scalePage.waitForFunction(() => document.body.textContent?.includes("พบ 500 สคริปต์"));
  await scalePage.close();

  const lockedPage = await browser.newPage();
  lockedPage.setDefaultTimeout(5_000);
  await lockedPage.setViewport({ width: 390, height: 844 });
  await lockedPage.goto(`http://127.0.0.1:${port}/locked-preview`);
  await lockedPage.waitForFunction(() => document.body.textContent?.includes("ฟีเจอร์พรีเมียมสำหรับสมาชิก"));
  assert.equal(await lockedPage.$eval('a[href="/pricing?source=hero_script_preview"]', (link) => link.textContent?.includes("ดูแผน")), true, "the actual locked-preview UI exposes its pricing action");
  await lockedPage.screenshot({ path: `${screenshotDir}/hero-script-locked-preview-mobile.png` });
  await lockedPage.close();

  console.log("verify-hero-script-workspace-browser: PASS real-theme 20-profile/500-script, viewport, keyboard, empty/error, access-preview, save/handoff, and generation/regen races");
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
