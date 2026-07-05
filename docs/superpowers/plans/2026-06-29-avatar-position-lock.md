# Avatar Position Lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save & lock a HeyGen avatar's on-canvas position/size per Avatar ID, auto-applied in the web editor and in MCP automation, with the avatar always entering whole (uncut).

**Architecture:** Decouple generation from positioning. HeyGen generates the avatar **whole on green** at a fixed conservative framing (once). All sizing/positioning happens in our **composite** (`layoutGeometry`, already implemented and already matched by the editor preview). A per-`(user,avatarId)` `AvatarPreset` stores the layout; it's loaded into the editor and the MCP compose step.

**Tech Stack:** Next.js 15 App Router, Prisma 6 + SQLite, TypeScript. Tests = team `verify-*.ts` pattern run via `npx tsx` (pure logic + throwaway SQLite), `tsc --noEmit`.

## Global Constraints

- Avatar layout coordinate space (composite + editor, "V2"): `scale` 1.0 = full canvas; `offsetX/offsetY` in `-400..400` (editor sliders use the `-200..200` sub-range; `200` = half-frame). Stored presets use THIS space. NEVER store the creator's HeyGen-units (`scale 2.02`, `offset 0.13`).
- Do NOT change `layoutGeometry` math, the chroma-key filter chain, the `720×1280` gen / `1080×1920` composite dimensions, or the `generate-with-bg` px↔`-1..1` offset conversion. Geometry is *extracted and shared*, never altered.
- Canvas constants: `CANVAS_W = 1080`, `CANVAS_H = 1920`.
- Additive schema only (`prisma db push` on deploy). Run `npx prisma generate` after schema edits.
- Branch: `mew/avatar-position-lock`. Commit after every task. Verify scripts have no package.json entry — run via `npx tsx scripts/<name>.ts`.

---

### Task 1: Shared avatar-layout geometry module

Extract `layoutGeometry`/clamp into a pure, importable module (source of truth for BOTH the ffmpeg composite and the editor preview), and add a normalized-box helper for UI. Refactor the composite route to import it.

**Files:**
- Create: `src/lib/avatar-layout.ts`
- Create (test): `scripts/verify-avatar-layout-geometry.ts`
- Modify: `src/app/api/heygen/composite/route.ts:42-66` (replace local `AvatarLayout`/`parseAvatarLayout`/`layoutGeometry` with imports)

**Interfaces:**
- Produces: `type AvatarLayout = { scale: number; offsetX: number; offsetY: number }`; `CANVAS_W=1080`, `CANVAS_H=1920`; `clampAvatarLayout(raw: unknown): AvatarLayout | null`; `layoutGeometry(l: AvatarLayout): { w:number;h:number;x:number;y:number }`; `normalizedBox(l: AvatarLayout): { centerXPct:number; centerYPct:number; widthPct:number; heightPct:number }`.

- [ ] **Step 1: Write the failing test** — `scripts/verify-avatar-layout-geometry.ts`

```typescript
// Run: npx tsx scripts/verify-avatar-layout-geometry.ts
// Locks the avatar-layout geometry that BOTH the ffmpeg composite and the editor preview depend on.
import { clampAvatarLayout, layoutGeometry, normalizedBox, CANVAS_W, CANVAS_H } from "../src/lib/avatar-layout";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

// geometry: scale 1 + no offset = full canvas at origin
const g1 = layoutGeometry({ scale: 1, offsetX: 0, offsetY: 0 });
ok(g1.w === CANVAS_W && g1.h === CANVAS_H && g1.x === 0 && g1.y === 0, "scale 1 / no offset → full canvas at (0,0)");

// geometry: scale 0.5 centered
const g2 = layoutGeometry({ scale: 0.5, offsetX: 0, offsetY: 0 });
ok(g2.w === 540 && g2.h === 960 && g2.x === 270 && g2.y === 480, "scale 0.5 → 540x960 centered at (270,480)");

// geometry: offsetX 400 shifts a full canvas right by CANVAS_W
const g3 = layoutGeometry({ scale: 1, offsetX: 400, offsetY: 0 });
ok(g3.x === CANVAS_W && g3.y === 0, "offsetX 400 → x shifted by +1080 (full frame right)");

// normalizedBox: editor uses center-based percentages
const b = normalizedBox({ scale: 0.5, offsetX: 200, offsetY: -200 });
ok(b.widthPct === 50 && b.heightPct === 50, "normalizedBox scale 0.5 → 50% w/h");
ok(b.centerXPct === 100 && b.centerYPct === 0, "normalizedBox offset (200,-200) → center (100%,0%)");

// clamp: no-op (scale~1, offset~0) returns null so composite falls back to full-cover
ok(clampAvatarLayout({ scale: 1, offsetX: 0, offsetY: 0 }) === null, "no-op layout clamps to null (full-cover fallback)");
// clamp: bounds
const c = clampAvatarLayout({ scale: 99, offsetX: 9999, offsetY: -9999 });
ok(!!c && c.scale === 4 && c.offsetX === 400 && c.offsetY === -400, "clamp bounds scale≤4, |offset|≤400");
// clamp: garbage → null
ok(clampAvatarLayout({ scale: "x" }) === null && clampAvatarLayout(null) === null, "non-finite/garbage → null");

console.log(`\n✅ ALL ${p} AVATAR-LAYOUT GEOMETRY CHECKS PASSED`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-avatar-layout-geometry.ts`
Expected: FAIL — `Cannot find module '../src/lib/avatar-layout'`.

