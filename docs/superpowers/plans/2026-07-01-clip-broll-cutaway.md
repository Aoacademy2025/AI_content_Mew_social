# Upload Clip + Auto B-roll Cutaway (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload their own vertical talking clip and get auto Thai subtitles + auto **stock B-roll cutaways** (full-frame b-roll that swaps in for parts while their voice keeps playing), one-click, 9:16.

**Architecture:** Reuse ~90% of the existing direct-upload pipeline (transcribe → keyword → fetch-stock → `buildBrollWindows` → b-roll base render → subtitle burn). The **only new runtime piece** is a composite mode `"cutaway"` that = the existing `"direct"`/full overlay **plus** an ffmpeg `enable='between(t,…)'` so the (already content-matched) b-roll base peeks through during non-person windows. Audio is taken from the uploaded clip (`-map 1:a?`), so it stays continuous with no audio surgery. A new pure planner decides which windows are person vs b-roll.

**Tech Stack:** Next.js 15 / React 19 / TypeScript · ffmpeg (via `runFfmpeg` in the composite route) · team test pattern = standalone `scripts/verify-*.ts` run with `npx tsx` (no jest).

## Global Constraints

- **Gate:** PRO / BUSINESS only (composite route already 403s FREE at `route.ts:449`).
- **Feature flag:** `NEXT_PUBLIC_CLIP_CUTAWAY=1` gates the new UI button (off = button hidden, no behavior change).
- **B-roll source:** STOCK only (Pexels/Pixabay) — no AI-gen b-roll in this mode (Phase 2). Reuses existing fetch-stock; nothing to add.
- **Input:** vertical clips only — reject landscape/square at upload; portrait non-9:16 is padded to 9:16 by the existing render scale.
- **Metering:** UNCHANGED — reuses `render/route.ts` minute meter (`reservedMinutes = minutesFromSeconds(videoDuration) = round(sec/60)`, min 1). 2-min clip = 2 minutes. No credit spend (stock-only).
- **Fail-open:** transcribe/stock failure → fall back to full-frame clip + subtitles (never crash the job).
- **Deploy:** Mew merges `mew/clip-broll-cutaway` + deploys herself when the render queue is free.

---

## File Structure

- `src/lib/cutaway-plan.ts` — **NEW.** Pure logic: `planCutaway(windows)` (person vs b-roll windows) + `buildEnableExpr(rangesSec)` (ffmpeg enable string). Zero deps, fully testable.
- `scripts/verify-cutaway-plan.ts` — **NEW.** Assertions for the above (team test pattern).
- `src/app/api/heygen/composite/route.ts` — **MODIFY.** Add `cutawayComposite()` + `mode:"cutaway"` dispatch + `personRanges` body param.
- `src/app/(dashboard)/video-editor/page.tsx` — **MODIFY.** Widen `directCompositeMode` type; add cutaway branch in `runComposite` that computes `personRanges` from `pipe.current.brollWindows`.
- `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` — **MODIFY.** Relabel section + tabs; add 3rd format button (flag-gated); add cutaway helper copy.
- `src/lib/video-orientation.ts` — **NEW.** `isPortraitVideoFile(file)` helper.
- `src/app/(dashboard)/video-editor/_components/DirectAvatarUpload.tsx` — **MODIFY.** Reject non-portrait uploads.

Unchanged (reused): `render/route.ts` (metering), transcribe/keyword/fetch-stock routes, `src/lib/broll-windows.ts`.

---

### Task 1: Cutaway planner (pure logic + tests)

**Files:**
- Create: `src/lib/cutaway-plan.ts`
- Test: `scripts/verify-cutaway-plan.ts`

**Interfaces:**
- Consumes: nothing (pure). Input windows shaped like `BrollWindow` (`{ startMs, endMs }` — from `src/lib/broll-windows.ts`).
- Produces:
  - `planCutaway(windows: { startMs: number; endMs: number }[]): { person: CutawayRange[]; broll: CutawayRange[] }` where `CutawayRange = { startMs: number; endMs: number }`
  - `buildEnableExpr(rangesSec: { start: number; end: number }[]): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-cutaway-plan.ts`:

