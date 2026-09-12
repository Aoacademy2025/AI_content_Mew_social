import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Task B4: the 24-family subtitle/style-pack Google Fonts stylesheet must load
// only on routes that actually draw one of those families — everything else
// keeps Inter (self-hosted) or, for Bai Jamjuree/IBM Plex Sans Thai-only
// routes, a minimal single-purpose link. Contract: docs/plans/reports/
// 2026-09-12-A3-code-audit.md §A3.4. Render output (src/remotion/**) is
// excluded — it loads its own font URLs and must stay untouched.

function read(path: string): string {
  assert.ok(existsSync(path), `expected file to exist: ${path}`);
  return readFileSync(path, "utf8");
}

// ── 1. Root layout no longer ships the 24-family sheet ─────────────────────
const rootLayout = read("src/app/layout.tsx");
assert.doesNotMatch(
  rootLayout,
  /fonts\.googleapis\.com/,
  "src/app/layout.tsx must not reference fonts.googleapis.com — the subtitle font sheet moved to SubtitleFonts",
);
assert.match(
  rootLayout,
  /Inter/,
  "src/app/layout.tsx must still self-host Inter via next/font",
);

// ── 2. SubtitleFonts exists and carries the byte-identical 24-family URL ───
const subtitleFontsPath = "src/components/subtitle-fonts.tsx";
const subtitleFontsSource = read(subtitleFontsPath);
assert.match(
  subtitleFontsSource,
  /https:\/\/fonts\.googleapis\.com\/css2\?family=Mitr/,
  "SubtitleFonts must carry the moved GOOGLE_FONTS_URL constant",
);
for (const family of [
  "Bangers",
  "Lobster",
  "Pacifico",
  "Playfair+Display",
  "Righteous",
]) {
  assert.match(
    subtitleFontsSource,
    new RegExp(`family=${family.replace(/\+/g, "\\+")}`),
    `SubtitleFonts must keep the moved constant byte-identical (missing ${family})`,
  );
}
assert.match(
  subtitleFontsSource,
  /rel="preconnect"[\s\S]*fonts\.googleapis\.com/,
  "SubtitleFonts must render the fonts.googleapis.com preconnect",
);
assert.match(
  subtitleFontsSource,
  /rel="preconnect"[\s\S]*fonts\.gstatic\.com/,
  "SubtitleFonts must render the fonts.gstatic.com preconnect",
);

// ── 3. Every A3 §A3.4-proven family consumer sits under route coverage ─────
// [consumer file (renders text in a non-self-hosted family), covering
//  layout/page file that must render <SubtitleFonts /> or its own link]
const CONSUMER_COVERAGE: Array<[string, string]> = [
  ["src/app/(dashboard)/video-editor/page.tsx", "src/app/(dashboard)/video-editor/layout.tsx"],
  ["src/app/(dashboard)/video-editor/_v2/subtitle-style.ts", "src/app/(dashboard)/video-editor/layout.tsx"],
  ["src/app/(dashboard)/video-creator/page.tsx", "src/app/(dashboard)/video-creator/layout.tsx"],
  ["src/app/(dashboard)/ai-studio/story-film/page.tsx", "src/app/(dashboard)/ai-studio/story-film/layout.tsx"],
  ["src/app/(dashboard)/ai-studio/story-film/StoryFilmWorkbench.tsx", "src/app/(dashboard)/ai-studio/story-film/layout.tsx"],
  ["src/lib/style-pack-catalog.ts", "src/app/(dashboard)/brands/layout.tsx"],
  ["src/app/(dashboard)/brands/_components/StylePackPicker.tsx", "src/app/(dashboard)/brands/layout.tsx"],
  ["src/components/dashboard/first-clip-hero.tsx", "src/app/(dashboard)/dashboard/layout.tsx"],
  ["src/app/(dashboard)/dashboard/page.tsx", "src/app/(dashboard)/dashboard/layout.tsx"],
];

const coversSubtitleFontsOrOwnLink = (source: string): boolean =>
  /<SubtitleFonts\s*\/?>/.test(source) || /fonts\.googleapis\.com\/css2/.test(source);

for (const [consumer, coverage] of CONSUMER_COVERAGE) {
  read(consumer); // consumer file must still exist (A3.4 evidence didn't move)
  const coverageSource = read(coverage);
  assert.ok(
    coversSubtitleFontsOrOwnLink(coverageSource),
    `${coverage} must render <SubtitleFonts /> (or its own Google Fonts link) to cover ${consumer}`,
  );
}

// ── 4. Bai Jamjuree/IBM Plex Sans Thai-only routes keep a minimal link ─────
const MINIMAL_LINK_FILES = ["src/app/page.tsx", "src/components/marketing/auth-shell.tsx"];
for (const file of MINIMAL_LINK_FILES) {
  const source = read(file);
  assert.match(
    source,
    /fonts\.googleapis\.com\/css2\?family=Bai\+Jamjuree/,
    `${file} must keep its own minimal Bai Jamjuree link`,
  );
  assert.doesNotMatch(
    source,
    /family=Mitr/,
    `${file} must not pull in the full 24-family sheet — it only needs Bai Jamjuree (+IBM Plex Sans Thai)`,
  );
}

// ── 5. Render output is untouched and still self-loads its fonts ──────────
const REMOTION_SELF_LOADING_FILES = [
  "src/remotion/captionStyles.ts",
  "src/remotion/SubtitleOverlayComposition.tsx",
  "src/remotion/VideoComposition.tsx",
  "src/remotion/ShortVideoComposition.tsx",
];
for (const file of REMOTION_SELF_LOADING_FILES) {
  const source = read(file);
  assert.match(source, /fonts\.googleapis\.com/, `${file} must keep loading its own fonts`);
}
// Only "keep in sync" comments may reference app/layout.tsx under src/remotion/** — never an import.
for (const file of REMOTION_SELF_LOADING_FILES) {
  const source = read(file);
  const importLines = source
    .split("\n")
    .filter((line) => /app\/layout/.test(line) && !/^\s*\/\//.test(line.trim()));
  assert.deepEqual(importLines, [], `${file} must not import from src/app/layout.tsx`);
}

console.log(
  "verify-subtitle-fonts-scope: PASS root layout scoped, SubtitleFonts covers every A3 §A3.4 consumer route, minimal links kept, src/remotion/** untouched",
);
