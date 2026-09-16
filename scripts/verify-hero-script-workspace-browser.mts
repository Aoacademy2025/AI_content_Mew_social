import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const port = 8994;
const root = process.cwd();
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import HeroScriptPage from './src/app/(dashboard)/hero-script/page'; createRoot(document.getElementById('root')).render(<HeroScriptPage/>);`, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "fixture-stubs", setup(b) { b.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/use-me|@\/lib\/client-telemetry|@\/lib\/authenticated-fetch|sonner)$/ }, args => ({ path: args.path, namespace: "fixture" })); b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: root, contents: args.path === "next/link" ? `export default function Link(p){return <a {...p}/>} ` : args.path === "next/navigation" ? `export function useRouter(){return {push:(url)=>window.__fixtureManageUrl=url}}` : args.path === "@/lib/use-me" ? `export async function fetchMe(){return {id:'fixture-account',plan:'PRO'}}` : args.path === "@/lib/authenticated-fetch" ? `export const authenticatedFetch=fetch` : args.path === "sonner" ? `export const toast={error:()=>{},success:()=>{}}` : `export const trackEvent=()=>{}` })); } }],
});
const js = bundle.outputFiles[0].text;
let legacyUpdate: Record<string, unknown> | null = null;
const html = `<!doctype html><html class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/app.js") { res.end(js); return; }
  if (url.pathname.startsWith("/api/brand-profiles/") && req.method === "PUT") {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith("published-profile")) return json({ code: "VERSIONED_PROFILE_READ_ONLY", error: "read only", manageUrl: "/brands" }, 409);
    legacyUpdate = body; return json({ id: "legacy-revision-zero", ...body });
  }
  if (url.pathname === "/api/brand-profiles" && req.method === "GET") return setTimeout(() => json([
    { id: "legacy-revision-zero", name: "Legacy fixture", niche: "niche", audience: "audience", tone: "tone", bannedWords: [], ctaStyle: "follow", language: "th", sampleText: null, sampleUrl: null, analysisNotes: "notes", createdAt: "", updatedAt: "" },
    { id: "published-profile", name: "Published fixture", niche: "niche", audience: "audience", tone: "tone", bannedWords: [], ctaStyle: "follow", language: "th", sampleText: null, sampleUrl: null, analysisNotes: "notes", createdAt: "", updatedAt: "" },
  ]), 500);
  if (url.pathname === "/api/scripts/hooks") return json({ hooks: [{ formula: "question-poll", text: "Hook fixture" }] });
  if (url.pathname === "/api/scripts/generate") return json({ structure: "how-to", bodyText: "Body fixture", ctaText: "CTA fixture" });
  if (url.pathname === "/api/scripts" && req.method === "POST") return json({ id: "draft-fixture" });
  if (url.pathname.startsWith("/api/scripts")) return json([]);
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
  await page.waitForSelector('input[type="search"]');
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('เลือก Hook')), false, "Hook is not shown before a topic");
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('สคริปต์เต็ม')), false, "full script is not shown before a Hook");
  const duration = page.locator('[role="combobox"]');
  await duration.click();
  await page.locator('::-p-text(30 วิ)').click();
  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("หัวข้อทดสอบ");
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('เลือก Hook')), true, "Hook appears after a topic");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();
  await page.locator('::-p-text(สร้างสคริปต์เต็ม)').click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((node) => node.value === 'Body fixture'));
  await page.evaluate(() => {
    const input = document.querySelectorAll<HTMLTextAreaElement>('textarea')[2];
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, 'Body edited');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="หัวข้อสคริปต์"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.body.textContent?.includes('ร่างเดิมยังอยู่'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('h2')].some((heading) => heading.textContent === 'เลือก Hook')), false, "clearing topic hides stale Hook choices");
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('ร่างเดิมยังอยู่')), true, "clearing topic keeps the editable draft with stale-context copy");
  assert.equal(await page.$$eval('textarea', (inputs: HTMLTextAreaElement[]) => inputs.some((input) => input.value === 'Body edited')), true, "clearing topic does not destroy draft text");
  await page.locator('input[aria-label="หัวข้อสคริปต์"]').fill("หัวข้อใหม่");
  await page.locator('::-p-text(สร้าง Hook)').click();
  await page.locator('::-p-text(Hook fixture)').click();
  await page.$eval('[role="tab"][aria-selected="false"]', (element) => (element as HTMLElement).focus());
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.querySelector('[role="tabpanel"]')?.hasAttribute('hidden')), true, "keyboard opens the library tab");
  await page.$eval('[role="tab"][aria-selected="false"]', (element) => (element as HTMLElement).focus());
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('input[aria-label="หัวข้อสคริปต์"]', (input: HTMLInputElement) => input.value), "หัวข้อใหม่");
  assert.deepEqual(await page.$$eval('textarea', (inputs: HTMLTextAreaElement[]) => inputs.map((input) => input.value)), ["Hook fixture", "Body edited", "CTA fixture"]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await page.$eval('[role="combobox"]', (element) => element.textContent), "30 วิ", "delayed preferences do not overwrite explicit duration");
  await page.evaluate(() => [...document.querySelectorAll('summary')].find((summary) => summary.textContent?.includes('วิธีใช้'))?.click());
  assert.equal(await page.evaluate(() => localStorage.getItem("hero-script-guide:fixture-account")), "open");
  await page.evaluate(() => [...document.querySelectorAll('summary')].find((summary) => summary.textContent?.includes('จัดการโปรไฟล์'))?.click());
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('Legacy fixture')), true);
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('Published fixture')), true);
  await page.locator('button[aria-label="แก้ไข Legacy fixture"]').click();
  await page.locator('input[placeholder="เช่น ช่องการเงิน"]').fill('Legacy edited');
  await page.locator('input[placeholder*="การเงินสาย"]').fill('niche edited');
  await page.locator('input[placeholder*="มนุษย์เงินเดือน"]').fill('audience edited');
  await page.locator('input[placeholder*="เป็นกันเอง"]').fill('tone edited');
  await page.locator('textarea[placeholder="แนวทางเพิ่มเติมสำหรับการเขียน"]').fill('notes edited');
  await page.locator('textarea[placeholder*="โกหก"]').fill('word-a, word-b');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'บันทึก')?.click());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(legacyUpdate && { niche: legacyUpdate.niche, audience: legacyUpdate.audience, tone: legacyUpdate.tone, bannedWords: legacyUpdate.bannedWords, ctaStyle: legacyUpdate.ctaStyle, analysisNotes: legacyUpdate.analysisNotes }, { niche: 'niche edited', audience: 'audience edited', tone: 'tone edited', bannedWords: ['word-a', 'word-b'], ctaStyle: 'follow', analysisNotes: 'notes edited' });
  await page.locator('button[aria-label="แก้ไข Published fixture"]').click();
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'บันทึก')?.click());
  await page.waitForFunction(() => (window as unknown as { __fixtureManageUrl?: string }).__fixtureManageUrl === '/brands');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("verify-hero-script-workspace-browser: PASS mounted tabs, delayed preferences, guide, profiles, and mobile width");
} finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