```ts
import { planCutaway, buildEnableExpr } from "../src/lib/cutaway-plan";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗", msg); failed++; } else { console.log("✓", msg); }
}

// windows tiling [0, n*4s] at 4s each (mirrors buildBrollWindows output shape)
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000 }));

// 1) hook (window 0) is always person
assert(planCutaway(mk(6)).person.some(r => r.startMs === 0), "window 0 (hook) is person");

// 2) alternation => b-roll only on odd windows (=> never two consecutive)
assert(
  JSON.stringify(planCutaway(mk(6)).broll.map(r => r.startMs)) === JSON.stringify([4000, 12000, 20000]),
  "b-roll on odd windows only (no consecutive)",
);

// 3) person + broll cover all windows, disjoint
{
  const { person, broll } = planCutaway(mk(5));
  assert(person.length + broll.length === 5, "person+broll count == window count");
  const starts = [...person, ...broll].map(r => r.startMs).sort((a, b) => a - b);
  assert(JSON.stringify(starts) === JSON.stringify([0, 4000, 8000, 12000, 16000]), "union covers all windows, disjoint");
}

// 4) < 2 windows => all person, no cutaway
{
  const { person, broll } = planCutaway(mk(1));
  assert(person.length === 1 && broll.length === 0, "1 window => all person, no b-roll");
  assert(planCutaway([]).person.length === 0 && planCutaway([]).broll.length === 0, "0 windows => empty plan");
}

// 5) b-roll ratio ~40-50% for typical lengths
{
  const ratio = planCutaway(mk(10)).broll.length / 10;
  assert(ratio >= 0.4 && ratio <= 0.5, `b-roll ratio ${ratio} within 0.4-0.5`);
}

// 6) enable expr formatting
assert(
  buildEnableExpr([{ start: 0, end: 3.5 }, { start: 8, end: 12 }]) === "between(t,0.000,3.500)+between(t,8.000,12.000)",
  "enable expr joins ranges with +",
);
assert(buildEnableExpr([]) === "", "empty ranges => empty expr");

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/verify-cutaway-plan.ts`
Expected: FAIL — `Cannot find module '../src/lib/cutaway-plan'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/cutaway-plan.ts`:

```ts
// Phase 1 planner for "upload clip + auto B-roll cutaway".
// Decides which b-roll windows show the uploaded clip (person) vs the b-roll base.
// Windows tile [0, clipEnd] with no gaps (see buildBrollWindows), so person ∪ broll
// covers the whole clip.

export type CutawayRange = { startMs: number; endMs: number };
export type CutawayPlan = { person: CutawayRange[]; broll: CutawayRange[] };

/**
 * window 0 (hook) = person; then every odd-index window is b-roll. Guarantees:
 * hook is always the person, no two consecutive b-roll windows, ~50% b-roll.
 * Fewer than 2 valid windows => all person (skip cutaway entirely).
 */
export function planCutaway(windows: { startMs: number; endMs: number }[]): CutawayPlan {
  const person: CutawayRange[] = [];
  const broll: CutawayRange[] = [];
  const ws = (windows ?? []).filter(
    (w) => w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs,
  );
  if (ws.length < 2) {
    for (const w of ws) person.push({ startMs: w.startMs, endMs: w.endMs });
    return { person, broll };
  }
  ws.forEach((w, i) => {
    (i % 2 === 1 ? broll : person).push({ startMs: w.startMs, endMs: w.endMs });
  });
  return { person, broll };
}

/**
 * ffmpeg overlay `enable=` expression, true during the given ranges (seconds).
 * '+' is logical OR in ffmpeg expressions. Empty => "" (caller draws always).
 */
export function buildEnableExpr(rangesSec: { start: number; end: number }[]): string {
  return (rangesSec ?? [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
    .join("+");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/verify-cutaway-plan.ts`
