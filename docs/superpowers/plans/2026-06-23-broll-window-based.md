# Window-Based B-roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make b-roll change on a ~3–4s window cadence where each window's clip relates to the content spoken in that window, via one shared windowing rule used by every mode (free video / AI gen / auto-mix) and every user.

**Architecture:** A new pure `buildBrollWindows(captions, cadence)` groups per-caption captions into ~3–4s windows. The editor builds windows, sends window TEXTS to the existing extract-keywords perSubtitle path (1 keyword/window — no route change), fetches one asset per window (source picked by the existing mix plan), and sends the window time-ranges to generate-config which places one clip per window. Subtitles stay per-caption and are extracted into a pure `buildKeywordPopups` guarded by a byte-for-byte invariant test. Everything is gated by a client flag so the legacy per-caption + min-hold path remains the default until QA passes.

**Tech Stack:** Next.js 15 App Router (route handlers + client editor), TypeScript, Gemini (keywords), Pexels/Pixabay + kie.ai (assets), Remotion render. Tests = `verify-*.ts` via `tsx`.

## Global Constraints

- `main` = production. Branch `mew/broll-window-based`; PR into `main`; Mew rebases + merges + deploys. (CLAUDE.md)
- **Subtitle invariant (critical):** `keywordPopups` output (text/timing/frames) MUST be byte-for-byte identical with the flag on vs off, for both Gemini and ElevenLabs. Windows feed ONLY `bgVideos`. Do NOT touch `tts-timing.ts`, caption generation, or subtitle timing.
- Flag-gated: client flag `NEXT_PUBLIC_BROLL_WINDOW_MODE` ("1" = on). Default OFF → legacy path unchanged. Server routes react to request fields (`brollWindows`, `brollWindowMode`), not their own env.
- Cadence: `BROLL_WINDOW_SEC` (client const/env, default 4) — the ONLY place cadence is defined (`buildBrollWindows`).
- Render-backend changes build-verify before merge: `npx tsc --noEmit` per task + one `npm run build` before PR.
- Verify scripts import via relative path (`../src/lib/...`), assert with `process.exit(1)` on failure.
- Reuse existing pieces: `planAutoMixSources`, `aiGenPieceCount`, `buildKieImagePrompt`, `detectStyle`/`normalizeKeywordPopups`. DRY, YAGNI, TDD.

---

## File Structure

- Create `src/lib/broll-windows.ts` — pure windowing (`buildBrollWindows`, types). One responsibility: group captions → windows.
- Create `src/lib/keyword-popups.ts` — pure `buildKeywordPopups` extracted from generate-config (+ its local helpers `detectStyle`, `autoScaleSize`, `normalizeKeywordPopups`). One responsibility: captions → subtitle popups. Enables the invariant test.
- Modify `src/app/api/videos/generate-config/route.ts` — import `buildKeywordPopups`; add a window-placement branch for `bgVideos` (gated on `brollWindows` request field).
- Modify `src/app/api/videos/fetch-stock/route.ts` — when `brollWindowMode`, set the auto-mix/kie piece count to `keywords.length` (windows already cadence-sized; skip the cadence re-cap).
- Modify `src/app/(dashboard)/video-editor/page.tsx` — build windows from captions; route extract-keywords/fetch-stock/generate-config through them when the flag is on.
- Create `scripts/verify-broll-windows.ts`, `scripts/verify-subtitle-invariant.ts`; add npm scripts.

---

### Task 1: `buildBrollWindows` pure windowing

**Files:**
- Create: `src/lib/broll-windows.ts`
- Create: `scripts/verify-broll-windows.ts`
- Modify: `package.json` (add verify script)

**Interfaces:**
- Produces: `type BrollWindowCaption = { startMs: number; endMs: number; text: string }`
- Produces: `type BrollWindow = { startMs: number; endMs: number; captionStartIdx: number; captionEndIdx: number; text: string }`
- Produces: `buildBrollWindows(captions: BrollWindowCaption[], cadenceSec: number): BrollWindow[]`

- [ ] **Step 1: Write the failing test** — create `scripts/verify-broll-windows.ts`:

