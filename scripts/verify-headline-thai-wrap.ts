// Regression suite for HERO-121: Headline hook Thai word-break protection.
//
// Ensures HeadlineHookView reuses subtitle Thai word-segmentation (Intl.Segmenter)
// and loanword/compound break protection for both headline and sub-line, replaces
// raw `overflowWrap: "anywhere"` with safe word-boundary wrapping (keep-all +
// normal, activating break-word only for extreme single unbreakable tokens wider
// than the container), and renders identically between Web Editor preview and
// Remotion burn.
//
// Run: npm run verify:headline-thai-wrap
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import puppeteer from "puppeteer";

import {
  HEADLINE_HOOK_PRESETS,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
  type HeadlineHookPreset,
} from "../src/lib/headline-hook";
import { setDynamicLoanwords } from "../src/lib/thai-loanwords";
import { setDynamicCompounds } from "../src/lib/thai-compounds";
import { HeadlineHookView } from "../src/remotion/HeadlineHookView";
import {
  hasExtremeUnbreakableToken,
  protectSubtitleWordBreaks,
  segmentThaiDisplayWordBreaks,
} from "../src/remotion/renderSubtitle";

const WORD_JOINER = "\u2060";
const ZERO_WIDTH_SPACE = "\u200B";
const graphemeSegmenter = new Intl.Segmenter("th", { granularity: "grapheme" });

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message);
  console.log(`✓ ${message}`);
}

function stripInvisibleControls(value: string): string {
  return value.replace(/[\u2060\u200B]/gu, "");
}

function joinWithWordJoiner(term: string): string {
  return Array.from(graphemeSegmenter.segment(term), (part) => part.segment).join(WORD_JOINER);
}

function extractParagraphs(markup: string): Array<{ style: string; rawText: string }> {
  const matches = [...markup.matchAll(/<p style="([^"]*)">([\s\S]*?)<\/p>/gu)];
  return matches.map((match) => ({ style: match[1], rawText: match[2] }));
}

function makeHook(
  headline: string,
  opts: Partial<HeadlineHookConfig> = {},
): HeadlineHookConfig {
  const normalized = normalizeHeadlineHook(
    {
      enabled: true,
      headline,
      preset: opts.preset ?? "viral",
      durationMs: opts.durationMs ?? 5_000,
      topPercent: opts.topPercent ?? 20,
      ...opts,
    },
    30_000,
  );
  assert.ok(normalized, `expected valid HeadlineHookConfig for ${JSON.stringify(headline)}`);
  return normalized;
}

// ── 1. Source contract: shared helpers, no raw overflowWrap: "anywhere", preview ≡ burn ──
{
  const viewSource = readFileSync("src/remotion/HeadlineHookView.tsx", "utf8");
  const previewSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/HeadlineHookPreview.tsx",
    "utf8",
  );
  const overlaySource = readFileSync("src/remotion/HeadlineHookOverlay.tsx", "utf8");

  const viewCodeOnly = viewSource
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");
  check(
    !/overflowWrap\s*:\s*["']anywhere["']/u.test(viewCodeOnly),
    'HeadlineHookView.tsx no longer uses raw overflowWrap: "anywhere"',
  );
  check(
    viewSource.includes("segmentThaiDisplayWordBreaks")
      && viewSource.includes("hasExtremeUnbreakableToken")
      && viewSource.includes("./renderSubtitle"),
    "HeadlineHookView.tsx reuses Thai segmentation and break-protection helpers from renderSubtitle.tsx",
  );
  check(
    viewSource.includes('wordBreak: "keep-all"'),
    'HeadlineHookView.tsx applies wordBreak: "keep-all"',
  );
  check(
    previewSource.includes('import { HeadlineHookView, headlineHookMotionAt } from "@/remotion/HeadlineHookView"')
      && previewSource.includes("<HeadlineHookView hook={hook} frameScale={frameScale} motion={motion} />")
      && previewSource.includes('left: "6%"')
      && previewSource.includes('right: "6%"')
      && !previewSource.includes("overflowWrap")
      && !previewSource.includes("wordBreak"),
    "HeadlineHookPreview.tsx delegates directly to HeadlineHookView with identical 6% side margins and no extra wrap overrides",
  );
  check(
    overlaySource.includes("<HeadlineHookView hook={hook} motion={motion} />")
      && overlaySource.includes('left: "6%"')
      && overlaySource.includes('right: "6%"'),
    "HeadlineHookOverlay.tsx delegates to the same HeadlineHookView with identical 6% side margins",
  );
}