Expected: PASS — all `✓`, ends with `ALL PASSED`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cutaway-plan.ts scripts/verify-cutaway-plan.ts
git commit -m "feat(cutaway): pure planner + enable-expr for clip b-roll cutaway"
```

---

### Task 2: Composite route — `cutaway` mode

**Files:**
- Modify: `src/app/api/heygen/composite/route.ts` (import ~top; new fn after `directComposite` at :80; body destructure at :452-464; dispatch at :523)

**Interfaces:**
- Consumes: `buildEnableExpr` from Task 1.
- Produces: composite route accepts `mode:"cutaway"` + body `personRanges: { start:number; end:number }[]` (seconds). Output = clip overlaid on b-roll base, revealed during non-person windows, audio from clip.

- [ ] **Step 1: Import the planner helper**

At the top of `src/app/api/heygen/composite/route.ts` (with the other imports), add:

```ts
import { buildEnableExpr } from "@/lib/cutaway-plan";
```

- [ ] **Step 2: Add `cutawayComposite` after `directComposite`**

Immediately after `directComposite` ends (`route.ts:80`, the line `console.log("[direct-composite] done"); }`), insert:

```ts
// ─────────────────────────────────────────────
// Mode: cutaway — uploaded clip is the base video; the content-matched b-roll (bg)
// peeks through during NON-person windows. Overlay the clip only during person ranges
// (enable=between). Audio always from the clip (input 1). No green screen needed.
// ─────────────────────────────────────────────
async function cutawayComposite(
  bgPath: string,
  avatarPath: string,
  outPath: string,
  personRangesSec: { start: number; end: number }[],
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const enableExpr = buildEnableExpr(personRangesSec);
  const overlay = enableExpr
    ? `[bg][fg]overlay=0:0:format=auto:enable='${enableExpr}'[out]`
    : `[bg][fg]overlay=0:0:format=auto[out]`; // no ranges => behave like full (fail-open)
  const filter = [
    `[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg]`,
    `[1:v]scale=1080:1920:flags=lanczos,setsar=1[fg]`,
    overlay,
  ].join(";");
  console.log("[cutaway-composite] filter:", filter);
  await runFfmpeg(ffmpeg, [
    "-y", "-i", bgPath, "-i", avatarPath,
    "-filter_complex", filter,
    "-map", "[out]", "-map", "1:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ]);
  console.log("[cutaway-composite] done");
}
```

- [ ] **Step 3: Accept `personRanges` in the POST body**

In the body destructure at `route.ts:452-464`, add `personRanges = []` (e.g. right after `avatarLayout = null,`):

```ts
    avatarLayout = null,
    personRanges = [],
```

- [ ] **Step 4: Dispatch cutaway**

At the mode dispatch (`route.ts:523`), add a `cutaway` branch right after the `direct` branch:

```ts
    if (mode === "direct") {
      await directComposite(bgTmp, avatarTmp, outPath);
    } else if (mode === "cutaway") {
      await cutawayComposite(bgTmp, avatarTmp, outPath, personRanges);
    } else if (mode === "rembg") {
```

- [ ] **Step 5: Build-verify (ffmpeg can't be unit-tested here; verify it compiles)**

Run: `node_modules/.bin/esbuild "src/app/api/heygen/composite/route.ts" --bundle=false --outfile=/dev/null`
Expected: no errors (`⚡ Done`). Then `npx tsc --noEmit -p tsconfig.json` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/heygen/composite/route.ts
git commit -m "feat(cutaway): composite mode=cutaway (time-gated clip overlay on b-roll base)"
```

---

### Task 3: Wire `runComposite` (page.tsx)

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (import ~top; type at :395; `runComposite` direct body at :2496-2518)

**Interfaces:**
- Consumes: `planCutaway` (Task 1); composite `mode:"cutaway"` + `personRanges` (Task 2); `pipe.current.brollWindows` (`BrollWindow[]`).
- Produces: `directCompositeMode` union now includes `"cutaway"`; when set, `runComposite` sends the cutaway body with `personRanges` (seconds) derived from the b-roll windows.

- [ ] **Step 1: Import the planner**

With the other `@/lib` imports near the top of `page.tsx` (e.g. next to the `buildBrollWindows` import at :49), add:

```ts
import { planCutaway } from "@/lib/cutaway-plan";
```

- [ ] **Step 2: Widen the `directCompositeMode` state type**

At `page.tsx:395`, change:

```ts
  const [directCompositeMode, setDirectCompositeMode] = useState<"chromakey" | "full">("chromakey");
```
to:
```ts
  const [directCompositeMode, setDirectCompositeMode] = useState<"chromakey" | "full" | "cutaway">("chromakey");
```

- [ ] **Step 3: Add the cutaway branch to the direct composite body**

In `runComposite` (`page.tsx:2493-2536`), the `isDirect` body currently branches `directCompositeMode === "full" ? {...} : {...chromakey...}`. Replace that `isDirect ? JSON.stringify(directCompositeMode === "full" ? {…full…} : {…chromakey…})` ternary with a three-way. Concretely, the `body:` for the direct case becomes:

```ts
      body: isDirect
        ? JSON.stringify(
            directCompositeMode === "cutaway"
              ? {
                  avatarVideoUrl: avatarUrl,
                  bgVideoUrl,
                  // Clip is the base; b-roll base shows through during non-person windows.
                  mode: "cutaway",
                  audioFromAvatar: true,
                  personRanges: planCutaway(pipe.current.brollWindows ?? []).person.map((r) => ({
                    start: r.startMs / 1000,
                    end: r.endMs / 1000,
                  })),
                }
              : directCompositeMode === "full"
                ? {
                    avatarVideoUrl: avatarUrl,
                    bgVideoUrl,
                    mode: "direct",
                    audioFromAvatar: true,
                  }
                : {
                    avatarVideoUrl: avatarUrl,
                    bgVideoUrl,
                    mode: "chromakey",
                    noScale: true,
                    chromaColor: "0x00ff00",
                    chromaSimilarity,
                    chromaBlend,
                    audioFromAvatar: false,
                  },
          )
        : JSON.stringify({
```

(Leave the non-direct `JSON.stringify({ … generate … })` object that follows exactly as-is.)

- [ ] **Step 4: Build-verify**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors (in particular no "directCompositeMode not assignable" errors).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(cutaway): send mode=cutaway + personRanges from runComposite"
```

---

### Task 4: OrderPanel UI — relabel + new button + vertical-only guard

**Files:**
- Create: `src/lib/video-orientation.ts`
- Modify: `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` (section label :738, tab labels :746, format buttons :883, helper copy :890)
- Modify: `src/app/(dashboard)/video-editor/_components/DirectAvatarUpload.tsx` (reject non-portrait)

**Interfaces:**
- Consumes: `directCompositeMode` union incl. `"cutaway"` (Task 3). `p.setDirectCompositeMode` already typed via page.tsx.
- Produces: user-visible cutaway option (flag-gated) + portrait-only enforcement.

- [ ] **Step 1: Relabel the section header**

`OrderPanel.tsx:738` — change `}>Avatar (HeyGen)</SectionLabel>` to:

```tsx
            }>พิธีกรในคลิป (AI / คลิปฉัน)</SectionLabel>
```

- [ ] **Step 2: Relabel the two tabs**

`OrderPanel.tsx:746` — change:

```tsx
                      {mode === "generate" ? "Generate" : "Direct URL"}
```
to:
```tsx
                      {mode === "generate" ? "Avatar AI" : "อัปคลิปฉันเอง"}
```

- [ ] **Step 3: Add the flag-gated 3rd format button**

`OrderPanel.tsx:883` currently maps an inline array of two `[mode,label]` pairs. Replace that inline `([["chromakey","Green Screen (ตัดเขียว)"],["full","วิดีโอเต็มจอ (ใส่ซับ)"]] as const).map((...) => (` opening with a typed variable built just above the `<div className="flex gap-1.5">` that wraps the buttons:

```tsx
                    {(() => {
                      const directModes: [("chromakey" | "full" | "cutaway"), string][] = [
                        ["chromakey", "Green Screen (ตัดเขียว)"],
                        ["full", "วิดีโอเต็มจอ (ใส่ซับ)"],
                        ...(process.env.NEXT_PUBLIC_CLIP_CUTAWAY === "1"
                          ? ([["cutaway", "เต็มจอ + B-roll"]] as [("chromakey" | "full" | "cutaway"), string][])
                          : []),
                      ];
                      return directModes.map(([m, label]) => (
                        <button key={m} onClick={() => p.setDirectCompositeMode(m)}
                          className={`flex-1 py-1.5 rounded-lg border text-[10px] font-bold transition-all ${p.directCompositeMode === m ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500"}`}>
                          {label}
                        </button>
                      ));
                    })()}
```

(This replaces the existing `([[...]] as const).map(([m, label]) => ( <button …>{label}</button> ))` block, keeping the same `<button>` markup — only the source array + wrapper changes.)

- [ ] **Step 4: Add cutaway helper copy**

`OrderPanel.tsx:890` currently: `{p.directCompositeMode === "full" ? "วิดีโอเต็มจอ — …" : "วิดีโอ green screen — …"}`. Make it three-way:

```tsx
                    <div className="text-[10px] text-slate-500 bg-violet-500/5 border border-violet-500/15 rounded-lg px-2.5 py-2 leading-relaxed">{p.directCompositeMode === "cutaway" ? "อัปคลิปพูดเอง → ระบบใส่ซับ + แทรก B-roll ให้อัตโนมัติเป็นช่วงๆ ตรงกับที่พูด" : p.directCompositeMode === "full" ? "วิดีโอเต็มจอ — ใช้พื้นหลังในคลิป + ใส่ซับ อัตโนมัติหลัง Render" : "วิดีโอ green screen — ตัดเขียววางบน b-roll อัตโนมัติหลัง Render"}</div>
```

- [ ] **Step 5: Create the portrait-check helper**

Create `src/lib/video-orientation.ts`:

```ts
/** Resolve a video File's intrinsic dimensions in the browser (no upload). */
export function readVideoDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("อ่านไฟล์วิดีโอไม่ได้"));
    };
    v.src = url;
  });
}

