/**
 * /brands must fit a phone (#338) and its Brand-look preview tiles must stay
 * usable there (#330) — while desktop (>= lg) stays exactly as it shipped.
 *
 * Why this rig instead of driving the live route: /brands sits behind Clerk auth
 * AND the Brand Visual rollout gate AND a first-clip redirect, and the preview
 * tiles only exist once a paid image batch has actually been generated. None of
 * that is reproducible in CI. So we render the REAL client components
 * (BrandList / VisualFormatPicker / AdvancedSettings / BrandLookPreviewPanel)
 * with react-dom/server, wrap them in the REAL layout shell — every wrapper
 * class string is READ OUT of dashboard-layout.tsx and BrandLibraryClient.tsx at
 * run time, so this test follows the source instead of a hand-copied replica —
 * compile the REAL Tailwind stylesheet over the result, and measure it in
 * Chrome. Extraction failures are hard errors: if someone rewrites the page
 * shell, this script stops rather than silently measuring stale markup.
 *
 * Run: npm run verify:brands-mobile
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";
import puppeteer from "puppeteer";

import { BrandList } from "../src/app/(dashboard)/brands/_components/BrandList.tsx";
import { BrandBasicsForm } from "../src/app/(dashboard)/brands/_components/BrandBasicsForm.tsx";
import { VisualFormatPicker } from "../src/app/(dashboard)/brands/_components/VisualFormatPicker.tsx";
import { AdvancedSettings } from "../src/app/(dashboard)/brands/_components/AdvancedSettings.tsx";
import { BrandLookPreviewPanel } from "../src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx";
import { Button } from "../src/components/ui/button.tsx";
import { Card } from "../src/components/ui/card.tsx";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed.ts";
import { VISUAL_FORMATS } from "../src/lib/brand-visual-system.ts";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const h = React.createElement;
const noop = () => {};

/** Phone widths we support, plus the 500px viewport #338 was filed against. */
const PHONE_VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 500, height: 749 },
];
/** `lg` and up — the layout that must not move a pixel. */
const DESKTOP_VIEWPORTS = [
  { width: 1024, height: 800 },
  { width: 1280, height: 900 },
];
const LG_BRAND_LIST_TRACK = 248;

// ── layout contract, read from the real sources ─────────────────────────────
function extract(source, regex, label) {
  const match = source.match(regex);
  assert.ok(match, `verify-brands-mobile can no longer find ${label} — update the rig`);
  return match[1];
}

const layoutSource = read("src/components/layout/dashboard-layout.tsx");
const clientSource = read("src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx");

const shell = {
  root: extract(layoutSource, /<div className="(flex h-screen flex-col[^"]*)">/, "the dashboard shell root"),
  row: extract(layoutSource, /<div className="(flex flex-1 overflow-hidden)">/, "the dashboard sidebar row"),
  column: extract(layoutSource, /<div className="(flex flex-1 flex-col[^"]*)">/, "the dashboard content column"),
  main: extract(layoutSource, /\n\s*:\s*"(flex-1 overflow-y-auto[^"]*)"\n/, "the <main> padding contract"),
};
const page = {
  scroller: extract(clientSource, /<div className="(ve-no-padding[^"]*)">/, "the /brands scroll container"),
  inner: extract(clientSource, /<div className="(mx-auto max-w-\[1200px\][^"]*)">/, "the /brands content column"),
  header: extract(clientSource, /<header className="(ve-rise[^"]*)">/, "the /brands header"),
  grid: extract(clientSource, /<div className="(grid gap-5[^"]*)">/, "the /brands two-column grid"),
  mainColumn: extract(clientSource, /<div className="([^"]*space-y-4)">\s*\n\s*\{sourceProjectId/, "the /brands main column"),
  footer: extract(clientSource, /<div className="(flex flex-wrap items-center justify-between[^"]*border-t[^"]*)">/, "the /brands save row"),
};

