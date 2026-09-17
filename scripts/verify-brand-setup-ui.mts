/** Real React client, isolated fixture APIs and disposable Chromium, for CI.
 * Transaction correctness is covered by verify-brand-setup against SQLite. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer";
const port = "8955";
const fixture = spawn(process.execPath, ["--import", "tsx", "scripts/brand-setup-browser-harness.mts", "--failure-once"], { env: { ...process.env, BRAND_SETUP_FIXTURE_PORT: port }, stdio: ["ignore", "pipe", "pipe"] });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture startup timeout")), 20_000);
    fixture.stdout.on("data", data => { if (String(data).includes("Brand setup fixture:")) { clearTimeout(timer); resolve(); } });
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
    fixture.stderr.on("data", data => { if (String(data).includes("Error:")) console.error(String(data)); });
  });
  browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [] });
  const page = await browser.newPage();
  // Only this disposable test tab: allow the deliberately tested reload.
  page.on("dialog", dialog => void dialog.accept());
  const button = (text: string) => page.locator(`::-p-text(${text})`);
  // The CTA bar is sticky at the viewport bottom; a summary that is "in view"
  // but under the bar receives the bar's click, so centre it first.
  const openNameSummary = async () => {
    await page.$$eval('summary', (summaries) => summaries.find((s) => s.textContent?.startsWith("ชื่อแบรนด์ ·"))!.scrollIntoView({ block: "center" }));
    await button("ชื่อแบรนด์ ·").click();
  };
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/brands`);
  await page.waitForSelector('input[name="brand-setup-style"]');
  assert.equal(await page.$$eval('input[required],textarea[required]', inputs => inputs.length), 0);
  assert.equal(await page.$eval('#brand-name', (input: HTMLInputElement) => input.value), "แบรนด์ของฉัน");
  assert.equal(await page.$$eval('input[name="brand-setup-style"]:checked', inputs => inputs.length), 1);
  mkdirSync("artifacts/brands-ux-qa", { recursive: true });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewport({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width < 1024) {
      const reachable = await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('ใช้แบรนด์นี้สร้างคลิป')); const r = button!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight - 56; });
      assert.ok(reachable, `${width}px: primary action stays above bottom navigation`);
    }
    if ([390, 1280].includes(width)) await page.screenshot({ path: `artifacts/brands-ux-qa/live-chooser-${width}.png`, fullPage: true });
  }
  // HERO-35: "เลือกแนวภาพเอง" is a one-axis escape, not the 40-field cliff.
  const checkedPacks = () => page.$$eval('input[name="brand-setup-style"]:checked', inputs => inputs.map((input) => (input as HTMLInputElement).value));
  const advancedOpen = () => page.$eval('[aria-controls="brand-advanced-panel"]', (b) => b.getAttribute("aria-expanded"));
  const previewAlt = () => page.$eval('aside figure img', (img) => (img as HTMLImageElement).alt);
  assert.equal(await advancedOpen(), "false");
  await button("เลือกแนวภาพเอง").click();
  await page.waitForSelector('#brand-setup-format [role="radio"]');
  assert.deepEqual(await checkedPacks(), ["life-drama"], "opening the format picker keeps the pack selected");
  assert.equal(await advancedOpen(), "false", "opening the format picker does not open the Advanced form");
  assert.equal(await page.$eval('#brand-setup-format [role="radio"][aria-checked="true"]', (b) => b.textContent), "ภาพสมจริงแบบหนัง", "the pack's own format is highlighted");
  assert.match(await previewAlt(), /^ภาพประกอบแนวทาง ดราม่าชีวิตจริง/);
  const paletteBefore = await page.$$eval('[aria-label="ชุดสีที่เลือก"] span', (dots) => dots.map((dot) => dot.getAttribute("title")));
  // The card's text sits under an absolutely positioned overlay, which the
  // text locator resolves to; click the radio button itself instead.
  const formatRadios = await page.$$('#brand-setup-format [role="radio"]');
  const comicRadio = (await Promise.all(formatRadios.map(async (radio) => [radio, await radio.evaluate((b) => b.textContent)] as const))).find(([, text]) => text === "คอมิกเข้มข้น")?.[0];
  assert.ok(comicRadio, "the inline format picker offers คอมิกเข้มข้น");
  await comicRadio.click();
  await page.waitForFunction(() => document.querySelector('aside h3')?.textContent === "ปรับจาก ดราม่าชีวิตจริง");
  assert.deepEqual(await checkedPacks(), [], "another format unlinks the pack (ADR 0058)");
  assert.equal(await advancedOpen(), "false", "changing the format still does not open the Advanced form");
  assert.equal(await previewAlt(), "ตัวอย่างแนวภาพ คอมิกเข้มข้น", "the custom look previews its Visual Format instead of an empty frame");
  assert.deepEqual(await page.$$eval('[aria-label="ชุดสีที่เลือก"] span', (dots) => dots.map((dot) => dot.getAttribute("title"))), paletteBefore, "the pack's palette survives the format change");
  await page.locator('input[name="brand-setup-style"][value="comic-story"]').click();
  assert.deepEqual(await checkedPacks(), ["comic-story"], "the comic pack is a one-tap starter");
  assert.equal(await page.$eval('#brand-setup-format [role="radio"][aria-checked="true"]', (b) => b.textContent), "คอมิกเข้มข้น");
  await page.locator('input[name="brand-setup-style"][value="life-drama"]').click();
  await button("ซ่อนแนวภาพ").click();
  await button("ใช้แบรนด์นี้สร้างคลิป").click();
  await button("ติดตามคำขอบันทึกเดิม").wait();
  await button("ติดตามคำขอบันทึกเดิม").click();
  await page.waitForFunction(() => location.pathname === "/video-editor");
  assert.match(page.url(), /projectId=fixture-project-1/);
  await button("กลับคลังแบรนด์").click();
  await button("แก้ไข").wait();
  assert.equal(await page.$$eval('article', elements => elements.length), 1, "response retry must show one brand");
  await button("แก้ไข").click();
  await openNameSummary();
  await page.locator('#brand-name').fill("Mew Comic draft");
  await button("กลับคลังแบรนด์").click();
  await button("เก็บร่างแล้วไปต่อ").click();
  await button("แก้ไข").click();
  await button("กู้คืนร่าง").click();
  assert.equal(await page.$eval('#brand-name', (input: HTMLInputElement) => input.value), "Mew Comic draft");
  await button("บันทึกสำหรับคลิปใหม่").click();
  await page.waitForFunction(() => [...document.querySelectorAll('article h2')].some(e => e.textContent === 'Mew Comic draft'));
  assert.equal(await page.$$eval('article', elements => elements.length), 1);
  await button("แก้ไข").click();
  await openNameSummary();
  await page.locator('#brand-name').fill("Mew reload draft");
  await page.waitForFunction(() => document.body.innerText.includes('เก็บร่างในเครื่องแล้ว'));
  await page.reload();
  await button("แก้ไข").click();
  await button("กู้คืนร่าง").click();
  assert.equal(await page.$eval('#brand-name', (input: HTMLInputElement) => input.value), "Mew reload draft");
  console.log("PASS real Brands client: zero typing, mobile widths, inline format picker keeps pack values and never opens Advanced, comic starter, ambiguous-save replay, returning library, inline navigation guard, draft recovery, revision save, reload recovery");
} finally {
  await browser?.close();
  fixture.kill("SIGTERM");
}