- [ ] **Step 3: Write the module** — `src/lib/avatar-layout.ts`

```typescript
// Single source of truth for avatar-layer geometry, shared by the ffmpeg composite
// (src/app/api/heygen/composite/route.ts) and the editor preview (RightSettingsPanel).
// Coordinate space ("V2"): scale 1 = full canvas; offset in -400..400 (1080*offset/400 px).
export const CANVAS_W = 1080;
export const CANVAS_H = 1920;

export type AvatarLayout = { scale: number; offsetX: number; offsetY: number };

/** Clamp a raw layout to valid bounds. Returns null when it's a no-op (scale≈1, offset≈0) so the
 *  composite falls back to the legacy full-cover path, or when the input is non-finite/garbage. */
export function clampAvatarLayout(raw: unknown): AvatarLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const scale = Number(o.scale), offsetX = Number(o.offsetX), offsetY = Number(o.offsetY);
  if (!Number.isFinite(scale) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  const s = Math.min(4, Math.max(0.05, scale));
  const x = Math.min(400, Math.max(-400, offsetX));
  const y = Math.min(400, Math.max(-400, offsetY));
  if (Math.abs(s - 1) < 0.001 && Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return null;
  return { scale: s, offsetX: x, offsetY: y };
}

/** Pixel geometry for ffmpeg overlay: avatar scaled to w×h, placed at (x,y) on the canvas. */
export function layoutGeometry(layout: AvatarLayout): { w: number; h: number; x: number; y: number } {
  const w = Math.round((CANVAS_W * layout.scale) / 2) * 2;
  const h = Math.round((CANVAS_H * layout.scale) / 2) * 2;
  const x = Math.round((CANVAS_W - w) / 2 + (CANVAS_W * layout.offsetX) / 400);
  const y = Math.round((CANVAS_H - h) / 2 + (CANVAS_H * layout.offsetY) / 400);
  return { w, h, x, y };
}

/** Center-based percentages for the editor preview box (translate(-50%,-50%) positioning). */
export function normalizedBox(layout: AvatarLayout): { centerXPct: number; centerYPct: number; widthPct: number; heightPct: number } {
  return {
    centerXPct: 50 + (layout.offsetX / 400) * 100,
    centerYPct: 50 + (layout.offsetY / 400) * 100,
    widthPct: layout.scale * 100,
    heightPct: layout.scale * 100,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-avatar-layout-geometry.ts`
Expected: PASS — `✅ ALL 8 AVATAR-LAYOUT GEOMETRY CHECKS PASSED`.

- [ ] **Step 5: Refactor composite to import the shared module**

In `src/app/api/heygen/composite/route.ts`: delete the local `type AvatarLayout` (line ~44), `parseAvatarLayout` (lines ~48-58), and `layoutGeometry` (lines ~60-66). Add at the top with the other imports:
```typescript
import { clampAvatarLayout, layoutGeometry, type AvatarLayout } from "@/lib/avatar-layout";
```
Then replace the one call site `const layout = parseAvatarLayout(avatarLayout);` (line ~490) with:
```typescript
const layout = clampAvatarLayout(avatarLayout);
```
Leave every other line (chroma filter, ffmpeg args, the `if (layout) { ... layoutGeometry(layout) ... }` blocks) unchanged.

