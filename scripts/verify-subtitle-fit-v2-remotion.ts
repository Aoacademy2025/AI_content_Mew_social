import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import sharp from "sharp";

const FLAG = "NEXT_PUBLIC_SUBTITLE_FIT_V2";

type PixelBounds = {
  width: number;
  height: number;
  count: number;
};

async function foregroundBounds(file: string): Promise<PixelBounds> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 120 || data[offset + 1] < 120 || data[offset + 2] < 120) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  assert.ok(count > 0, `expected visible subtitle pixels in ${file}`);
  return { width: maxX - minX + 1, height: maxY - minY + 1, count };
}

async function previewRollbackFontSize(): Promise<string> {
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { renderSubEl } from "./src/app/(dashboard)/video-editor/_components/subtitle-renderer";
    createRoot(document.getElementById("root")).render(
      <div>{renderSubEl("abcdefghij", "#fff", "#FFE500", false, "plain", "Arial, sans-serif", 80, 400, 1, "fade")}</div>
    );
  `;
  const bundled = await build({
    stdin: {
      contents: fixture,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "subtitle-fit-v2-preview-fixture.tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define: {
      "process.env.NEXT_PUBLIC_SUBTITLE_FIT_V2": JSON.stringify("0"),
    },
  });
  const browser = await puppeteer.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.waitForFunction(() => document.querySelector("span")?.textContent === "abcdefghij");
    return await page.$eval("span", (node) => getComputedStyle(node).fontSize);
  } finally {
    await browser.close();
  }
}

async function main() {
  assert.equal(await previewRollbackFontSize(), "72px");
  console.log("✓ browser preview honors NEXT_PUBLIC_SUBTITLE_FIT_V2=0");

  const tempRoot = mkdtempSync(path.join(tmpdir(), "subtitle-fit-v2-"));
  let serveUrl: string | null = null;
  try {
    serveUrl = await bundle({
      entryPoint: path.resolve("scripts/fixtures/subtitle-fit-v2-remotion.tsx"),
      publicDir: path.resolve("public"),
      webpackOverride: (config) => config,
    });

    const render = async (name: string, text: string, flag: "0" | "1") => {
      const envVariables = { [FLAG]: flag };
      const inputProps = { text };
      const composition = await selectComposition({
        serveUrl: serveUrl!,
        id: "SubtitleFitV2Fixture",
        inputProps,
        envVariables,
      });
      const output = path.join(tempRoot, `${name}.png`);
      await renderStill({
        composition,
        serveUrl: serveUrl!,
        output,
        frame: 0,
        imageFormat: "png",
        inputProps,
        envVariables,
      });
      return foregroundBounds(output);
    };

    const configured = await render("configured", "abcdefghij", "1");
    const rollback = await render("rollback", "abcdefghij", "0");
    assert.ok(
      configured.width > rollback.width && configured.height >= rollback.height,
      `Remotion flag should change 80px configured text to 72px rollback (${configured.width}x${configured.height} vs ${rollback.width}x${rollback.height})`,
    );
    console.log("✓ Remotion selectComposition and renderStill honor the same flag-off rollback");

    const longThai = await render(
      "long-thai",
      "และอาจแตะเกือบ 3. 2 พันล้านบาทในปีหน้า",
      "1",
    );
    assert.ok(longThai.width <= 994, `80px Thai subtitle stays inside the 92% frame width (${longThai.width}px)`);
    // CI and production may resolve different Thai fallback fonts, so line count
    // is not a stable invariant. The real safety boundary is that wrapped glyphs
    // remain comfortably inside this 480px fixture frame.
    assert.ok(longThai.height <= 360, `80px Thai subtitle wraps inside the burn frame (${longThai.height}px)`);
    console.log("✓ longest reported 80px Thai card wraps inside the burn frame");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }

  console.log("\n✅ SUBTITLE FIT V2 BROWSER/REMOTION CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
