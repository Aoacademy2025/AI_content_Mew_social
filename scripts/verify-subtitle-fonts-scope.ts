import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Task B4 (fix round 1): the app shell needs three families everywhere
// (Bai Jamjuree, Kanit, IBM Plex Sans Thai — globals.css + dashboard-group
// headings + sale/auth body text), so those live in one minimal root-layout
// link (AppShellFonts). The other ~15 subtitle-only families (Sarabun,
// Prompt, Mitr, Noto Sans Thai, K2D, Krub, Pridi, Chonburi, Itim, and the
// burn-only decorative set) load only on routes that actually draw them
// (SubtitleFonts). Contract: docs/plans/reports/2026-09-12-A3-code-audit.md
// §A3.4. Render output (src/remotion/**) is excluded — it loads its own font
// URLs and must stay untouched.

function read(path: string): string {
  assert.ok(existsSync(path), `expected file to exist: ${path}`);
  return readFileSync(path, "utf8");
}

const SUBTITLE_ONLY_FAMILIES = [
  "Mitr",
  "Sarabun",
  "Prompt",
  "Noto\\+Sans\\+Thai",
  "Chakra\\+Petch",
  "Chonburi",
  "Fahkwang",
  "K2D",
  "Charm",
  "Krub",
  "Pridi",
  "Itim",
  "Sriracha",
  "Bangers",
  "Bebas\\+Neue",
  "Oswald",
  "Anton",
  "Righteous",
  "Playfair\\+Display",
  "Pacifico",
  "Lobster",
];
const APP_SHELL_FAMILIES = ["Bai\\+Jamjuree", "Kanit", "IBM\\+Plex\\+Sans\\+Thai"];

// ── 1. Root layout carries AppShellFonts, not the 24-family sheet ─────────
const rootLayout = read("src/app/layout.tsx");
assert.match(
  rootLayout,
  /<AppShellFonts\s*\/?>/,
  "src/app/layout.tsx must render <AppShellFonts /> for the app-shell families",
);
assert.doesNotMatch(
  rootLayout,
  /<SubtitleFonts\s*\/?>/,
  "src/app/layout.tsx must not render the full subtitle sheet — only AppShellFonts",
);
assert.match(rootLayout, /Inter/, "src/app/layout.tsx must still self-host Inter via next/font");

// ── 2. subtitle-fonts.tsx exports both, each with the right family set ────
const subtitleFontsPath = "src/components/subtitle-fonts.tsx";
const subtitleFontsSource = read(subtitleFontsPath);

assert.match(subtitleFontsSource, /export function SubtitleFonts/, "SubtitleFonts must still be exported");
assert.match(subtitleFontsSource, /export function AppShellFonts/, "AppShellFonts must be exported");

// Split the module so a family-name check against one component's URL
// doesn't accidentally match the other's. The split point is the second
// URL constant's declaration (not the function), since the constant is
// declared above its component function.
const appShellUrlStart = subtitleFontsSource.indexOf("const APP_SHELL_FONTS_URL");
assert.ok(appShellUrlStart > 0, "expected an APP_SHELL_FONTS_URL constant in subtitle-fonts.tsx");
const subtitleFontsUrlAndBody = subtitleFontsSource.slice(0, appShellUrlStart);
const appShellFontsBody = subtitleFontsSource.slice(appShellUrlStart);

for (const family of SUBTITLE_ONLY_FAMILIES) {
  assert.match(
    subtitleFontsUrlAndBody,
    new RegExp(`family=${family}`),
    `SubtitleFonts' GOOGLE_FONTS_URL must keep the byte-identical family list (missing ${family})`,
  );
}
for (const family of APP_SHELL_FAMILIES) {
  assert.match(
    subtitleFontsUrlAndBody,
    new RegExp(`family=${family}`),
    `GOOGLE_FONTS_URL is a byte-identical historical constant and must still include ${family} too`,
  );
}
assert.match(
  subtitleFontsUrlAndBody,
  /rel="preconnect"[\s\S]*fonts\.googleapis\.com/,
  "SubtitleFonts must render the fonts.googleapis.com preconnect",
);
assert.match(
  subtitleFontsUrlAndBody,
  /rel="preconnect"[\s\S]*fonts\.gstatic\.com/,
  "SubtitleFonts must render the fonts.gstatic.com preconnect",
);