- [ ] **Step 6: Verify composite still type-checks**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/avatar-layout.ts scripts/verify-avatar-layout-geometry.ts src/app/api/heygen/composite/route.ts
git commit -m "refactor(avatar): extract shared layoutGeometry/clamp module (editor↔render single source)"
```

---

### Task 2: AvatarPreset model + preset lib

**Files:**
- Modify: `prisma/schema.prisma` (add `AvatarPreset` model + `User.avatarPresets` relation)
- Create: `src/lib/avatar-preset.ts`
- Create (test): `scripts/verify-avatar-preset.ts`

**Interfaces:**
- Consumes: `AvatarLayout`, `clampAvatarLayout` from `@/lib/avatar-layout`.
- Produces: `DEFAULT_AVATAR_LAYOUT: AvatarLayout` (= `{scale:1,offsetX:0,offsetY:0}`); `getAvatarPreset(userId: string, avatarId: string): Promise<AvatarLayout | null>`; `saveAvatarPreset(userId: string, avatarId: string, raw: unknown): Promise<AvatarLayout>` (validates via `clampAvatarLayout`; a no-op/garbage layout is stored as `DEFAULT_AVATAR_LAYOUT`).

- [ ] **Step 1: Add the schema model**

In `prisma/schema.prisma`, add after the `User` model's relations (inside `User`, near `userMusic UserMusic[]`):
```prisma
  avatarPresets      AvatarPreset[]
```
And add a new model after `model McpToken { ... }`:
```prisma
model AvatarPreset {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  avatarId  String   // HeyGen avatar_id or talking_photo_id
  scale     Float    @default(1)
  offsetX   Float    @default(0)
  offsetY   Float    @default(0)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@unique([userId, avatarId])
  @@index([userId])
}
```

- [ ] **Step 2: Regenerate the client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 3: Write the failing test** — `scripts/verify-avatar-preset.ts`

```typescript
// Run: npx tsx scripts/verify-avatar-preset.ts
// Proves AvatarPreset save→load round-trips, upserts per (user,avatar), isolates users.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "avpreset-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