// The desktop grid is what collapses to one column on phones. Guard the two
// halves of the mechanism that made #338 possible in the first place.
assert.ok(
  page.grid.includes("lg:grid-cols-[248px_minmax(0,1fr)]"),
  "the /brands grid must keep its lg two-column track",
);
assert.ok(
  page.mainColumn.split(/\s+/).includes("min-w-0"),
  "the /brands main column must keep min-w-0 so the mobile grid track can shrink",
);
assert.ok(
  read("src/app/(dashboard)/brands/_components/BrandList.tsx").includes("min-w-0 p-3"),
  "BrandList's card must keep min-w-0 — without it the single mobile column grows to its widest label (#338)",
);

// ── fixtures ────────────────────────────────────────────────────────────────
const seed = createBlankBrandProfileSeed();
const draft = {
  ...seed,
  name: "Mew Social",
  niche: "การตลาดสำหรับครีเอเตอร์สายคอนเทนต์สั้น",
  audience: "ครีเอเตอร์มือใหม่ที่อยากทำคลิปสั้นให้จบในวันเดียว",
};

const library = {
  profiles: [],
  cap: 3,
  canCreate: true,
  creationRequiresResult: false,
  availabilitySelectionRequired: false,
  canRestoreAll: false,
  visualFormats: VISUAL_FORMATS.map((format) => ({ ...format, previewUrl: `/brand-sample-${format.id}.jpg` })),
  treatmentPresets: [{ id: "documentary-clean", label: "สารคดีสะอาดตา" }],
  subtitlePresets: [{ id: "preset-1", name: "ซับไวรัลคำต่อคำแบบเน้นคำสำคัญ", config: {} }],
  brandAssets: [{ id: "asset-1", name: "โลโก้แบรนด์หลัก-2026.png" }],
  defaults: seed,
};

function profile(id, name, extra = {}) {
  return {
    id,
    name,
    niche: "การตลาดครีเอเตอร์",
    audience: "",
    tone: "",
    bannedWords: [],
    ctaStyle: "",
    language: "th",
    analysisNotes: null,
    sampleText: null,
    activeRevisionNumber: 4,
    frozen: false,
    legacyVisualFormat: false,
    updatedAt: "",
    draft: null,
    revisions: [],
    ...extra,
  };
}

function previewBatch({ failing = false } = {}) {
  return {
    id: "batch-1",
    requestId: "request-1",
    status: failing ? "partial" : "completed",
    items: ["hook", "explain", "close"].map((phase, index) => ({
      id: `item-${index}`,
      phase,
      status: failing && index === 1 ? "failed" : "completed",
      outputUrl: failing && index === 1 ? null : `/brand-preview-${index}.jpg`,
      sourceType: index === 2 ? "reused" : "generated",
      errorCode: failing && index === 1 ? "IMAGE_PROVIDER_TIMEOUT" : null,
    })),
  };
}

