/** Responsive regression coverage for the approved Brands redesign.
 * Render real components with the real stylesheet; keep preview/advanced
 * checks without freezing the old 248px sidebar or tall-card layout. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";
import puppeteer from "puppeteer";
import { BrandStyleWorkspace } from "../src/app/(dashboard)/brands/_components/BrandStyleWorkspace.tsx";
import { BrandLibraryOverview } from "../src/app/(dashboard)/brands/_components/BrandLibraryOverview.tsx";
import { AdvancedSettings } from "../src/app/(dashboard)/brands/_components/AdvancedSettings.tsx";
import { BrandLookPreviewPanel } from "../src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed.ts";
import { VISUAL_FORMATS } from "../src/lib/brand-visual-system.ts";
import { activeStylePacks } from "../src/lib/style-pack-catalog.ts";
const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const h = React.createElement;
const noop = () => {};
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
  imageAccess: { canUse: true, reason: "eligible", upgradeUrl: "/pricing" },
  availabilitySelectionRequired: false,
  visualFormats: VISUAL_FORMATS.map((format) => ({ ...format, previewUrl: `/brand-sample-${format.id}.jpg` })),
  treatmentPresets: [{ id: "documentary-clean", label: "สารคดีสะอาดตา" }],
  subtitlePresets: [{ id: "preset-1", name: "ซับไวรัลคำต่อคำแบบเน้นคำสำคัญ", config: {} }],
  brandAssets: [{ id: "asset-1", name: "โลโก้แบรนด์หลัก-2026.png" }],
  defaults: seed,
  // Asset decoding is covered separately; this checks geometry even on failure.
  stylePacks: activeStylePacks().map((pack) => ({
    id: pack.id,
    thaiLabel: pack.thaiLabel,
    tagline: pack.tagline,
    palette: pack.palette,
    sampleImage: `/style-packs/${pack.id}.jpg`,
  })),
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


draft.visual.stylePackId = "life-drama";
const source = read("src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx");
const inner = source.match(/<div className="(mx-auto max-w-\[1200px\][^"]*)"/)[1];
const bodies = [
  h(BrandStyleWorkspace, { draft, library, disabled: false, onSelect: noop, onCustomize: noop }),
  h(BrandLibraryOverview, { library: { ...library, profiles: [profile("p1", "Mew Social"), profile("p2", "แบรนด์ทดสอบชื่อยาวมากสำหรับหน้าจอมือถือ", { frozen: true })] }, busy: false, onNew: noop, onOpen: noop, onUse: noop, onArchive: noop }),
  h(AdvancedSettings, { open: true, onOpenChange: noop, draft, setDraft: noop, updateVisual: noop, library, busy: null, disabled: false, proposal: null, onAskHelper: noop, onApplyProposal: noop, onUploadBrandMark: noop }),
  ...[false, true].map(failing => h("section", { "data-preview": true }, h(BrandLookPreviewPanel, { preview: previewBatch({ failing }), previewGenerationCount: 2, allowance: null, imageAccess: failing ? { canUse: false, reason: "payment_required", upgradeUrl: "/pricing" } : library.imageAccess, canPublish: true, busy: null, disabled: false, onPreview: noop, onReroll: noop }))),
].map(body => renderToStaticMarkup(h("main", { className: inner }, body)).replace(/<link[^>]*>/g, ""));
const candidates = new Set(bodies.flatMap(body => [...body.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].replaceAll("&amp;", "&").split(/\s+/))));
// Embed shipped samples so screenshots inspect actual assets without networking.
for (let i = 0; i < bodies.length; i++) bodies[i] = bodies[i].replace(/src="(\/style-packs\/[^"?]+\.jpg)"/g, (_, url) => `src="data:image/jpeg;base64,${fs.readFileSync(path.join(root, "public", url)).toString("base64")}"`);
const css = (await compile(read("src/app/globals.css"), { base: root, onDependency() {} })).build([...candidates]);
const browser = await puppeteer.launch({ headless: true, args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [] });
try {
  const tab = await browser.newPage();
  for (const [fixture, body] of bodies.entries()) for (const width of [320, 360, 390, 500, 768, 1024, 1280]) {
    await tab.setViewport({ width, height: 844 });
    await tab.setContent(`<!doctype html><html lang="th" class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${body}</body></html>`);
    if (process.env.BRANDS_MOBILE_SCREENSHOT_DIR && fixture === 0 && [390, 1280].includes(width)) {
      fs.mkdirSync(process.env.BRANDS_MOBILE_SCREENSHOT_DIR, { recursive: true });
      await tab.screenshot({ path: path.join(process.env.BRANDS_MOBILE_SCREENSHOT_DIR, `chooser-${width}.png`), fullPage: true });
    }
    const found = await tab.evaluate(() => {
      const rect = e => e.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        radios: [...document.querySelectorAll('input[type="radio"]')].map(e => ({ height: rect(e.closest('label')).height, checked: e.checked })),
        preview: [...document.querySelectorAll('[data-preview] figure')].map(e => ({ top: rect(e).top, bottom: rect(e).bottom, button: (() => { const b = e.parentElement.querySelector('button'); return b ? { height: rect(b).height, top: rect(b).top, fits: b.scrollWidth <= b.clientWidth + 1 } : null; })() })),
        workspace: (() => { const aside = document.querySelector('aside'); const fieldset = document.querySelector('fieldset'); return aside && fieldset ? { asideTop: rect(aside).top, optionsTop: rect(fieldset).top, asideLeft: rect(aside).left, optionsLeft: rect(fieldset).left } : null; })(),
      };
    });
    const where = `fixture ${fixture} at ${width}px`;
    assert.equal(found.overflow, false, `${where}: no horizontal overflow`);
    if (fixture === 0) {
      assert.equal(found.radios.length, 3, `${where}: three starting choices`);
      assert.equal(found.radios.filter(r => r.checked).length, 1, `${where}: one selected default`);
      assert.ok(found.radios.every(r => r.height >= 44), `${where}: touch targets`);
      if (width < 1024) assert.ok(found.workspace.asideTop < found.workspace.optionsTop, `${where}: selected summary first on mobile`);
      else assert.ok(found.workspace.asideLeft > found.workspace.optionsLeft, `${where}: adjacent desktop summary`);
    }
    if (found.preview.length) {
      const first = Math.min(...found.preview.map(t => t.top));
      assert.equal(found.preview.filter(t => t.top === first).length, width < 640 ? 2 : 3, `${where}: preview columns`);
      for (const tile of found.preview.filter(t => t.button)) if (width < 640) {
        assert.ok(tile.button.top >= tile.bottom - 1, `${where}: reroll below image`);
        assert.ok(tile.button.height >= 44 && tile.button.fits, `${where}: reroll readable and touchable`);
      }
    }
  }
} finally { await browser.close(); }
console.log("PASS Brands chooser, library, advanced controls and completed/partial previews fit 320–1280px; selected summary order and touch targets verified");