/** true when the clip is portrait (taller than wide). Phase 1 accepts portrait only. */
export async function isPortraitVideoFile(file: File): Promise<boolean> {
  try {
    const { width, height } = await readVideoDimensions(file);
    return height > 0 && width > 0 && height > width;
  } catch {
    return true; // fail-open: if we can't read metadata, don't block the upload
  }
}
```

- [ ] **Step 6: Enforce portrait in `DirectAvatarUpload`**

Open `src/app/(dashboard)/video-editor/_components/DirectAvatarUpload.tsx`. Add the import:

```ts
import { isPortraitVideoFile } from "@/lib/video-orientation";
```

Find the file-select handler (the `onChange` of the `<input type="file">` that reads `e.target.files?.[0]`). Immediately after obtaining the `File` and **before** starting the upload, insert:

```ts
      if (!(await isPortraitVideoFile(file))) {
        onPlanError?.("รองรับเฉพาะคลิปแนวตั้ง (9:16) — คลิปแนวนอน/จัตุรัสยังไม่รองรับในโหมดนี้");
        return;
      }
```

(If the handler isn't already `async`, make it `async`.)

- [ ] **Step 7: Build-verify**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors.
Run: `node_modules/.bin/esbuild "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx" --bundle=false --outfile=/dev/null` → no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/video-orientation.ts "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx" "src/app/(dashboard)/video-editor/_components/DirectAvatarUpload.tsx"
git commit -m "feat(cutaway): UI relabel + flag-gated 'เต็มจอ + B-roll' mode + portrait-only guard"
```