async function main() {
  const { getAvatarPreset, saveAvatarPreset, DEFAULT_AVATAR_LAYOUT } = await import("../src/lib/avatar-preset");
  const { prisma } = await import("../src/lib/prisma");
  const u = await prisma.user.create({ data: { name: "P", email: "preset@test.local" } });

  ok((await getAvatarPreset(u.id, "av1")) === null, "no preset yet → null (caller uses default)");

  const saved = await saveAvatarPreset(u.id, "av1", { scale: 1.6, offsetX: 120, offsetY: -40 });
  ok(saved.scale === 1.6 && saved.offsetX === 120 && saved.offsetY === -40, "save returns the clamped layout");
  const back = await getAvatarPreset(u.id, "av1");
  ok(!!back && back.scale === 1.6 && back.offsetX === 120 && back.offsetY === -40, "load round-trips");

  await saveAvatarPreset(u.id, "av1", { scale: 2.0, offsetX: 0, offsetY: 0 });
  const back2 = await getAvatarPreset(u.id, "av1");
  ok(back2!.scale === 2.0 && back2!.offsetX === 0, "re-save overwrites (upsert on user+avatar)");
  ok((await prisma.avatarPreset.count({ where: { userId: u.id } })) === 1, "still one row (no dup)");

  const u2 = await prisma.user.create({ data: { name: "Q", email: "preset2@test.local" } });
  ok((await getAvatarPreset(u2.id, "av1")) === null, "another user's same avatarId is isolated");

  // garbage/no-op stores the default (so a 'Save' always yields a usable row)
  const def = await saveAvatarPreset(u.id, "avX", { scale: "nope" });
  ok(def.scale === DEFAULT_AVATAR_LAYOUT.scale && def.offsetX === 0 && def.offsetY === 0, "garbage layout → stored as default");

  console.log(`\n✅ ALL ${p} AVATAR-PRESET CHECKS PASSED`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx scripts/verify-avatar-preset.ts`
Expected: FAIL — `Cannot find module '../src/lib/avatar-preset'`.

- [ ] **Step 5: Write the lib** — `src/lib/avatar-preset.ts`

```typescript
import { prisma } from "@/lib/prisma";
import { clampAvatarLayout, type AvatarLayout } from "@/lib/avatar-layout";

/** Layout used when an avatar has no saved preset: avatar fills the green frame, centered. */
export const DEFAULT_AVATAR_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

export async function getAvatarPreset(userId: string, avatarId: string): Promise<AvatarLayout | null> {
  if (!avatarId) return null;
  const row = await prisma.avatarPreset.findUnique({ where: { userId_avatarId: { userId, avatarId } } });
  return row ? { scale: row.scale, offsetX: row.offsetX, offsetY: row.offsetY } : null;
}

export async function saveAvatarPreset(userId: string, avatarId: string, raw: unknown): Promise<AvatarLayout> {
  const layout = clampAvatarLayout(raw) ?? DEFAULT_AVATAR_LAYOUT;
  await prisma.avatarPreset.upsert({
    where: { userId_avatarId: { userId, avatarId } },
    create: { userId, avatarId, ...layout },
    update: { ...layout },
  });
  return layout;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx scripts/verify-avatar-preset.ts`
Expected: PASS — `✅ ALL 7 AVATAR-PRESET CHECKS PASSED`.

- [ ] **Step 7: Type-check + commit**

```bash
npx tsc --noEmit   # expect exit 0
git add prisma/schema.prisma src/lib/avatar-preset.ts scripts/verify-avatar-preset.ts
git commit -m "feat(avatar): AvatarPreset model + get/save lib (per user+avatar position store)"
```

---

### Task 3: Preset API route (GET/PUT)

**Files:**
- Create: `src/app/api/avatar-presets/[avatarId]/route.ts`

**Interfaces:**
- Consumes: `getAvatarPreset`, `saveAvatarPreset` from `@/lib/avatar-preset`; `getCurrentUser` from `@/lib/clerk-auth`.
- Produces: `GET /api/avatar-presets/<avatarId>` → `{ layout: AvatarLayout | null }`; `PUT` body `{scale,offsetX,offsetY}` → `{ layout: AvatarLayout }` (saved).

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getAvatarPreset, saveAvatarPreset } from "@/lib/avatar-preset";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ avatarId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { avatarId } = await params;
  const layout = await getAvatarPreset(user.id, avatarId);
  return NextResponse.json({ layout });
}

export async function PUT(req: Request, { params }: { params: Promise<{ avatarId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { avatarId } = await params;
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const layout = await saveAvatarPreset(user.id, avatarId, body);
  return NextResponse.json({ layout });
}
```

> Note: Next.js 15 route handlers receive `params` as a Promise — `await params`. Confirm against a sibling dynamic route (e.g. `src/app/api/.../[id]/route.ts`) and match its style.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/avatar-presets
git commit -m "feat(avatar): GET/PUT /api/avatar-presets/[avatarId]"
```

---

### Task 4: Conservative "whole avatar" generation default

Make HeyGen bring the avatar in **whole/uncut** on green, since positioning now happens in composite. Replace the hardcoded zoom defaults with conservative constants.

**Files:**
- Modify: `src/app/api/heygen/generate-with-bg/route.ts:110-112` (the `scale`/`offsetX`/`offsetY` defaults) and the offset fallback at `:130`.

**Interfaces:**
- Produces: `HEYGEN_GEN_SCALE`, `HEYGEN_GEN_OFFSET_Y` module constants (so the value is named + tunable).

- [ ] **Step 1: Add named constants + use them as the request defaults**

At the top of the file (after imports) add:
```typescript
// Conservative framing so the FULL avatar (head + arms) always enters on green; the user
// then positions/scales it in the editor (composite layoutGeometry). NOT a per-avatar value.
// Validated 2026-06-29: 2.02 over-zooms/cuts some custom photo-avatars; 1.0 = HeyGen natural framing.
const HEYGEN_GEN_SCALE = 1.0;
const HEYGEN_GEN_OFFSET_Y = 0.0;
```
Then change the destructuring defaults (lines ~110-112) from:
```typescript
    scale = 2.02,
    offsetX = 0.0,
    offsetY = 0.28,
```
to:
```typescript
    scale = HEYGEN_GEN_SCALE,
    offsetX = 0.0,
    offsetY = HEYGEN_GEN_OFFSET_Y,
```
And the `safeOffset` fallback at line ~130 from `safeOffset(offsetY, 0.13)` to `safeOffset(offsetY, HEYGEN_GEN_OFFSET_Y)`.

- [ ] **Step 2: VALIDATION (manual, Mew's HeyGen beta key) — confirm "whole/uncut"**

Generate a few avatars at `scale=HEYGEN_GEN_SCALE` on green and confirm head + arms are fully inside the frame for differently-framed avatars (reuse the session test harness `scratchpad/hg-fit-test.py` pattern: v2 `/v2/video/generate`, green bg, the chosen scale). If any avatar is still cut, lower `HEYGEN_GEN_SCALE` (e.g. 0.85) and re-confirm. Record the final value in the constant comment.

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit   # expect exit 0
git add src/app/api/heygen/generate-with-bg/route.ts
git commit -m "feat(avatar): conservative whole-avatar HeyGen gen default (uncut); positioning moves to composite"
```

---

### Task 5: Editor — load preset on avatar load + Save button

When an avatar becomes valid in the editor, prefill its saved layout (or default). Add a "Save position" button that persists the current layout for that avatarId.

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (avatar-valid effect → fetch preset; add `saveAvatarLayout` handler; pass it to the panel)
- Modify: `src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx:592-613` (add Save button near the Reset button; add prop to the panel's type)

**Interfaces:**
- Consumes: `GET/PUT /api/avatar-presets/[avatarId]`; editor state `avatarId`, `avatarScale/setAvatarScale`, `avatarOffsetX/setAvatarOffsetX`, `avatarOffsetY/setAvatarOffsetY`, `avatarStatus` (from `page.tsx:311-319`).
- Produces: editor passes `onSaveAvatarLayout: () => Promise<void>` + `avatarLayoutSaving: boolean` into `RightSettingsPanel`.

- [ ] **Step 1: Add the load-preset effect** in `video-editor/page.tsx`

After the avatar state declarations (near line 324), add:
```typescript
  // When an avatar ID becomes valid, load its saved position (else leave editor defaults).
  useEffect(() => {
    if (!avatarId || (avatarStatus !== "ok" && avatarStatus !== "unverified")) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`);
        if (!res.ok) return;
        const { layout } = await res.json();
        if (cancelled || !layout) return;
        setAvatarScale(layout.scale); setAvatarOffsetX(layout.offsetX); setAvatarOffsetY(layout.offsetY);
      } catch { /* keep current values */ }
    })();
    return () => { cancelled = true; };
  }, [avatarId, avatarStatus]);