// AppShellFonts: exactly the 3 app-shell families, none of the subtitle-only ones
for (const family of APP_SHELL_FAMILIES) {
  assert.match(appShellFontsBody, new RegExp(`family=${family}`), `AppShellFonts must include ${family}`);
}
for (const family of SUBTITLE_ONLY_FAMILIES) {
  assert.doesNotMatch(
    appShellFontsBody,
    new RegExp(`family=${family}(?![a-zA-Z])`),
    `AppShellFonts must not pull in the subtitle-only family ${family} — that belongs in SubtitleFonts only`,
  );
}
assert.match(appShellFontsBody, /rel="preconnect"[\s\S]*fonts\.googleapis\.com/, "AppShellFonts must render the fonts.googleapis.com preconnect");
assert.match(appShellFontsBody, /rel="preconnect"[\s\S]*fonts\.gstatic\.com/, "AppShellFonts must render the fonts.gstatic.com preconnect");

// ── 3. Every A3 §A3.4 file that renders a SUBTITLE-ONLY family sits under
//       route coverage (Bai Jamjuree/Kanit/IBM Plex Sans Thai consumers are
//       covered globally by the root's AppShellFonts and need no per-route
//       layout) ────────────────────────────────────────────────────────────
const SUBTITLE_ONLY_CONSUMER_COVERAGE: Array<[string, string]> = [
  ["src/app/(dashboard)/video-editor/page.tsx", "src/app/(dashboard)/video-editor/layout.tsx"],
  ["src/app/(dashboard)/video-editor/_v2/subtitle-style.ts", "src/app/(dashboard)/video-editor/layout.tsx"],
  ["src/app/(dashboard)/video-creator/page.tsx", "src/app/(dashboard)/video-creator/layout.tsx"],
  ["src/app/(dashboard)/ai-studio/story-film/page.tsx", "src/app/(dashboard)/ai-studio/story-film/layout.tsx"],
  ["src/app/(dashboard)/ai-studio/story-film/StoryFilmWorkbench.tsx", "src/app/(dashboard)/ai-studio/story-film/layout.tsx"],
  ["src/lib/style-pack-catalog.ts", "src/app/(dashboard)/brands/layout.tsx"],
  ["src/app/(dashboard)/brands/_components/StylePackPicker.tsx", "src/app/(dashboard)/brands/layout.tsx"],
];

const coversSubtitleFontsOrOwnLink = (source: string): boolean =>
  /<SubtitleFonts\s*\/?>/.test(source) || /fonts\.googleapis\.com\/css2/.test(source);

for (const [consumer, coverage] of SUBTITLE_ONLY_CONSUMER_COVERAGE) {
  read(consumer); // consumer file must still exist (A3.4 evidence didn't move)
  const coverageSource = read(coverage);
  assert.ok(
    coversSubtitleFontsOrOwnLink(coverageSource),
    `${coverage} must render <SubtitleFonts /> (or its own Google Fonts link) to cover ${consumer}`,
  );
}

// dashboard/page.tsx and first-clip-hero.tsx only use Kanit/Bai Jamjuree
// (app-shell families) — no per-route layout should exist for them anymore.
assert.ok(
  !existsSync("src/app/(dashboard)/dashboard/layout.tsx"),
  "dashboard/layout.tsx should not exist — /dashboard only needs the app-shell families the root layout now provides",
);

// ── 4. Render output is untouched and still self-loads its fonts ──────────
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
  "verify-subtitle-fonts-scope: PASS root layout carries only the 3 app-shell families, SubtitleFonts covers every subtitle-only-family consumer route, src/remotion/** untouched",
);
