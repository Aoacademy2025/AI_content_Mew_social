import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import sharp from "sharp";

async function verifyPausedEditorPreview(): Promise<void> {
  const fixture = `
    import React, { useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { V2CaptionOverlay } from "./src/app/(dashboard)/video-editor/_v2/V2CaptionOverlay";

    function Fixture() {
      const videoRef = useRef(null);
      const [playing, setPlaying] = useState(true);
      return <div style={{ position: "relative", width: 540, height: 960, background: "#5A3828" }}>
        <video ref={videoRef} style={{ display: "none" }} />
        <button id="edit-caption" type="button" onClick={() => setPlaying(false)}>edit</button>
        <output id="playback-state">{playing ? "playing" : "paused"}</output>
        <V2CaptionOverlay
          captions={[{ text: "ประมาณ 170 , 000", startMs: 0, endMs: 1000, tag: "body" }]}
          overrides={{}}
          cfg={{
            preset: "stroke",
            effect: "karaoke",
            fontFamily: "Arial, sans-serif",
            bold: true,
            fontSize: 107,
            textColor: "#FFE500",
            accentColor: "#F87171",
            shadow: false,
            outline: false,
            outlineSize: 2,
            verticalPos: 20,
          }}
          videoRef={videoRef}
          playing={playing}
          onVerticalPos={() => {}}
        />
      </div>;
    }

    createRoot(document.getElementById("root")).render(<Fixture />);
  `;
  const bundled = await build({
    stdin: {
      contents: fixture,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "subtitle-karaoke-preview-fixture.tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });

  const browser = await puppeteer.launch({
    headless: true,
    // GitHub-hosted Linux runners disable the Chromium user-namespace sandbox.
    // The runner is ephemeral and trusted, so launch without it only in CI.
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 540, height: 960, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });

    await page.waitForFunction(() => (
      [...document.querySelectorAll("span")].some((node) => node.textContent === "170")
    ));
    const playingNumeric = await page.$eval("span", () => {
      const token = [...document.querySelectorAll("span")].find((node) => node.textContent === "170");
      if (!token) return null;
      const style = getComputedStyle(token);
      const rect = token.getBoundingClientRect();
      return { color: style.color, opacity: style.opacity, width: rect.width, height: rect.height };
    });
    assert.ok(playingNumeric, "playing preview renders the numeric token");
    assert.equal(playingNumeric.color, "rgb(255, 229, 0)", "playing preview keeps inactive numbers fully opaque");
    assert.equal(playingNumeric.opacity, "1", "playing preview does not hide inactive numbers with element opacity");
    assert.ok(playingNumeric.width > 0 && playingNumeric.height > 0, "playing preview lays out visible numeric glyphs");

    await page.$eval("#edit-caption", (button) => (button as HTMLButtonElement).click());
    await page.waitForFunction(() => document.querySelector("#playback-state")?.textContent === "paused");
    await page.waitForFunction(() => (
      [...document.querySelectorAll("span")].some((node) => (
        node.childElementCount === 0 && node.textContent === "ประมาณ 170 , 000"
      ))
    ));
    const pausedNumeric = await page.evaluate(() => {
      const container = [...document.querySelectorAll("span")]
        .find((node) => node.childElementCount === 0 && node.textContent === "ประมาณ 170 , 000");
      if (!container) return null;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let textNode: Text | null = null;
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text;
        if (candidate.data.includes("170 , 000")) {
          textNode = candidate;
          break;
        }
      }
      if (!textNode) return null;
      const start = textNode.data.indexOf("170 , 000");
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "170 , 000".length);
      const rect = range.getBoundingClientRect();
      const style = getComputedStyle(container);
      return { color: style.color, opacity: style.opacity, width: rect.width, height: rect.height };
    });
    assert.ok(pausedNumeric, "paused edit preview retains the numeric substring");
    assert.equal(pausedNumeric.color, "rgb(255, 229, 0)", "paused edit preview renders the source text at full color");
    assert.equal(pausedNumeric.opacity, "1", "paused edit preview keeps the source text opaque");
    assert.ok(pausedNumeric.width > 0 && pausedNumeric.height > 0, "paused edit preview lays out numeric glyphs");

    await page.close();
  } finally {
    await browser.close();
  }
}

async function verifyRemotionExportPixels(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "subtitle-karaoke-integration-"));
  let serveUrl: string | null = null;
  try {
    const output = path.join(tempRoot, "karaoke-frame.png");
    serveUrl = await bundle({
      entryPoint: path.resolve("scripts/fixtures/subtitle-karaoke-remotion.tsx"),
      publicDir: path.resolve("public"),
      webpackOverride: (config) => config,
    });
    const composition = await selectComposition({
      serveUrl,
      id: "SubtitleKaraokeVisibilityFixture",
      inputProps: {},
    });
    await renderStill({
      composition,
      serveUrl,
      output,
      frame: 5,
      imageFormat: "png",
      inputProps: {},
    });

    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let readableYellowPixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red > 210 && green > 170 && blue < 90) readableYellowPixels++;
    }
    assert.ok(
      readableYellowPixels > 100,
      `Remotion export frame keeps inactive subtitle glyphs readable (${readableYellowPixels} yellow pixels)`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await verifyPausedEditorPreview();
  console.log("✓ editor preview shows numeric karaoke text during playback and paused editing");
  await verifyRemotionExportPixels();
  console.log("✓ Remotion export frame keeps inactive karaoke text readable on dark footage");
  console.log("\n✅ SUBTITLE KARAOKE INTEGRATION CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