```
(If `useEffect` isn't imported, add it to the existing `react` import.)

- [ ] **Step 2: Add the save handler** in `video-editor/page.tsx` (near `runComposite`, ~line 2396)

```typescript
  const [avatarLayoutSaving, setAvatarLayoutSaving] = useState(false);
  async function onSaveAvatarLayout(): Promise<void> {
    if (!avatarId) return;
    setAvatarLayoutSaving(true);
    try {
      await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scale: avatarScale, offsetX: avatarOffsetX, offsetY: avatarOffsetY }),
      });
    } finally { setAvatarLayoutSaving(false); }
  }
```

- [ ] **Step 3: Thread the props to the panel** — find where `<RightSettingsPanel ... />` is rendered in `page.tsx` and add:
```tsx
            onSaveAvatarLayout={onSaveAvatarLayout}
            avatarLayoutSaving={avatarLayoutSaving}
```

- [ ] **Step 4: Add the props to the panel type + Save button** in `RightSettingsPanel.tsx`

In the panel's props type (near `setAvatarScale: (v:number)=>void;`, ~line 56) add:
```typescript
  onSaveAvatarLayout: () => Promise<void>;
  avatarLayoutSaving: boolean;
```
Then replace the Reset button block (lines ~609-612) with Reset + Save side by side:
```tsx
                        <div className="flex gap-2">
                          <button onClick={() => { p.setAvatarOffsetX(0); p.setAvatarOffsetY(0); p.setAvatarScale(1); }}
                            className="text-[9px] text-slate-600 hover:text-slate-400 transition-colors flex-1 text-center">
                            ↺ Reset
                          </button>
                          <button onClick={() => { void p.onSaveAvatarLayout(); }} disabled={p.avatarLayoutSaving}
                            className="text-[9px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 transition-colors flex-1 text-center">
                            {p.avatarLayoutSaving ? "กำลังบันทึก…" : "💾 Save ตำแหน่ง"}
                          </button>
                        </div>