// ── 2. Shared Thai helper protects loanwords, compounds, names, bound prefixes & boundaries ──
type ThaiHeadlineFixture = {
  label: string;
  headline: string;
  subheadline: string;
  protectedTerms: string[];
  expectedBreakPairs: Array<[string, string]>;
  preset?: HeadlineHookPreset;
  fontSize?: number;
};

const THAI_HEADLINE_FIXTURES: ThaiHeadlineFixture[] = [
  {
    label: "18-35ch unspaced loanwords (อัลกอริทึม + แพลตฟอร์ม)",
    headline: "ทำไมอัลกอริทึมแพลตฟอร์มไม่ดันคลิป",
    subheadline: "สรุปวิธีปรับคอนเทนต์ให้ครีเอเตอร์โตไว",
    protectedTerms: ["อัลกอริทึม", "แพลตฟอร์ม", "คอนเทนต์", "ครีเอเตอร์"],
    expectedBreakPairs: [
      ["ทำไม", "อัลกอริทึม"],
      ["อัลกอริทึม", "แพลตฟอร์ม"],
      ["แพลตฟอร์ม", "ไม่"],
    ],
    preset: "viral",
  },
  {
    label: "25-35ch unspaced loanwords + bound prefix (แชตบอต + แอดมิน + การขาย + อัตโนมัติ)",
    headline: "ระบบแชตบอตแอดมินช่วยปิดการขายอัตโนมัติ",
    subheadline: "ลดงานตอบคอมเมนต์และเพิ่มคอนเวอร์ชันทันที",
    protectedTerms: ["แชตบอต", "แอดมิน", "การขาย", "อัตโนมัติ", "คอมเมนต์", "คอนเวอร์ชัน"],
    expectedBreakPairs: [
      ["ระบบ", "แชตบอต"],
      ["แชตบอต", "แอดมิน"],
      ["ปิด", "การขาย"],
      ["การขาย", "อัตโนมัติ"],
    ],
    preset: "news",
  },
  {
    label: "24-35ch curated native compounds (ขี้เกียจ + เวลางาน + มืออาชีพ)",
    headline: "วิธีแก้ปัญหาขี้เกียจในเวลางานได้ผล",
    subheadline: "เคล็ดลับทำงานแบบมืออาชีพกับเพื่อนร่วมงาน",
    protectedTerms: ["ขี้เกียจ", "เวลางาน", "มืออาชีพ", "เพื่อนร่วมงาน"],
    expectedBreakPairs: [
      ["ปัญหา", "ขี้เกียจ"],
      ["ใน", "เวลางาน"],
      ["เวลางาน", "ได้"],
    ],
    preset: "banner",
  },
  {
    label: "25-35ch display no-break compounds + proper names (ผลกระทบ + ต่อเนื่อง + มองไม่เห็น + อัลลัน + บรูกส์)",
    headline: "เจาะลึกผลกระทบต่อเนื่องที่มองไม่เห็น",
    subheadline: "บทเรียนสำคัญของ อัลลัน บรูกส์ ที่ครีเอเตอร์ต้องรู้",
    protectedTerms: ["ผลกระทบ", "ต่อเนื่อง", "มองไม่เห็น", "อัลลัน", "บรูกส์", "ครีเอเตอร์"],
    expectedBreakPairs: [
      ["ลึก", "ผลกระทบ"],
      ["ผลกระทบ", "ต่อเนื่อง"],
    ],
    preset: "clean",
  },
  {
    label: "24-34ch marketing loanwords (มาร์เก็ตติ้ง + อีคอมเมิร์ซ + อินฟลูเอนเซอร์)",
    headline: "กลยุทธ์มาร์เก็ตติ้งอีคอมเมิร์ซปีนี้",
    subheadline: "ทำไมอินฟลูเอนเซอร์ยุคใหม่ถึงใช้เทมเพลตนี้",
    protectedTerms: ["มาร์เก็ตติ้ง", "อีคอมเมิร์ซ", "อินฟลูเอนเซอร์", "เทมเพลต"],
    expectedBreakPairs: [
      ["กลยุทธ์", "มาร์เก็ตติ้ง"],
      ["มาร์เก็ตติ้ง", "อีคอมเมิร์ซ"],
    ],
    preset: "stat-burst",
  },
  {
    label: "18-31ch mixed Thai + numbers + punctuation",
    headline: "หยุดเลื่อน! 3 เทคนิคเพิ่มยอดวิว",
    subheadline: "สร้างความสัมพันธ์และทำความสะอาดระบบใน 30 วิ",
    protectedTerms: ["หยุดเลื่อน!", "ความสัมพันธ์", "ทำความสะอาด"],
    expectedBreakPairs: [
      ["เทคนิค", "เพิ่ม"],
    ],
    preset: "question-pill",
  },
];

