import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

async function main() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { EditorPanelLayout } from "./src/app/(dashboard)/video-editor/_v2/EditorPanelLayout";
        function Probe() {
          const [inspector, setInspector] = useState(false);
          return <><button onClick={() => setInspector(!inspector)}>B-roll</button>
          <div id="row" style={{display:"flex", height:600, overflowX:"auto"}}>
            <EditorPanelLayout>
              <aside id="left" style={{width:"var(--editor-left-width)",flexShrink:0}}>การ์ดซับ</aside>
              <main id="preview" style={{flex:1,minWidth:0}}>พรีวิว</main>
              <aside id="right" style={{width:"var(--editor-right-width)",flexShrink:0}}>ซับ โลโก้ พาดหัว</aside>
            </EditorPanelLayout>
            {inspector && <aside style={{width:340,flexShrink:0}}>B-roll inspector</aside>}
          </div></>;
        }
        createRoot(document.getElementById("root")).render(<Probe />);
      `,
      loader: "tsx", resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8");
    response.end(request.url === "/bundle.js" ? outputFiles[0].contents
      : '<style>body{margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : puppeteer.executablePath()),
    headless: true, args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForSelector("#left");
    const width = (id: string) => page.$eval(`#${id}`, (element) => element.getBoundingClientRect().width);
    const drag = async (label: string, dx: number) => {
      const handle = await page.$(`[role="separator"][aria-label="${label}"]`);
      assert.ok(handle, `Missing resize handle: ${label}`);
      const box = await handle.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    assert.equal(await width("left"), 266);
    await drag("ปรับความกว้างแผงซ้าย", 100);
    assert.equal(await width("left"), 366, "Dragging right should expand the left panel");
    await drag("ปรับความกว้างแผงขวา", -100);
    assert.equal(await width("right"), 430, "Dragging left should expand the right panel");
    await page.reload();
    await page.waitForSelector("#left");
    assert.equal(await width("left"), 366, "Left panel width should survive reload");
    assert.equal(await width("right"), 430, "Right panel width should survive reload");
    await page.focus('[role="separator"][aria-label="ปรับความกว้างแผงซ้าย"]');
    await page.keyboard.press("ArrowRight");
    assert.equal(await width("left"), 376, "Keyboard users should be able to expand the left panel");
    await page.focus('[role="separator"][aria-label="ปรับความกว้างแผงขวา"]');
    await page.keyboard.press("ArrowLeft");
    assert.equal(await width("right"), 440, "Keyboard direction should match the divider movement");
    await page.setViewport({ width: 784, height: 900 });
    await page.waitForFunction(() => document.querySelector("#preview")!.getBoundingClientRect().width >= 239);
    assert.ok(await width("left") >= 220);
    assert.ok(await width("right") >= 260);
    await page.setViewport({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector("#left")!.getBoundingClientRect().width === 376);
    assert.equal(await width("right"), 440, "Resizing the window should preserve preferred panel sizes");
    await drag("ปรับความกว้างแผงซ้าย", 800);
    assert.equal(await width("left"), 520, "Panel growth should be bounded");
    await drag("ปรับความกว้างแผงขวา", 800);
    assert.equal(await width("right"), 260, "Panel shrinking should preserve usable controls");
    await page.setViewport({ width: 784, height: 900 });
    await page.click("button");
    await page.waitForFunction(() => document.querySelector("#preview")!.getBoundingClientRect().width >= 239);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 784, "B-roll inspector must not push the page beyond the viewport");
    assert.ok(await page.$eval("#row", (row) => row.scrollWidth > row.clientWidth), "Narrow layouts keep all controls reachable by scrolling the editor row");
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.setItem("hero-editor-panel-widths-v1", "broken JSON"));
    await page.reload();
    await page.waitForSelector("#left");
    assert.equal(await width("left"), 266, "Invalid saved preferences must fall back to usable defaults");
    await page.evaluate(() => localStorage.setItem("hero-editor-panel-widths-v1", '{"left":999999,"right":-10}'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#left")?.getBoundingClientRect().width === 520);
    assert.equal(await width("right"), 260, "Stored widths outside the limits must be clamped");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Unavailable", "SecurityError"); } });
    });
    await page.reload();
    await page.waitForSelector("#left");
    await drag("ปรับความกว้างแผงซ้าย", 100);
    assert.equal(await width("left"), 366, "Resizing must work without browser storage");
    assert.deepEqual(errors, []);
    console.log("PASS: pointer and keyboard resize, reload persistence, narrow/B-roll layouts, and unavailable or invalid storage");
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