```

- [ ] **Step 5: Type-check + manual smoke**

Run: `npx tsc --noEmit` (expect exit 0). Then `npm run dev`, open `/video-editor`, set an avatar ID, drag/scale, click "Save ตำแหน่ง", reload the page / re-enter the same avatar ID → position is restored.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx"
git commit -m "feat(avatar): editor loads saved position on avatar load + Save/Lock button"
```

---

### Task 6: MCP — apply saved preset in create_video_job

So AI/MCP automation reuses the locked position automatically.

**Files:**
- Modify: the MCP avatar compose path. Start at `src/app/api/[transport]/route.ts:129,150,167` (the `avatarScale`/`avatarOffsetX`/`avatarOffsetY` wiring) and follow `avatarId` → the job input that the MCP worker composes with.

**Interfaces:**
- Consumes: `getAvatarPreset`, `DEFAULT_AVATAR_LAYOUT` from `@/lib/avatar-preset`.
- Behavior: when a request supplies an `avatarId` but NO explicit `avatarScale/avatarOffsetX/avatarOffsetY`, resolve the layout from `getAvatarPreset(userId, avatarId) ?? DEFAULT_AVATAR_LAYOUT` and use it. An explicit caller-supplied layout still wins.

- [ ] **Step 1: Write the failing test** — extend the MCP avatar input test

Add to `scripts/verify-mcp-avatar-input.ts` a case (mirror its existing style) asserting a pure resolver: explicit layout passes through unchanged; missing layout + existing preset → preset; missing layout + no preset → `DEFAULT_AVATAR_LAYOUT`. If the resolution is currently inline, extract it to a pure `resolveAvatarLayout(input, preset)` in `src/lib/avatar-preset.ts` and test that:
```typescript
export function resolveAvatarLayout(
  input: { avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number },
  preset: AvatarLayout | null,
): AvatarLayout {
  if (input.avatarScale != null || input.avatarOffsetX != null || input.avatarOffsetY != null) {
    return { scale: input.avatarScale ?? 1, offsetX: input.avatarOffsetX ?? 0, offsetY: input.avatarOffsetY ?? 0 };
  }
  return preset ?? DEFAULT_AVATAR_LAYOUT;
}
```

- [ ] **Step 2: Run test → fail**

Run: `npx tsx scripts/verify-mcp-avatar-input.ts`
Expected: FAIL on the new resolver assertions.

- [ ] **Step 3: Implement** `resolveAvatarLayout` in `src/lib/avatar-preset.ts` (code above), then in the MCP create-video path load `const preset = await getAvatarPreset(userId, avatarId)` and set the job's avatar layout to `resolveAvatarLayout(args, preset)` before composing.

- [ ] **Step 4: Run test → pass + tsc**

Run: `npx tsx scripts/verify-mcp-avatar-input.ts` (expect PASS); `npx tsc --noEmit` (expect exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/lib/avatar-preset.ts scripts/verify-mcp-avatar-input.ts "src/app/api/[transport]/route.ts"
git commit -m "feat(avatar): MCP create_video_job applies saved position preset (automation)"
```

---

### Final: full verify sweep

- [ ] Run all new/related verify scripts + tsc:
```bash
npx tsx scripts/verify-avatar-layout-geometry.ts
npx tsx scripts/verify-avatar-preset.ts
npx tsx scripts/verify-mcp-avatar-input.ts
npx tsx scripts/verify-avatar-steps.ts
npx tsc --noEmit
```
Expected: all pass, tsc exit 0.
- [ ] Mew's manual render-QA gate: gen an avatar (whole/uncut), position in editor, Save, re-gen same avatar (web + via MCP) → position locked. Confirm subtitles/headline unaffected.
- [ ] Open PR into `main` (Mew merges + deploys; `prisma db push` adds the `AvatarPreset` table).

## Notes / Deferred
- Multiple named presets per avatar (drop `@@unique`, add `name`/`isDefault`) — future, per Mew.
- Video-creator faithful preview (still a thumbnail CSS approximation) — Mew's flow is editor-centric; the creator only needs the conservative gen (Task 4). Wire its composite to send `avatarLayout` later if creator-side positioning is wanted.
- HeyGen v3 `fit:cover` for a future "full-avatar (no b-roll)" mode (great framing, but no green output) — out of scope here.