```ts
// Unit tests for buildBrollWindows (run: npx tsx scripts/verify-broll-windows.ts)
// Groups per-caption captions into ~cadence-second windows that tile the timeline with
// no gaps/overlaps. This is the single source of b-roll count + placement.
import { buildBrollWindows, type BrollWindowCaption } from "../src/lib/broll-windows";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
// N back-to-back captions of `each` seconds
const caps = (n: number, each: number): BrollWindowCaption[] =>
  Array.from({ length: n }, (_, i) => ({ startMs: i * each * 1000, endMs: (i + 1) * each * 1000, text: `c${i}` }));

// 12 × 1.5s captions (=18s), cadence 4 → ~4-5 windows, each spanning ~3 captions
const w = buildBrollWindows(caps(12, 1.5), 4);
check("count ≈ ceil(dur/cadence)", w.length >= 4 && w.length <= 5, `${w.length}`);
check("first window starts at 0", w[0].startMs === 0);
check("last window ends at audio end (18000ms)", w[w.length - 1].endMs === 18000);
check("tiles with no gaps", w.every((win, i) => i === 0 || win.startMs === w[i - 1].endMs));
check("each window span >= cadence except possibly last",
  w.slice(0, -1).every((win) => win.endMs - win.startMs >= 4000));
check("window text concatenates its captions", w[0].text.split(" ").length === (w[0].captionEndIdx - w[0].captionStartIdx + 1));
check("caption indices are contiguous & cover all", w[0].captionStartIdx === 0 && w[w.length - 1].captionEndIdx === 11);

// single caption longer than cadence → its own window
const long = buildBrollWindows([{ startMs: 0, endMs: 6000, text: "x" }], 4);
check("single long caption → 1 window", long.length === 1 && long[0].endMs === 6000);

// empty / invalid input
check("empty → []", buildBrollWindows([], 4).length === 0);
check("invalid caption filtered", buildBrollWindows([{ startMs: 5, endMs: 5, text: "bad" }], 4).length === 0);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-windows checks passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-broll-windows.ts`
Expected: FAIL — `Cannot find module '../src/lib/broll-windows'`.

- [ ] **Step 3: Write minimal implementation** — create `src/lib/broll-windows.ts`:

```ts
export type BrollWindowCaption = { startMs: number; endMs: number; text: string };
export type BrollWindow = {
  startMs: number;
  endMs: number;
  captionStartIdx: number;
  captionEndIdx: number;
  text: string;
};

/**
 * Group consecutive captions into ~cadenceSec windows — the single unit b-roll uses.
 * Each window grows by including captions until its span reaches the cadence (cut on a
 * caption boundary); a caption longer than the cadence is its own window. Windows tile
 * [0, audioEnd] with no gaps/overlaps. Count ≈ ceil(audioDuration / cadenceSec).
 */
export function buildBrollWindows(captions: BrollWindowCaption[], cadenceSec: number): BrollWindow[] {
  const caps = (captions ?? []).filter(
    (c) => c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs,
  );
  if (caps.length === 0) return [];
  const cadenceMs = Math.max(500, (cadenceSec > 0 ? cadenceSec : 4) * 1000);

  const windows: BrollWindow[] = [];
  let i = 0;
  while (i < caps.length) {
    const start = caps[i].startMs;
    let j = i;
    // grow until this window's span reaches the cadence, or we run out of captions
    while (j < caps.length - 1 && caps[j].endMs - start < cadenceMs) j++;
    windows.push({
      startMs: start,
      endMs: caps[j].endMs,
      captionStartIdx: i,
      captionEndIdx: j,
      text: caps.slice(i, j + 1).map((c) => c.text.trim()).filter(Boolean).join(" "),
    });
    i = j + 1;
  }
  return windows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-broll-windows.ts`
Expected: PASS — "All broll-windows checks passed."

- [ ] **Step 5: Add npm script + commit** — in `package.json` scripts, after `"verify:automix-plan"`:

```json
    "verify:broll-windows": "tsx scripts/verify-broll-windows.ts",
```

```bash
git add src/lib/broll-windows.ts scripts/verify-broll-windows.ts package.json
git commit -m "feat(broll): buildBrollWindows — group captions into cadence windows"
```

---

### Task 2: Extract `buildKeywordPopups` + subtitle invariant

