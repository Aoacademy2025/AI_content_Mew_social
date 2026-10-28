import assert from "node:assert/strict";
import puppeteer from "puppeteer";

// Sale page on phones: nothing scrolls sideways, the editor demo sits above its chat,
// and the bottom CTA stays on screen.
const previewUrl = process.env.MARKETING_PREVIEW_URL ?? "http://127.0.0.1:3010/";
const browser = await puppeteer.launch({ headless: true });

try {
  for (const width of [320, 342, 390, 430]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".sv3 #app");

    const result = await page.evaluate(() => {
      const app = document.querySelector("#app")?.getBoundingClientRect();
      const chat = document.querySelector("#chat3")?.getBoundingClientRect();
      const cta = document.querySelector(".mcta")?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        appTop: app?.top ?? -1,
        chatTop: chat?.top ?? -1,
        ctaBottom: cta?.bottom ?? -1,
        ctaHeight: cta?.height ?? 0,
      };
    });

    assert.ok(result.documentWidth <= width, `${width}px: page is ${result.documentWidth}px wide`);
    assert.ok(result.appTop < result.chatTop, `${width}px: editor should sit above the chat`);
    assert.ok(result.ctaHeight > 0 && Math.round(result.ctaBottom) <= 900, `${width}px: bottom CTA not visible`);
    await page.close();
  }
  console.log("marketing mobile preview OK");
} finally {
  await browser.close();
}
