import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const postPhaseSource = readFileSync(
  path.resolve("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx"),
  "utf8",
);

const previewHeightMatch = postPhaseSource.match(
  /data-video-preview-frame="true"[\s\S]*?style=\{\{\s*height:\s*"([^"]+)"/,
);
assert.ok(previewHeightMatch, "desktop preview must declare an inline height contract");
const previewHeight = previewHeightMatch[1];

const postPhaseRootClassMatch = postPhaseSource.match(
  /return\s*\(\s*<div className="([^"]*flex min-h-0[^"]*flex-1[^"]*flex-col[^"]*)">/,
);
assert.ok(postPhaseRootClassMatch, "desktop post-production root must declare its layout contract");
const postPhaseRootClasses = postPhaseRootClassMatch[1].split(/\s+/);
assert.ok(
  postPhaseRootClasses.includes("min-w-0"),
  "desktop PostPhase must allow its duration-sized timeline to shrink within the viewport",
);

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1536, height: 842 },
  { width: 1440, height: 900 },
  { width: 2048, height: 1122 },
];

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    // GitHub-hosted Linux runners disable the Chromium user-namespace sandbox.
    // The runner is ephemeral and trusted, so launch without it only in CI.
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });

  try {
    const page = await browser.newPage();

    for (const viewport of VIEWPORTS) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html>
      <html>
        <head>
          <style>
            * { box-sizing: border-box; }
            html, body { width: 100%; height: 100%; margin: 0; }
            #shell { display: flex; height: 100vh; flex-direction: column; }
            #topbar { height: 58px; flex: none; }
            #post-phase { display: flex; min-height: 0; flex: 1; flex-direction: column; }
            #export-bar { height: 60px; flex: none; order: -1; }
            #editor-row { display: flex; min-height: 0; flex: 1; }
            #left-panel { width: 266px; flex: none; }
            #workspace {
              display: flex;
              min-width: 0;
              flex: 1;
              align-items: center;
              justify-content: center;
              padding: 16px;
            }
            #right-panel { width: 330px; flex: none; }
            #preview { position: relative; aspect-ratio: 9 / 16; }
            #timeline { height: 226px; flex: none; }
          </style>
        </head>
        <body>
          <div id="shell">
            <div id="topbar"></div>
            <div id="post-phase">
              <div id="editor-row">
                <aside id="left-panel"></aside>
                <main id="workspace"><div id="preview"></div></main>
                <aside id="right-panel"></aside>
              </div>
              <div id="export-bar"></div>
              <div id="timeline"></div>
            </div>
          </div>
        </body>
      </html>`);

      const bounds = await page.evaluate((height) => {
        const preview = document.querySelector<HTMLElement>("#preview");
        const workspace = document.querySelector<HTMLElement>("#workspace");
        if (!preview || !workspace) throw new Error("layout fixture is incomplete");
        preview.style.height = height;

        const previewRect = preview.getBoundingClientRect();
        const workspaceRect = workspace.getBoundingClientRect();
        const workspaceStyle = getComputedStyle(workspace);
        const paddingTop = Number.parseFloat(workspaceStyle.paddingTop);
        const paddingRight = Number.parseFloat(workspaceStyle.paddingRight);
        const paddingBottom = Number.parseFloat(workspaceStyle.paddingBottom);
        const paddingLeft = Number.parseFloat(workspaceStyle.paddingLeft);

        return {
          preview: {
            top: previewRect.top,
            right: previewRect.right,
            bottom: previewRect.bottom,
            left: previewRect.left,
            width: previewRect.width,
            height: previewRect.height,
          },
          workspaceContent: {
            top: workspaceRect.top + paddingTop,
            right: workspaceRect.right - paddingRight,
            bottom: workspaceRect.bottom - paddingBottom,
            left: workspaceRect.left + paddingLeft,
          },
        };
      }, previewHeight);

      const tolerance = 0.5;
      assert.ok(
        bounds.preview.top >= bounds.workspaceContent.top - tolerance
          && bounds.preview.right <= bounds.workspaceContent.right + tolerance
          && bounds.preview.bottom <= bounds.workspaceContent.bottom + tolerance
          && bounds.preview.left >= bounds.workspaceContent.left - tolerance,
        `desktop preview (${bounds.preview.width.toFixed(2)}x${bounds.preview.height.toFixed(2)}) `
          + `must fit the workspace content at ${viewport.width}x${viewport.height}`,
      );
      assert.ok(
        Math.abs((bounds.preview.width / bounds.preview.height) - (9 / 16)) < 0.001,
        `desktop preview must remain 9:16 at ${viewport.width}x${viewport.height}`,
      );
    }

    // Regression: a duration-sized timeline used to make PostPhase honor its
    // ~2053px min-content width. Clicking a B-roll window then mounted the
    // 340px inspector beyond the right edge of a 1512px desktop viewport.
    await page.setViewport({ width: 1512, height: 862, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
      <html>
        <head>
          <style>
            * { box-sizing: border-box; }
            html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
            #shell { display: flex; width: 100vw; height: 100vh; flex-direction: column; }
            #post-phase {
              display: flex;
              min-width: ${postPhaseRootClasses.includes("min-w-0") ? "0" : "auto"};
              min-height: 0;
              flex: 1;
              flex-direction: column;
            }
            #editor-row { display: flex; min-height: 0; flex: 1; }
            #left-panel { width: 266px; flex: none; }
            #workspace { min-width: 0; flex: 1; }
            #right-panel { width: 330px; flex: none; }
            #inspector { display: none; width: 340px; flex: none; }
            #timeline { display: flex; height: 192px; flex: none; flex-direction: column; }
            #timeline-scroller { flex: 1; overflow-x: auto; overflow-y: hidden; }
            #timeline-inner { position: relative; width: 2052.576px; min-width: 100%; }
          </style>
        </head>
        <body>
          <div id="shell">
            <div id="post-phase">
              <div id="editor-row">
                <aside id="left-panel"></aside>
                <main id="workspace">
                  <button id="broll-window" type="button">B-roll</button>
                </main>
                <aside id="right-panel"></aside>
                <aside id="inspector">B-roll inspector</aside>
              </div>
              <div id="timeline">
                <div id="timeline-scroller"><div id="timeline-inner"></div></div>
              </div>
            </div>
          </div>
          <script>
            document.querySelector("#broll-window").addEventListener("click", () => {
              document.querySelector("#inspector").style.display = "flex";
            });
          </script>
        </body>
      </html>`);
    await page.click("#broll-window");

    const brollBounds = await page.evaluate(() => {
      const inspector = document.querySelector<HTMLElement>("#inspector");
      const postPhase = document.querySelector<HTMLElement>("#post-phase");
      if (!inspector || !postPhase) throw new Error("B-roll layout fixture is incomplete");
      const inspectorRect = inspector.getBoundingClientRect();
      const postPhaseRect = postPhase.getBoundingClientRect();
      return {
        inspectorLeft: inspectorRect.left,
        inspectorRight: inspectorRect.right,
        inspectorWidth: inspectorRect.width,
        postPhaseWidth: postPhaseRect.width,
        viewportWidth: window.innerWidth,
      };
    });
    assert.ok(
      brollBounds.inspectorWidth > 0
        && brollBounds.inspectorLeft >= 0
        && brollBounds.inspectorRight <= brollBounds.viewportWidth,
      `80.274s B-roll inspector (${brollBounds.inspectorLeft.toFixed(2)}-`
        + `${brollBounds.inspectorRight.toFixed(2)}) must remain visible at `
        + `1512x862; PostPhase width was ${brollBounds.postPhaseWidth.toFixed(2)}px`,
    );

    await page.close();
    console.log(`editor preview and B-roll inspector layouts verified with height: ${previewHeight}`);
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