function renderPage({ profiles, creationRequiresResult, preview, allowance }) {
  return renderToStaticMarkup(
    h("div", { className: shell.root },
      h("div", { className: shell.row },
        h("div", { className: shell.column },
          h("main", { className: shell.main },
            h("div", { className: page.scroller, "data-brands-scroller": "true" },
              h("div", { className: page.inner },
                h("header", { className: page.header },
                  h("div", null,
                    h("h1", { className: "text-3xl font-bold tracking-tight text-foreground md:text-[38px]" }, "แบรนด์ของฉัน"),
                    h("p", { className: "mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground" },
                      "ตั้งชื่อแบรนด์ แล้วเลือกแนวภาพที่อยากให้คลิปของคุณเป็น ที่เหลือปรับทีหลังได้"),
                  ),
                  h(Card, { className: "px-4 py-3" },
                    h("p", { className: "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" }, "สิทธิ์ทดลองสร้างภาพ"),
                    h("p", { className: "mt-1 text-[11px] text-muted-foreground" }, "คงเหลือในรอบนี้ · การวิเคราะห์และเลือกแนวภาพไม่ใช้สิทธิ์"),
                  ),
                ),
                h("div", { className: page.grid, "data-brands-grid": "true" },
                  h(BrandList, {
                    profiles,
                    cap: library.cap,
                    canCreate: true,
                    creationRequiresResult,
                    activeId: profiles[0]?.id ?? null,
                    busy: false,
                    onOpen: noop,
                    onArchive: noop,
                    onStartNew: noop,
                    onStartFromCurrentDefaults: noop,
                  }),
                  h("div", { className: page.mainColumn, "data-brands-main": "true" },
                    h(Card, { className: "p-5 md:p-6" },
                      h("div", { className: "space-y-6" },
                        h(BrandBasicsForm, { name: draft.name, onNameChange: noop, disabled: false }),
                        h(VisualFormatPicker, {
                          formats: library.visualFormats,
                          value: draft.visual.primaryVisualFormatId,
                          onChange: noop,
                          disabled: false,
                        }),
                      ),
                    ),
                    h(AdvancedSettings, {
                      open: true,
                      onOpenChange: noop,
                      draft,
                      setDraft: noop,
                      updateVisual: noop,
                      library,
                      busy: null,
                      disabled: false,
                      proposal: null,
                      onAskHelper: noop,
                      onApplyProposal: noop,
                      onUploadBrandMark: noop,
                    }),
                    h(BrandLookPreviewPanel, {
                      preview,
                      previewGenerationCount: 2,
                      allowance,
                      canPublish: true,
                      busy: null,
                      disabled: false,
                      onPreview: noop,
                      onReroll: noop,
                    }),
                    h("div", { className: page.footer },
                      h("p", { className: "max-w-xl text-[11px] leading-5 text-muted-foreground" },
                        "การแก้ร่างหรือทดลองภาพยังไม่เปลี่ยนแนวภาพรุ่นที่โปรเจกต์ใช้อยู่ ภาพเดิมจะไม่ถูกสร้างใหม่อัตโนมัติ"),
                      h("div", { className: "flex flex-wrap gap-2" },
                        h(Button, { type: "button", variant: "outline", className: "h-10" }, "บันทึกร่าง"),
                        h(Button, { type: "button", className: "h-10 bg-violet-600 text-white hover:bg-violet-600/90" },
                          profiles.length ? "ใช้แนวภาพใหม่นี้" : "บันทึกเข้าคลังแบรนด์"),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    // next/image emits a <link rel=preload> alongside the markup; it is head
    // content and would only add dead requests to the harness.
  ).replace(/<link[^>]*>/g, "");
}

const FIXTURES = [
  {
    name: "brand library with saved profiles and a finished preview batch",
    body: renderPage({
      profiles: [
        profile("p1", "Mew Social"),
        profile("p2", "แบรนด์ทดสอบชื่อยาวมากสำหรับหน้าจอมือถือ", { frozen: true, activeRevisionNumber: 2 }),
      ],
      creationRequiresResult: false,
      preview: previewBatch(),
      allowance: { eligible: true, remainingImages: 8, limitImages: 10 },
    }),
  },
  {
    name: "empty library on the first-clip path with a partially failed batch",
    body: renderPage({
      profiles: [],
      creationRequiresResult: true,
      preview: previewBatch({ failing: true }),
      allowance: null,
    }),
  },
];

// ── real stylesheet over the real markup ────────────────────────────────────
const candidates = new Set();
for (const fixture of FIXTURES) {
  for (const match of fixture.body.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token) candidates.add(token.replace(/&amp;/g, "&"));
    }
  }
}
const compiler = await compile(read("src/app/globals.css"), { base: root, onDependency() {} });
const css = compiler.build([...candidates]);
assert.ok(css.includes(".grid-cols-2"), "the compiled stylesheet must contain the utilities under test");

function document_(body) {
  return `<!doctype html><html lang="th" class="dark"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${css}</style></head><body>${body}</body></html>`;
}

// ── measure ─────────────────────────────────────────────────────────────────
function measure() {
  const rect = (element) => element.getBoundingClientRect();
  const scroller = document.querySelector("[data-brands-scroller]");
  const grid = document.querySelector("[data-brands-grid]");
  const brandList = grid.firstElementChild;
  const mainColumn = document.querySelector("[data-brands-main]");
  const previewTiles = [...document.querySelectorAll("figure")];
  const rerollButtons = previewTiles.map((tile) => tile.parentElement.querySelector("button"));
  const samples = [...document.querySelectorAll('[role="radiogroup"] [role="radio"] > div:first-of-type')];

  const overflowing = [];
  for (const element of document.querySelectorAll("body *")) {
    const width = rect(element).width;
    if (width > window.innerWidth + 0.5) {
      overflowing.push(`<${element.tagName.toLowerCase()} class="${(element.getAttribute("class") ?? "").slice(0, 70)}"> ${Math.round(width)}px`);
    }
  }

  const rowTops = new Set(previewTiles.map((tile) => Math.round(rect(tile).top)));
  const firstRowTop = Math.min(...rowTops);
  const previewColumns = previewTiles.filter((tile) => Math.round(rect(tile).top) === firstRowTop).length;

  // The "create a brand" actions: either the two stacked buttons or, on the
  // first-clip path, the single link that replaces them. Both live in the block
  // marked `mb-3` directly under the card, which keeps this off the per-profile rows.
  const actionBlock = [...brandList.children].find((child) => child.classList.contains("mb-3"));
  const libraryButtons = (actionBlock.matches("a, button") ? [actionBlock] : [...actionBlock.querySelectorAll("a, button")]);

  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
    scrollerScrollWidth: scroller.scrollWidth,
    scrollerClientWidth: scroller.clientWidth,
    gridWidth: rect(grid).width,
    brandListWidth: rect(brandList).width,
    brandListMinWidth: getComputedStyle(brandList).minWidth,
    mainColumnMinWidth: getComputedStyle(mainColumn).minWidth,
    mainColumnWidth: rect(mainColumn).width,
    stacked: Math.round(rect(brandList).top) !== Math.round(rect(mainColumn).top),
    overflowing,
    previewColumns,
    previewTileWidth: previewTiles.length ? rect(previewTiles[0]).width : 0,
    reroll: rerollButtons.map((button, index) => ({
      height: rect(button).height,
      width: rect(button).width,
      below: rect(button).top >= rect(previewTiles[index]).bottom - 0.5,
      insideTile: rect(button).top >= rect(previewTiles[index]).top - 0.5
        && rect(button).right <= rect(previewTiles[index]).right + 0.5,
      position: getComputedStyle(button).position,
      wrapsWithin: button.scrollWidth <= button.clientWidth + 1,
    })),
    sampleHeights: samples.map((sample) => rect(sample).height),
    sampleWidths: samples.map((sample) => rect(sample).width),
    libraryButtons: libraryButtons.map((button) => ({
      height: rect(button).height,
      whiteSpace: getComputedStyle(button).whiteSpace,
      fitsWidth: button.scrollWidth <= button.clientWidth + 1,
      /** Only the two stacked actions carry a fixed desktop height. */
      fixedDesktopHeight: button.classList.contains("lg:h-10"),
    })),
  };
}

/** Set BRANDS_MOBILE_SCREENSHOT_DIR to keep a PNG per fixture per viewport —
 * how the desktop "nothing moved" claim on #338 was checked against main. */
const screenshotDir = process.env.BRANDS_MOBILE_SCREENSHOT_DIR ?? null;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
let shotIndex = 0;
async function screenshot(tab, viewport) {
  if (!screenshotDir) return;
  // .ve-rise fades the header in over 500ms; wait it out so two runs are comparable.
  await new Promise((resolve) => setTimeout(resolve, 800));
  shotIndex += 1;
  await tab.screenshot({
    path: path.join(screenshotDir, `${String(shotIndex).padStart(2, "0")}-${viewport.width}x${viewport.height}.png`),
    fullPage: true,
  });
}

const browser = await puppeteer.launch({
  headless: true,
  // GitHub-hosted Linux runners disable the Chromium user-namespace sandbox.
  // The runner is ephemeral and trusted, so launch without it only in CI.
  args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
});

try {
  for (const fixture of FIXTURES) {
    const html = document_(fixture.body);
    const tab = await browser.newPage();

    for (const viewport of PHONE_VIEWPORTS) {
      const where = `${fixture.name} @ ${viewport.width}px`;
      await tab.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await tab.setContent(html, { waitUntil: "load" });
      const found = await tab.evaluate(measure);
      await screenshot(tab, viewport);

      assert.equal(found.documentScrollWidth, found.innerWidth, `${where}: the page must not scroll sideways`);
      assert.ok(
        found.scrollerScrollWidth <= found.scrollerClientWidth + 0.5,
        `${where}: the /brands scroll container must not scroll sideways (${found.scrollerScrollWidth} > ${found.scrollerClientWidth})`,
      );
      assert.deepEqual(found.overflowing, [], `${where}: nothing may be wider than the viewport`);

      assert.equal(found.brandListMinWidth, "0px", `${where}: the brand-library card needs min-width:0`);
      assert.equal(found.mainColumnMinWidth, "0px", `${where}: the main column needs min-width:0`);
      assert.ok(found.stacked, `${where}: the two columns must stack`);
      assert.ok(
        Math.abs(found.brandListWidth - found.gridWidth) < 1 && Math.abs(found.mainColumnWidth - found.gridWidth) < 1,
        `${where}: both stacked columns must fill exactly one grid column`,
      );

      for (const button of found.libraryButtons) {
        assert.notEqual(button.whiteSpace, "nowrap", `${where}: brand-library actions must be allowed to wrap`);
        assert.ok(button.fitsWidth, `${where}: brand-library action labels must fit their button`);
        assert.ok(button.height >= 44, `${where}: brand-library actions must stay a 44px tap target (got ${button.height})`);
      }

      assert.equal(found.previewColumns, 2, `${where}: Brand-look preview must be two columns`);
      for (const button of found.reroll) {
        assert.ok(button.below, `${where}: the reroll button must sit below its tile, not on top of it`);
        assert.ok(button.height >= 44, `${where}: the reroll button must be a 44px tap target (got ${button.height})`);
        assert.ok(button.wrapsWithin, `${where}: the reroll label must fit its button`);
      }

      for (const height of found.sampleHeights) {
        assert.ok(
          height <= found.innerHeight * 0.4 + 0.5,
          `${where}: a Visual Format sample may not exceed 40dvh (got ${Math.round(height)} of ${found.innerHeight})`,
        );
      }
    }

    for (const viewport of DESKTOP_VIEWPORTS) {
      const where = `${fixture.name} @ ${viewport.width}px`;
      await tab.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await tab.setContent(html, { waitUntil: "load" });
      const found = await tab.evaluate(measure);
      await screenshot(tab, viewport);

      assert.equal(found.documentScrollWidth, found.innerWidth, `${where}: the page must not scroll sideways`);
      assert.deepEqual(found.overflowing, [], `${where}: nothing may be wider than the viewport`);
      assert.ok(
        Math.abs(found.brandListWidth - LG_BRAND_LIST_TRACK) < 0.5,
        `${where}: the brand library must keep its ${LG_BRAND_LIST_TRACK}px desktop track (got ${found.brandListWidth})`,
      );
      assert.ok(!found.stacked, `${where}: the two columns must stay side by side`);

      for (const button of found.libraryButtons.filter((candidate) => candidate.fixedDesktopHeight)) {
        assert.ok(
          Math.abs(button.height - 40) < 0.5,
          `${where}: brand-library actions must keep their 40px desktop height (got ${button.height})`,
        );
      }

      assert.equal(found.previewColumns, 3, `${where}: Brand-look preview must stay three columns`);
      for (const button of found.reroll) {
        assert.equal(button.position, "absolute", `${where}: the reroll button must stay overlaid on the tile`);
        assert.ok(button.insideTile, `${where}: the reroll button must stay inside its tile`);
        assert.ok(
          Math.abs(button.height - 32) < 0.5,
          `${where}: the reroll button must keep its 32px desktop height (got ${button.height})`,
        );
      }

      for (const [index, height] of found.sampleHeights.entries()) {
        const ratio = height / found.sampleWidths[index];
        assert.ok(
          Math.abs(ratio - 14 / 9) < 0.02,
          `${where}: Visual Format samples must keep their 9:14 desktop ratio (got ${ratio.toFixed(3)})`,
        );
      }
    }

    await tab.close();
  }
} finally {
  await browser.close();
}

console.log(
  "PASS /brands fits 360–500px phones (no sideways scroll, stacked columns, wrapping 44px actions,"
  + " 2-col preview with the reroll button below each tile, samples capped at 40dvh)"
  + " and keeps its 248px + 3-col desktop layout",
);
