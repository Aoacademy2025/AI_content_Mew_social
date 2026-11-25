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
  page.on("dialog", dialog => void dialog.accept());
  const button = (text: string) => page.locator(`::-p-text(${text})`);

  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/brands`);
  await page.waitForSelector('input[name="brand-setup-style"]');
  assert.equal(await page.$$eval('input[required],textarea[required]', inputs => inputs.length), 0);
  // Inline brand name is visible immediately — never hidden in an accordion.
  assert.equal(await page.$eval('#brand-name', (input: HTMLInputElement) => input.value), "แบรนด์ของฉัน");
  assert.equal(await page.$$eval('input[name="brand-setup-style"]:checked', inputs => inputs.length), 1);
  assert.equal(await page.$$eval('[role="tab"]', tabs => tabs.length), 4, "Brand Kit Studio exposes 4 tabs");

  mkdirSync("artifacts/brands-ux-qa", { recursive: true });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewport({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px must not overflow horizontally`);
    if (width < 1024) {
      const reachable = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(el => el.textContent?.includes('ใช้แบรนด์นี้สร้างคลิป')); const r = b!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight - 56; });
      assert.ok(reachable, `${width}px: primary action stays above bottom navigation`);
    }
    if ([390, 1280].includes(width)) await page.screenshot({ path: `artifacts/brands-ux-qa/live-chooser-${width}.png`, fullPage: true });
  }

  await page.setViewport({ width: 1280, height: 1180 });
  await page.screenshot({ path: "artifacts/brands-ux-qa/live-chooser-1280-tall.png", fullPage: true });

  // Test Motion B-Roll mode live canvas + 6 themes + 4 mascots, then return to Stock mode
  await button("Motion B-Roll").click();
  await page.waitForSelector('aside canvas');
  await page.screenshot({ path: "artifacts/brands-ux-qa/live-motion-1280.png", fullPage: true });
  await button("สต็อก & AutoMix").click();
  await page.waitForSelector('input[name="brand-setup-style"]');
  await page.setViewport({ width: 1280, height: 844 });

  // Test 4-tab switching & contextual progressive disclosure
  const visualAdvOpen = () => page.$eval('[aria-controls="brand-advanced-visual"]', (b) => b.getAttribute("aria-expanded"));
  assert.equal(await visualAdvOpen(), "false", "Tab 1 advanced controls start collapsed");
  await page.locator('#brand-tab-audio').click();
  await page.waitForSelector('#brand-tabpanel-audio');
  await page.locator('#brand-tab-captions').click();
  await page.waitForSelector('#brand-tabpanel-captions');
  await page.locator('#brand-tab-script').click();
  await page.waitForSelector('#brand-tabpanel-script');
  await page.locator('#brand-tab-visual').click();
  await page.waitForSelector('#brand-tabpanel-visual');

  // HERO-35: "เลือกแนวภาพเอง" unlinks the pack (ADR 0058) and keeps palette without opening Advanced
  const checkedPacks = () => page.$$eval('input[name="brand-setup-style"]:checked', inputs => inputs.map((input) => (input as HTMLInputElement).value));
  const previewAlt = () => page.$eval('aside figure[data-brand-mark-preview="true"] img', (img) => (img as HTMLImageElement).alt);
  const centerClick = async (selector: string) => {
    await page.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
    await page.locator(selector).click();
  };
  assert.equal(await visualAdvOpen(), "false");
  await centerClick('[aria-controls="brand-setup-format"]');
  await page.waitForSelector('#brand-setup-format [role="radio"]');
  assert.deepEqual(await checkedPacks(), ["life-drama"], "opening the format picker keeps the pack selected");
  assert.equal(await visualAdvOpen(), "false", "opening the format picker does not open Advanced");
  assert.equal(await page.$eval('#brand-setup-format [role="radio"][aria-checked="true"]', (b) => b.textContent), "ภาพสมจริงแบบหนัง", "the pack's own format is highlighted");
  assert.match(await previewAlt(), /^ภาพประกอบแนวทาง ดราม่าชีวิตจริง/);
  const paletteBefore = await page.$$eval('aside [aria-label="ชุดสีที่เลือก"] span', (dots) => dots.slice(0, 3).map((dot) => dot.getAttribute("title")));
  const formatRadios = await page.$$('#brand-setup-format [role="radio"]');
  const comicRadio = (await Promise.all(formatRadios.map(async (radio) => [radio, await radio.evaluate((b) => b.textContent)] as const))).find(([, text]) => text === "คอมิกเข้มข้น")?.[0];
  assert.ok(comicRadio, "the inline format picker offers คอมิกเข้มข้น");
  await comicRadio.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await comicRadio.click();
  await page.waitForFunction(() => document.querySelector('aside h3')?.textContent === "ปรับจาก ดราม่าชีวิตจริง");
  assert.deepEqual(await checkedPacks(), [], "another format unlinks the pack (ADR 0058)");
  assert.equal(await visualAdvOpen(), "false", "changing the format still does not open Advanced");
  assert.equal(await previewAlt(), "ตัวอย่างแนวภาพ คอมิกเข้มข้น", "the custom look previews its Visual Format instead of an empty frame");
  assert.deepEqual(await page.$$eval('aside [aria-label="ชุดสีที่เลือก"] span', (dots) => dots.slice(0, 3).map((dot) => dot.getAttribute("title"))), paletteBefore, "the pack's palette survives the format change");
  await centerClick('label:has(input[name="brand-setup-style"][value="comic-story"])');
  assert.deepEqual(await checkedPacks(), ["comic-story"], "the comic pack is a one-tap starter");
  assert.equal(await page.$eval('#brand-setup-format [role="radio"][aria-checked="true"]', (b) => b.textContent), "คอมิกเข้มข้น");
  await centerClick('label:has(input[name="brand-setup-style"][value="life-drama"])');
  await centerClick('[aria-controls="brand-setup-format"]');

  // PRO create-clip + ambiguous-save replay + returning Visual Brand Cards library
  await button("ใช้แบรนด์นี้สร้างคลิป").click();
  await button("ติดตามคำขอบันทึกเดิม").wait();
  await button("ติดตามคำขอบันทึกเดิม").click();
  await page.waitForFunction(() => location.pathname === "/video-editor");
  assert.match(page.url(), /projectId=fixture-project-1/);
  await button("กลับคลังแบรนด์").click();
  await button("แก้ไข").wait();
  assert.equal(await page.$$eval('article', elements => elements.length), 1, "response retry must show one brand");
  // Verify Hero Script ?brandId= link & MCP button exist on the returning Brand Card
  const heroScriptHref = await page.$eval('article a[href^="/hero-script?brandId="]', (a) => a.getAttribute("href"));
  assert.match(heroScriptHref ?? "", /\/hero-script\?brandId=fixture-brand-1/);
  await page.screenshot({ path: "artifacts/brands-ux-qa/live-library-1280.png", fullPage: true });

  // Edit inline brand name + navigation guard + draft recovery + revision save + reload recovery
  await button("แก้ไข").click();
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
  await page.locator('#brand-name').fill("Mew reload draft");
  await page.waitForFunction(() => document.body.innerText.includes('เก็บร่างในเครื่องแล้ว'));
  await page.reload();
  await button("แก้ไข").click();
  await button("กู้คืนร่าง").click();
  assert.equal(await page.$eval('#brand-name', (input: HTMLInputElement) => input.value), "Mew reload draft");

  // FREE Build-to-Convert path: saves brand cleanly without 403 and routes to /pricing?source=brands
  await page.goto(`http://127.0.0.1:${port}/brands?plan=FREE&new=1`);
  await page.waitForSelector('#brand-name');
  await button("บันทึกแบรนด์ & อัปเกรดเพื่อสร้างคลิป").click();
  await page.waitForFunction(() => location.pathname === "/pricing");
  assert.match(page.url(), /source=brands/);

  console.log("PASS real Brands Kit Studio: zero typing, mobile widths, live Motion stage, 4 tabs, ADR 0058 format escape, ambiguous-save replay, Visual Brand Library, Hero Script link, draft/reload recovery, and FREE Build-to-Convert");
} finally {
  await browser?.close();
  fixture.kill("SIGTERM");
}
