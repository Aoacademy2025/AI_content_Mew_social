import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const previewUrl = process.env.MARKETING_PREVIEW_URL ?? "http://127.0.0.1:3010/";
const browser = await puppeteer.launch({ headless: true });

try {
  for (const width of [320, 342, 390, 430]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("[data-mobile-workbench]");
    await page.waitForFunction(() => {
      const workbench = document.querySelector("[data-mobile-workbench]");
      const animatedFrame = workbench?.parentElement?.parentElement;
      return animatedFrame && getComputedStyle(animatedFrame).transform === "none";
    });

    const result = await page.evaluate(() => {
      const root = document.querySelector("[data-mobile-workbench]");
      const hook = document.querySelector("[data-mobile-hook-card]");
      const primary = document.querySelector("[data-mobile-primary-copy]");
      const preview = document.querySelector("[data-mobile-preview]");
      if (!(root instanceof HTMLElement)) throw new Error("Missing mobile workbench");
      if (!(hook instanceof HTMLElement)) throw new Error("Missing mobile hook card");
      if (!(primary instanceof HTMLElement)) throw new Error("Missing mobile primary copy");
      if (!(preview instanceof HTMLElement)) throw new Error("Missing mobile video preview");

      const rootRect = root.getBoundingClientRect();
      const hookRect = hook.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const visibleTypeSizes = [...root.querySelectorAll("p, span")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((element) => Number.parseFloat(getComputedStyle(element).fontSize));

      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        hookWidthRatio: hookRect.width / rootRect.width,
        primaryFontSize: Number.parseFloat(getComputedStyle(primary).fontSize),
        previewWidth: previewRect.width,
        previewRatio: previewRect.height / previewRect.width,
        smallestVisibleType: Math.min(...visibleTypeSizes),
      };
    });

    assert.equal(result.documentWidth, result.viewportWidth, `${width}px page must not overflow horizontally`);
    assert.ok(result.hookWidthRatio >= 0.77, `${width}px primary message must span the mobile content column`);
    assert.ok(result.primaryFontSize >= 15, `${width}px primary message must remain comfortably readable`);
    assert.ok(result.previewWidth >= 110, `${width}px video preview must remain recognizable`);
    assert.ok(Math.abs(result.previewRatio - (16 / 9)) < 0.08, `${width}px video preview must preserve the 9:16 format`);
    assert.ok(result.smallestVisibleType >= 10, `${width}px mobile workbench must not use microcopy below 10px`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("PASS marketing mobile workbench remains readable and balanced from 320px to 430px");