**Files:**
- Create: `src/lib/keyword-popups.ts`
- Modify: `src/app/api/videos/generate-config/route.ts` (lines 154–171 `normalizeKeywordPopups`, 174–196 `autoScaleSize`/`detectStyle`, 297–317 inline popup build)
- Create: `scripts/verify-subtitle-invariant.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildKeywordPopups(popupCaptions: Cap[], opts: KeywordPopupOpts): KeywordPopupItem[]`
  where `KeywordPopupOpts = { fps: number; durationInFrames: number; subtitleSize: number; primaryColor: string; accentColor: string; subtitleStylePreset?: SubtitleStylePreset; subtitlePosition: number; subtitleFontWeight: number }`
  and `Cap = { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" }`.

- [ ] **Step 1: Write the failing test** — create `scripts/verify-subtitle-invariant.ts`:

```ts
// Locks the SUBTITLE INVARIANT: windowing must never change keywordPopups (the subtitles).
// buildKeywordPopups is the pure extraction of generate-config's inline popup builder.
// run: npx tsx scripts/verify-subtitle-invariant.ts
import { buildKeywordPopups } from "../src/lib/keyword-popups";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const caps = [
  { text: "เช้านี้เริ่มด้วยกาแฟ", startMs: 0, endMs: 1500, tag: "hook" as const },
  { text: "กลิ่นหอมกรุ่น", startMs: 1500, endMs: 3000, tag: "body" as const },
  { text: "ลุยงานต่อ", startMs: 3000, endMs: 4500, tag: "body" as const },
];
const opts = { fps: 30, durationInFrames: 135, subtitleSize: 80, primaryColor: "#FFFFFF", accentColor: "#FFE500", subtitleStylePreset: undefined, subtitlePosition: 82, subtitleFontWeight: 900 };

const a = buildKeywordPopups(caps, opts);
check("one popup per caption", a.length === 3, `${a.length}`);
check("text preserved", a[0].text === "เช้านี้เริ่มด้วยกาแฟ");
check("frames from caption timing (hook 0→45)", a[0].start === 0 && a[0].end === 45, `${a[0].start},${a[0].end}`);
check("hook uses accent color", a[0].color === "#FFE500");
check("body uses primary color", a[1].color === "#FFFFFF");
check("position passed through", a[0].topPercent === 82);

// DETERMINISM: identical input → identical output (the invariant the window flag must keep)
const b = buildKeywordPopups(caps, opts);
check("deterministic / byte-identical", JSON.stringify(a) === JSON.stringify(b));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll subtitle-invariant checks passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-subtitle-invariant.ts`
Expected: FAIL — `Cannot find module '../src/lib/keyword-popups'`.

- [ ] **Step 3: Create the pure module** — create `src/lib/keyword-popups.ts` by moving `autoScaleSize`, `detectStyle`, `normalizeKeywordPopups` (verbatim from generate-config route lines 154–196) and adding `buildKeywordPopups`:

```ts
import type { KeywordPopupItem, SubtitleStylePreset } from "@/remotion/types";

export type Cap = { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" };
export type KeywordPopupOpts = {
  fps: number;
  durationInFrames: number;
  subtitleSize: number;
  primaryColor: string;
  accentColor: string;
  subtitleStylePreset?: SubtitleStylePreset;
  subtitlePosition: number;
  subtitleFontWeight: number;
};

function autoScaleSize(text: string, baseSize: number): number {
  const usableWidth = 950;
  const charWidthRatio = 0.85;
  const maxCharsOneLine = Math.floor(usableWidth / (baseSize * charWidthRatio));
  const len = text.length;
  if (len <= maxCharsOneLine) return baseSize;
  const scale = Math.max(0.6, maxCharsOneLine / len);
  return Math.round(baseSize * scale);
}

function detectStyle(text: string, baseSize: number, primaryColor: string): { color: string; size: number; isHighlight: boolean } {
  const scaled = autoScaleSize(text, baseSize);
  return { color: primaryColor, size: scaled, isHighlight: false };
}

function normalizeKeywordPopups(popups: KeywordPopupItem[], durationInFrames: number): KeywordPopupItem[] {
  const totalFrames = Math.max(1, Math.round(Number(durationInFrames) || 1));
  const out: KeywordPopupItem[] = [];
  let cursor = 0;
  for (const popup of popups) {
    if (cursor >= totalFrames) break;
    let start = Number.isFinite(Number(popup.start)) ? Math.round(Number(popup.start)) : cursor;
    let end = Number.isFinite(Number(popup.end)) ? Math.round(Number(popup.end)) : start + 1;
    start = Math.min(Math.max(0, start, cursor), totalFrames - 1);
    end = Math.min(Math.max(end, start + 1), totalFrames);
    if (end <= start) continue;
    out.push({ ...popup, start, end });
    cursor = end;
  }
  return out;
}

/** Pure subtitle-popup builder — extracted verbatim from generate-config so the window
 *  flag can be proven NOT to alter subtitles (verify-subtitle-invariant.ts). */
export function buildKeywordPopups(popupCaptions: Cap[], opts: KeywordPopupOpts): KeywordPopupItem[] {
  const { fps, durationInFrames, subtitleSize, primaryColor, accentColor, subtitleStylePreset, subtitlePosition, subtitleFontWeight } = opts;
  return normalizeKeywordPopups(
    popupCaptions.map((c) => {
      const text = c.text.trim();
      const { color, size } = detectStyle(text, subtitleSize, primaryColor);
      const isHighlight = c.tag === "hook";
      const singleColor = subtitleStylePreset === "karaoke-box";
      const startFrame = Math.floor((c.startMs / 1000) * fps);
      const endFrame = Math.max(startFrame + 1, Math.ceil((c.endMs / 1000) * fps));
      return {
        text,
        start: startFrame,
        end: endFrame,
        color: singleColor ? color : isHighlight ? accentColor : color,
        size,
        isHighlight,
        topPercent: subtitlePosition,
        fontWeight: subtitleFontWeight,
        tag: c.tag,
        stylePreset: subtitleStylePreset,
      };
    }),
    durationInFrames,
  );
}
```