---

### Task 5: Integration verify + manual QA

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + build sanity**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 2: Re-run the unit test**

Run: `npx tsx scripts/verify-cutaway-plan.ts`
Expected: `ALL PASSED`.

- [ ] **Step 3: Manual QA (dev server, flag ON)**

Start dev with the flag: `NEXT_PUBLIC_CLIP_CUTAWAY=1 npm run dev`. As a PRO/BUSINESS user in `/video-editor`:

Verify each:
- [ ] Section header reads **"พิธีกรในคลิป (AI / คลิปฉัน)"**; tabs read **"Avatar AI" / "อัปคลิปฉันเอง"**.
- [ ] Under "อัปคลิปฉันเอง" a 3rd button **"เต็มจอ + B-roll"** appears (and is HIDDEN when the flag is unset).
- [ ] Uploading a **landscape** clip is rejected with the Thai message; a **portrait** clip is accepted.
- [ ] Pick "เต็มจอ + B-roll", paste a script (optional), Render → the preview shows the person's clip with **b-roll cutting in full-frame for parts** while the **voice plays continuously**; subtitles track the audio.
- [ ] The **first window shows the person** (hook), and b-roll never stays on for two windows in a row.
- [ ] Burn & Download produces a correct 9:16 file.
- [ ] After render, the minute meter decremented by ≈ clip length in minutes (2-min clip → 2), with **no credit spend**.