for (const fixture of THAI_HEADLINE_FIXTURES) {
  const headlineLen = Array.from(fixture.headline).length;
  check(
    headlineLen >= 18 && headlineLen <= 40,
    `${fixture.label}: fixture headline length is realistic (${headlineLen} chars)`,
  );

  // Subtitle helper itself now also guards loanwords and curated compounds
  for (const term of fixture.protectedTerms) {
    const joinedTerm = joinWithWordJoiner(term);
    const inHeadline = fixture.headline.includes(term);
    const source = inHeadline ? fixture.headline : fixture.subheadline;
    const segmented = segmentThaiDisplayWordBreaks(source);
    check(
      segmented.includes(joinedTerm),
      `${fixture.label}: segmentThaiDisplayWordBreaks keeps ${JSON.stringify(term)} intact with U+2060`,
    );
    if (!["การขาย", "ความสัมพันธ์", "ทำความสะอาด", "หยุดเลื่อน!"].includes(term)) {
      check(
        protectSubtitleWordBreaks(source).includes(joinedTerm),
        `${fixture.label}: shared protectSubtitleWordBreaks also keeps ${JSON.stringify(term)} intact`,
      );
    }
  }

  const segmentedHeadline = segmentThaiDisplayWordBreaks(fixture.headline);
  check(
    stripInvisibleControls(segmentedHeadline) === fixture.headline,
    `${fixture.label}: stripping invisible layout controls restores headline verbatim`,
  );
  const segmentedSub = segmentThaiDisplayWordBreaks(fixture.subheadline);
  check(
    stripInvisibleControls(segmentedSub) === fixture.subheadline,
    `${fixture.label}: stripping invisible layout controls restores subheadline verbatim`,
  );

  for (const [left, right] of fixture.expectedBreakPairs) {
    const pairPattern = `${joinWithWordJoiner(left)}${ZERO_WIDTH_SPACE}${joinWithWordJoiner(right)}`;
    check(
      segmentedHeadline.includes(pairPattern),
      `${fixture.label}: inserts safe break opportunity U+200B between ${left}|${right}`,
    );
  }

  // SSR render checks across both headline and sub-line
  const hook = makeHook(fixture.headline, {
    subheadline: fixture.subheadline,
    preset: fixture.preset,
    fontSize: fixture.fontSize,
  });
  const html = renderToStaticMarkup(React.createElement(HeadlineHookView, { hook, frameScale: 1 }));
  const paragraphs = extractParagraphs(html);
  check(paragraphs.length === 2, `${fixture.label}: renders both headline and subheadline <p>`);
  for (const [idx, para] of paragraphs.entries()) {
    const kind = idx === 0 ? "headline" : "subheadline";
    check(
      para.style.includes("word-break:keep-all")
        && para.style.includes("overflow-wrap:normal")
        && !para.style.includes("overflow-wrap:anywhere"),
      `${fixture.label} (${kind}): uses word-break:keep-all + overflow-wrap:normal (never anywhere)`,
    );
  }
  check(
    stripInvisibleControls(paragraphs[0].rawText) === fixture.headline
      && stripInvisibleControls(paragraphs[1].rawText) === fixture.subheadline,
    `${fixture.label}: rendered headline and subheadline preserve every authored character`,
  );
}

// Manual newline preservation in headlines
{
  const manual = "ทำไมอัลกอริทึมไม่ดัน\nวิธีแก้คอนเทนต์ให้ปัง";
  const segmented = segmentThaiDisplayWordBreaks(manual);
  check(
    segmented.split("\n").length === 2 && stripInvisibleControls(segmented) === manual,
    "manual newlines are preserved verbatim while both lines receive Thai break protection",
  );
  check(
    segmented.includes(joinWithWordJoiner("อัลกอริทึม"))
      && segmented.includes(joinWithWordJoiner("คอนเทนต์")),
    "both manual lines keep loanwords protected",
  );
}