- [ ] **Step 4: Rewire generate-config to use it** — in `generate-config/route.ts`: delete the moved `autoScaleSize`/`detectStyle`/`normalizeKeywordPopups` definitions (lines 154–196), add `import { buildKeywordPopups } from "@/lib/keyword-popups";`, and replace the inline build (lines 297–317) with:

```ts
  const keywordPopups: KeywordPopupItem[] = buildKeywordPopups(popupCaptions, {
    fps,
    durationInFrames,
    subtitleSize,
    primaryColor,
    accentColor,
    subtitleStylePreset,
    subtitlePosition,
    subtitleFontWeight,
  });
```

(If `detectStyle` is referenced elsewhere in the route, keep a thin re-export — grep `detectStyle` first; as of this writing it is only used in the popup build.)

- [ ] **Step 5: Run test + type-check**

Run: `npx tsx scripts/verify-subtitle-invariant.ts` → Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors.

- [ ] **Step 6: Add npm script + commit** — add `"verify:subtitle-invariant": "tsx scripts/verify-subtitle-invariant.ts",` to package.json:

```bash
git add src/lib/keyword-popups.ts scripts/verify-subtitle-invariant.ts src/app/api/videos/generate-config/route.ts package.json
git commit -m "refactor(config): extract pure buildKeywordPopups + subtitle invariant test"
```

---

### Task 3: generate-config window placement

**Files:**
- Modify: `src/app/api/videos/generate-config/route.ts` (body parse ~204–246; bgVideos build ~347–429)

**Interfaces:**
- Consumes: request field `brollWindows?: { startMs: number; endMs: number }[]` (1 per stock clip, in window order).
- When present, place `stockVideos[i]` over `brollWindows[i]` and SKIP the per-subtitle/min-hold branch.

- [ ] **Step 1: Add `brollWindows` to the body** — in the destructure (after `minHoldSec: minHoldSecParam,`) add `brollWindows = [] as { startMs: number; endMs: number }[],` and in the type block add `brollWindows?: { startMs: number; endMs: number }[];`.

- [ ] **Step 2: Add the window-placement branch** — at the top of the `if (validStocks.length > 0) {` block (route ~347, before `const n = validStocks.length;`), insert:

```ts
    // WINDOW MODE: the editor pre-grouped captions into ~3–4s windows and fetched ONE
    // asset per window (in window order). Place each clip over its window span — no
    // per-caption assignment, no min-hold. Subtitles (keywordPopups) are unaffected.
    if (Array.isArray(brollWindows) && brollWindows.length > 0) {
      const pool = validStocks;
      const count = Math.min(brollWindows.length, pool.length);
      for (let wi = 0; wi < count; wi++) {
        const win = brollWindows[wi];
        const sv = pool[wi];
        const src = sv.localUrl ?? sv.videoUrl;
        if (!src) continue;
        const start = Math.max(0, Math.min(win.startMs / 1000, audioDurationSec));
        const end = Math.min(Math.max(win.endMs / 1000, start + 1 / fps), audioDurationSec);
        if (end - start < 1 / fps) continue;
        bgVideos.push({ src, start, end, clipOffset: 0, clipDuration: sv.duration > 0 ? sv.duration : 10 });
      }
      console.log(`[config] window-mode: ${bgVideos.length} clips over ${brollWindows.length} windows`);
    } else {
      const n = validStocks.length;
      // ... existing even-split / per-subtitle-top / scene-aware logic unchanged ...
    }
```