- [ ] **Step 4: Spec-parity check**

Re-read `docs/superpowers/specs/2026-07-01-upload-clip-broll-cutaway-design.md` §2 non-goals and confirm none leaked in (no AI b-roll, no product upload, no PiP/stacked, no landscape, no manual control).

- [ ] **Step 5: Commit (if any QA fixes were needed) + hand back to Mew**

```bash
git commit -am "test(cutaway): manual QA pass + fixes" || echo "no QA fixes needed"
```
Then report to Mew: branch `mew/clip-broll-cutaway` ready; she rebases + merges + deploys (flag `NEXT_PUBLIC_CLIP_CUTAWAY=1` when ready) at a queue-free window.

---

## Self-Review

**1. Spec coverage:**
- §3 UX relabel → Task 4 (steps 1-2). New button → Task 4 (step 3). Vertical-only → Task 4 (steps 5-6). ✓
- §4 architecture (reuse + time-gated overlay) → Task 2 (`cutawayComposite`) + Task 3 (wiring). ✓
- §5 auto-heuristic → Task 1 (`planCutaway`) + tests. ✓
- §6 metering (reuse, no change) → Global Constraints + Task 5 QA step 3 (last check). ✓
- §7 fail-open → Task 2 (empty ranges → full overlay) + Task 4 (isPortraitVideoFile fails open) + heuristic <2 windows → all person. ✓
- §8 testing → Task 1 verify + Task 5 QA. ✓
- §10 flag/rollout → Global Constraints + Task 4 step 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. The one read-then-edit instruction (Task 4 step 6, DirectAvatarUpload handler) gives the exact snippet to insert and the exact anchor ("after obtaining the File, before upload"). ✓

**3. Type consistency:** `planCutaway`/`buildEnableExpr` signatures identical across Task 1 (def), Task 2 (`buildEnableExpr(personRangesSec)`), Task 3 (`planCutaway(pipe.current.brollWindows ?? [])` → `.person` → `{start,end}` in seconds). `personRanges` body key matches between Task 2 (destructure) and Task 3 (send). `directCompositeMode` union `"chromakey"|"full"|"cutaway"` matches across Task 3 (state) and Task 4 (button typing). ✓

---

**Note on the b-roll base reuse (why cutaway is cheap):** the direct-upload flow already runs keyword → fetch-stock → render, producing a b-roll base (`pipe.current.renderedVideoUrl`) with content-matched b-roll for the full clip duration and the clip's audio baked in. Today "full" mode covers that base entirely; cutaway simply reveals it during non-person windows. No new render step, no audio surgery.