// Dynamic loanwords & compounds invalidate cache immediately
{
  const dynamicSample = "ทดลองคำศัพท์สตรีมมิ่งและคำประสมทดสอบใหม่";
  setDynamicLoanwords(["สตรีมมิ่ง"]);
  setDynamicCompounds(["คำประสมทดสอบ"]);
  try {
    const segmented = segmentThaiDisplayWordBreaks(dynamicSample);
    check(
      segmented.includes(joinWithWordJoiner("สตรีมมิ่ง"))
        && segmented.includes(joinWithWordJoiner("คำประสมทดสอบ")),
      "dynamic loanwords and dynamic compounds are protected without stale cache entries",
    );
  } finally {
    setDynamicLoanwords([]);
    setDynamicCompounds([]);
  }
}

// ── 3. Extreme single unbreakable tokens activate overflow-wrap: break-word only when needed ──
const EXTREME_TOKENS = [
  {
    label: "long unbreakable Latin token",
    headline: "Pneumonoultramicroscopicsilicovolcanoconiosis",
    subheadline: "คำอธิบายสั้นปกติสำหรับคลิปนี้",
    expectHeadlineBreakWord: true,
    expectSubBreakWord: false,
  },
  {
    label: "wide uppercase W run",
    headline: "WWWWWWWWWWWWWWWWWWWW",
    subheadline: "สรุปประเด็นสำคัญใน 3 ข้อ",
    expectHeadlineBreakWord: true,
    expectSubBreakWord: false,
  },
  {
    label: "unbreakable URL slug in subheadline",
    headline: "วิธีตั้งค่าแพลตฟอร์มใหม่",
    subheadline: "https://example.com/superlongunbreakableslugwithoutdashes",
    expectHeadlineBreakWord: false,
    expectSubBreakWord: true,
  },
  {
    label: "extreme unbreakable Thai repetition run (ๆ binds backward)",
    headline: `ฮ่า${"ๆ".repeat(36)}`,
    subheadline: "คอนเทนต์สำหรับครีเอเตอร์",
    expectHeadlineBreakWord: true,
    expectSubBreakWord: false,
  },
];

for (const item of EXTREME_TOKENS) {
  for (const preset of HEADLINE_HOOK_PRESETS) {
    const hook = makeHook(item.headline, { subheadline: item.subheadline, preset });
    const html = renderToStaticMarkup(React.createElement(HeadlineHookView, { hook, frameScale: 1 }));
    const paragraphs = extractParagraphs(html);
    assert.equal(paragraphs.length, 2);
    const expectedHeadWrap = item.expectHeadlineBreakWord ? "overflow-wrap:break-word" : "overflow-wrap:normal";
    const expectedSubWrap = item.expectSubBreakWord ? "overflow-wrap:break-word" : "overflow-wrap:normal";
    check(
      paragraphs[0].style.includes(expectedHeadWrap)
        && paragraphs[1].style.includes(expectedSubWrap)
        && !html.includes("overflow-wrap:anywhere"),
      `extreme token (${item.label}, preset=${preset}): headline=${expectedHeadWrap}, subheadline=${expectedSubWrap}`,
    );
  }
}
check(
  !hasExtremeUnbreakableToken("ทำไมอัลกอริทึมแพลตฟอร์มไม่ดันคลิป", 20),
  "multi-word Thai loanword headline is never misclassified as an extreme unbreakable token",
);