(Wrap the existing `const n = validStocks.length; …` body in the `else`. The `bgVideos` array, `brollMetadataBySrc`, normalize/fillGaps steps after the block stay shared.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/videos/generate-config/route.ts
git commit -m "feat(config): place one b-roll per window when brollWindows provided"
```

---

### Task 4: fetch-stock window-mode piece count

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts` (body parse ~1170–1199; auto-mix plan ~1333–1360; kie count ~1459)

**Interfaces:**
- Consumes: request flag `brollWindowMode?: boolean`. When true, `keywords.length` already equals the window count, so the piece count = `keywords.length` (skip the cadence re-cap).

- [ ] **Step 1: Add `brollWindowMode` to the body** — in the destructure add `brollWindowMode = false,` and in the type block `brollWindowMode?: boolean;`.

- [ ] **Step 2: Use it in the auto-mix plan** — replace the `pieceCount` line in the Auto Mix plan block:

```ts
    const pieceCount = brollWindowMode
      ? keywords.length
      : aiGenPieceCount(totalDurationSec, Math.min(keywords.length, downloadClipLimit), isPerSubtitleMode, downloadClipLimit);
```

- [ ] **Step 3: Use it in the kie-image dedicated path** — replace the `clipsToGenerate` assignment (~1459):

```ts
    const clipsToGenerate = brollWindowMode
      ? Math.min(keywords.length, PER_SUBTITLE_DOWNLOAD_LIMIT)
      : aiGenPieceCount(totalDurationSec, Math.min(keywords.length, downloadClipLimit), isPerSubtitleMode, PER_SUBTITLE_DOWNLOAD_LIMIT);
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors.

```bash
git add src/app/api/videos/fetch-stock/route.ts
git commit -m "feat(broll): fetch-stock honors window count when brollWindowMode"
```

---

### Task 5: Editor wiring (flag-gated)

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (import; runKeywords ~1397; runFetchStock ~1427–1456; runConfig ~1848–1885)

**Interfaces:**
- Consumes: `buildBrollWindows` (Task 1), `BROLL_WINDOW_SEC`, `process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE`.
- Produces: window-driven requests to extract-keywords (scenes = window texts), fetch-stock (`brollWindowMode`, overrideClipCount = windows), generate-config (`brollWindows`).

- [ ] **Step 1: Import + flag/const** — add near the other `@/lib` imports:

```ts
import { buildBrollWindows, type BrollWindow } from "@/lib/broll-windows";
const BROLL_WINDOW_MODE = process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE === "1";
const BROLL_WINDOW_SEC = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
```

- [ ] **Step 2: Build windows after captions, store on pipe** — in `runFetchStock` (after `const caps = pipe.current.sceneCaptions ?? [];`, ~1434) add:

```ts
    const brollWindows: BrollWindow[] = BROLL_WINDOW_MODE && caps.length > 0
      ? buildBrollWindows(caps.map(c => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), BROLL_WINDOW_SEC)
      : [];
    pipe.current.brollWindows = brollWindows;
```

(Add `brollWindows?: BrollWindow[]` to the `pipe.current` type.)

- [ ] **Step 3: When window mode, fetch one asset per window** — in the `runFetchStock` body, when `brollWindows.length > 0`, the `kws` passed in must already be the WINDOW keywords. Wire that in `runKeywords`: when `BROLL_WINDOW_MODE`, build windows first and send window texts as `scenes` with `perSubtitle: true`:

```ts
      // window mode: keywords are extracted per WINDOW (1 each), not per caption
      const caps0 = pipe.current.sceneCaptions ?? [];
      const wins = BROLL_WINDOW_MODE && caps0.length > 0
        ? buildBrollWindows(caps0.map(c => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), BROLL_WINDOW_SEC)
        : [];
      const phraseScenes = wins.length > 0 ? wins.map(w => w.text) : sc;
```

and use `phraseScenes` as the `scenes` in the extract-keywords body. Store `pipe.current.brollWindows = wins`.

- [ ] **Step 4: fetch-stock request — window count + flag** — in the fetch-stock body (~1438), when `pipe.current.brollWindows?.length`, set `overrideClipCount` to the window count and add `brollWindowMode: true`; drop the per-caption `subtitleTexts` (window texts are already the keywords):

```ts
        ...(pipe.current.brollWindows?.length
          ? { overrideClipCount: pipe.current.brollWindows.length, perSubtitleMode: true, brollWindowMode: true }
          : (/* existing targetClipCount / perSubtitle / captionClipLimit ternary */)),
```

- [ ] **Step 5: generate-config request — send window spans** — in `runConfig`'s body (~1882), add when window mode:

```ts
        ...(pipe.current.brollWindows?.length
          ? { brollWindows: pipe.current.brollWindows.map(w => ({ startMs: w.startMs, endMs: w.endMs })) }
          : {}),
```

and in window mode SKIP the per-caption `svForConfig` cycling (the editor already has one clip per window): pass `stockVideos = sv` (the fetched per-window clips) and `sceneClipCounts = []`.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json` → Expected: no errors (flag OFF path unchanged).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(editor): window-mode b-roll pipeline behind NEXT_PUBLIC_BROLL_WINDOW_MODE flag"
```

---

### Task 6: Integration verify + QA gate

**Files:** none (verification only).

- [ ] **Step 1: All verify scripts green**

Run each: `npx tsx scripts/verify-broll-windows.ts`, `verify-subtitle-invariant.ts`, `verify-broll-cadence.ts`, `verify-automix-plan.ts`, `verify-broll-min-hold.ts`.
Expected: all PASS.

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit -p tsconfig.json` then `npm run build`.
Expected: clean / completes.

- [ ] **Step 3: Open PR; QA before enabling flag** — PR `mew/broll-window-based` → `main`. The flag stays OFF in prod env on merge. Before setting `NEXT_PUBLIC_BROLL_WINDOW_MODE=1`, QA on prod (deploy with flag off, then a build with flag on for testing OR a preview):
  - For EACH of free-video / kie-image / auto-mix × EACH of Gemini / ElevenLabs: render one clip and confirm (a) **subtitles still land on the audio** (the invariant — eyeball + compare), (b) b-roll changes ~3–4s, (c) each b-roll relates to its window's spoken content, (d) `[config] window-mode: N clips over N windows` with N == fetched == shown (no over-fetch), (e) `[fetch-stock] downloaded N` == window count.
  - Subtitle check is the gate: if subs drift at all vs flag-off, STOP — do not enable.
- [ ] **Step 4: Enable flag** only after all six QA combos pass: set `NEXT_PUBLIC_BROLL_WINDOW_MODE=1` (+ optional `NEXT_PUBLIC_BROLL_WINDOW_SEC`), rebuild/deploy. Rollback = unset the flag + rebuild.

---

## Self-Review

- **Spec coverage:** windowing (T1) ✓; subtitle invariant + extraction (T2) ✓; window placement in config (T3) ✓; window count in fetch-stock + source mix reuse (T4 + existing `planAutoMixSources`) ✓; editor wiring + flag + cadence (T5) ✓; rollout flag + QA across modes×providers (T6) ✓; extract-keywords window mode = reuse existing perSubtitle via window texts as `scenes` (no route change — covered in T5 Step 3) ✓; #104 absorbed (real duration not needed for count — windows decide count) ✓.
- **Placeholder scan:** the only deferred text is "existing … ternary/logic unchanged" in T3/T5 where the surrounding code is explicitly preserved — these reference real existing code, not unwritten code. Pure functions + tests have complete code.
- **Type consistency:** `BrollWindow`/`BrollWindowCaption` (T1) used in T5; `buildKeywordPopups(popupCaptions, opts)` (T2) signature matches its call in T3 Step rewire; `brollWindows: {startMs,endMs}[]` consistent across T3 (consume) and T5 (produce); `brollWindowMode` boolean consistent T4 (consume) / T5 (produce).
- **Safety ordering:** subtitle invariant (T2) lands before any b-roll change (T3+); flag default OFF keeps legacy path until QA.