// ── 4. Web Editor preview (frameScale 0.3 / 0.25) ≡ Remotion burn (frameScale 1) parity ──
for (const preset of HEADLINE_HOOK_PRESETS) {
  const hook = makeHook("ระบบแชตบอตแอดมินช่วยปิดการขายอัตโนมัติ", {
    subheadline: "วิธีแก้ปัญหาขี้เกียจในเวลางานให้ครีเอเตอร์โตไว",
    preset,
  });
  const burnParas = extractParagraphs(
    renderToStaticMarkup(React.createElement(HeadlineHookView, { hook, frameScale: 1 })),
  );
  for (const previewScale of [0.3, 0.25]) {
    const prevParas = extractParagraphs(
      renderToStaticMarkup(React.createElement(HeadlineHookView, { hook, frameScale: previewScale })),
    );
    assert.equal(prevParas.length, burnParas.length);
    for (let i = 0; i < burnParas.length; i++) {
      check(
        prevParas[i].rawText === burnParas[i].rawText,
        `preset=${preset} scale=${previewScale} p[${i}]: preview emits byte-identical protected text as Remotion burn`,
      );
      const wrapRule = (style: string) => {
        const wb = style.match(/word-break:[^;]+/)?.[0] ?? "";
        const ow = style.match(/overflow-wrap:[^;]+/)?.[0] ?? "";
        const ws = style.match(/white-space:[^;]+/)?.[0] ?? "";
        return `${ws}|${wb}|${ow}`;
      };
      check(
        wrapRule(prevParas[i].style) === wrapRule(burnParas[i].style),
        `preset=${preset} scale=${previewScale} p[${i}]: preview emits identical wrap CSS (${wrapRule(burnParas[i].style)}) as burn`,
      );
    }
  }
}

// ── 5. Real headless Chromium layout verification across presets, Thai wrapping & overflow ──
async function verifyInChromium(): Promise<void> {
  const entryFixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { HeadlineHookView } from "./src/remotion/HeadlineHookView";

    const root = createRoot(document.getElementById("root"));
    window.__renderHeadline = function(hook, frameScale, mode) {
      const frameW = 1080 * frameScale;
      const frameH = 1920 * frameScale;
      const anchorStyle = mode === "overlay"
        ? {
            position: "absolute",
            left: "6%",
            right: "6%",
            top: hook.topPercent + "%",
            transform: "translateY(-50%)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }
        : {
            position: "absolute",
            left: "6%",
            right: "6%",
            top: hook.topPercent + "%",
            transform: "translateY(-50%)",
          };
      return new Promise((resolve) => {
        root.render(
          React.createElement(
            "div",
            {
              id: "frame",
              style: { position: "relative", width: frameW, height: frameH, background: "#090a12", overflow: "hidden" },
            },
            React.createElement(
              "div",
              { id: "anchor", style: anchorStyle },
              React.createElement(HeadlineHookView, { hook, frameScale }),
            ),
          ),
        );
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    };
  `;

  const bundled = await build({
    stdin: {
      contents: entryFixture,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "headline-thai-wrap-browser-fixture.tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.NEXT_PUBLIC_SUBTITLE_FIT_V2": JSON.stringify("1"),
    },
  });

  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.env.CHROME_BIN
    || (process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined);
  const browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 2000, deviceScaleFactor: 1 });
    // Intentionally NO Tailwind global border-box reset, matching Remotion's raw Chromium document.
    await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });

    type MeasuredParagraph = {
      lines: string[];
      overflowsAnchor: boolean;
      scrollWidth: number;
      clientWidth: number;
      anchorWidth: number;
      wordBreak: string;
      overflowWrap: string;
    };

    const measure = async (
      hook: HeadlineHookConfig,
      frameScale: number,
      mode: "overlay" | "preview",
    ): Promise<MeasuredParagraph[]> => {
      return await page.evaluate(
        async ({ hook, frameScale, mode }) => {
          const w = window as unknown as {
            __renderHeadline: (h: HeadlineHookConfig, s: number, m: string) => Promise<void>;
          };
          await w.__renderHeadline(hook, frameScale, mode);
          const anchor = document.getElementById("anchor")!;
          const anchorRect = anchor.getBoundingClientRect();
          const paragraphs = [...anchor.querySelectorAll("p")];

          return paragraphs.map((p) => {
            const textNode = p.firstChild as Text | null;
            const text = textNode?.nodeValue ?? "";
            const range = document.createRange();
            const cs = getComputedStyle(p);
            const fontSize = parseFloat(cs.fontSize) || 24;
            const lineTol = Math.max(3, fontSize * 0.4);
            const lines: string[] = [];
            let currentTop: number | null = null;
            let currentLine = "";

            for (let i = 0; i < text.length; i++) {
              range.setStart(textNode!, i);
              range.setEnd(textNode!, i + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) {
                currentLine += text[i];
                continue;
              }
              if (currentTop === null || Math.abs(rect.top - currentTop) > lineTol) {
                if (currentTop !== null) lines.push(currentLine);
                currentTop = rect.top;
                currentLine = text[i];
              } else {
                currentLine += text[i];
              }
            }
            if (currentLine) lines.push(currentLine);

            const pRect = p.getBoundingClientRect();
            const box = p.closest("div");
            const boxRect = box ? box.getBoundingClientRect() : pRect;
            const overflowsAnchor =
              p.scrollWidth > p.clientWidth + 2
              || pRect.right > anchorRect.right + 2
              || pRect.left < anchorRect.left - 2
              || boxRect.width > anchorRect.width + 2;

            return {
              lines: lines.map((line) => line.replace(/[\u2060\u200B]/gu, "")),
              overflowsAnchor,
              scrollWidth: Math.round(p.scrollWidth),
              clientWidth: Math.round(p.clientWidth),
              anchorWidth: Math.round(anchorRect.width),
              wordBreak: cs.wordBreak,
              overflowWrap: cs.overflowWrap,
            };
          });
        },
        { hook, frameScale, mode },
      );
    };

    // 5a. Thai compound/loanword headlines & sub-lines never split protected words across lines
    // Test at larger fontSize (96 / 108) too so wrapping is guaranteed to exercise multi-line breaks
    // regardless of the host OS Thai fallback font metrics.
    for (const fixture of THAI_HEADLINE_FIXTURES) {
      for (const fontSize of [undefined, 108] as const) {
        const hook = makeHook(fixture.headline, {
          subheadline: fixture.subheadline,
          preset: fixture.preset,
          ...(fontSize ? { fontSize, subheadlineFontSize: 64 } : {}),
        });
        for (const [mode, scale] of [["overlay", 1], ["preview", 0.3]] as const) {
          const measured = await measure(hook, scale, mode);
          assert.equal(measured.length, 2);

          for (const [idx, para] of measured.entries()) {
            const raw = idx === 0 ? fixture.headline : fixture.subheadline;
            const kind = idx === 0 ? "headline" : "subheadline";
            check(
              para.lines.join("") === raw,
              `Chromium ${mode}@${scale} (${fixture.preset}, fs=${fontSize ?? "auto"}, ${kind}): preserves exact authored text`,
            );
            check(
              para.wordBreak === "keep-all" && para.overflowWrap === "normal",
              `Chromium ${mode}@${scale} (${fixture.preset}, fs=${fontSize ?? "auto"}, ${kind}): computed CSS is keep-all + normal`,
            );
            check(
              !para.overflowsAnchor,
              `Chromium ${mode}@${scale} (${fixture.preset}, fs=${fontSize ?? "auto"}, ${kind}): stays inside 88% container (scroll=${para.scrollWidth}px, client=${para.clientWidth}px, anchor=${para.anchorWidth}px, lines=${JSON.stringify(para.lines)})`,
            );
            for (const term of fixture.protectedTerms) {
              if (!raw.includes(term)) continue;
              check(
                para.lines.some((line) => line.includes(term)),
                `Chromium ${mode}@${scale} (${fixture.preset}, fs=${fontSize ?? "auto"}, ${kind}): keeps ${JSON.stringify(term)} intact on one line (lines=${JSON.stringify(para.lines)})`,
              );
            }
          }
        }
      }
    }

    // 5b. Extreme single unbreakable tokens safely wrap inside the 88% frame across ALL 6 presets
    // (including `news` inline-flex and `HeadlineHookOverlay` flex wrapper)
    for (const item of EXTREME_TOKENS) {
      for (const preset of HEADLINE_HOOK_PRESETS) {
        const hook = makeHook(item.headline, { subheadline: item.subheadline, preset });
        for (const [mode, scale] of [["overlay", 1], ["preview", 0.3]] as const) {
          const measured = await measure(hook, scale, mode);
          assert.equal(measured.length, 2);
          for (const [idx, para] of measured.entries()) {
            const kind = idx === 0 ? "headline" : "subheadline";
            check(
              !para.overflowsAnchor,
              `Chromium overflow-safety ${mode}@${scale} (${item.label}, preset=${preset}, ${kind}): no horizontal overflow (${para.scrollWidth}px <= ${para.anchorWidth}px, lines=${para.lines.length})`,
            );
          }
        }
      }
    }

    await page.close();
  } finally {
    await browser.close();
  }
}

verifyInChromium()
  .then(() => {
    console.log("\n✅ HEADLINE THAI WORD-BREAK CHECKS PASSED");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
