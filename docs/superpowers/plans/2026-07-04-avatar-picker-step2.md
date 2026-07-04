# Avatar Picker (editor v2 Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual avatar picker (sourced from the user's HeyGen account) to editor v2 Step 2, alongside an always-visible paste-Avatar-ID fast path, both driving one `avatarId`.

**Architecture:** UI-only, additive. Reuse the existing `/api/heygen/avatars` endpoint (already cached + durable-stale) via a new `useHeygenAvatars` hook (mirrors `useBgm`). A pure `partitionAvatars` helper splits own/public and filters by search. A presentational `AvatarPickerModal` (mirrors `MusicLibraryModal`) renders the gallery. `Step2Elements` wires them in and keeps `avatarId` as the single source of truth — nothing downstream of `avatarId` changes.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4 + inline token styles (`./tokens`), lucide-react icons, `tsx` verify scripts.

## Global Constraints

- Only touch **editor v2** (`src/app/(dashboard)/video-editor/_v2/` + `_hooks/`). Do NOT touch v1 `video-creator/page.tsx`.
- **No** DB / Prisma / migration / API-route / render-pipeline / job-submit changes. `avatarId` contract unchanged.
- **One avatar per clip** — do not add multi-avatar-per-video.
- Avatar **mode** (bookend / เปิด+ปิด / ทั้งคลิป) + intro/tail secs stay in "ตั้งค่าขั้นสูง"; only the paste-ID field relocates out of Advanced.
- UI copy in **Thai**. Design tokens from `./tokens` (`color`, `font`, `radius`) — single-accent violet. Mirror `MusicLibraryModal` chrome (`GlassPanel`, `GroupLabel`, `Segmented`, overlay `fixed inset-0 z-50`, Escape-to-close, click-outside-close).
- BYOK: when the list can't load because of key/plan, point the user to `/settings` (never ask them to paste a key in the app).
- Verify pure logic with a `scripts/verify-*.ts` script run by `npx tsx` (assert helper, `process.exit(1)` on fail). Commit after each task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

| File | New/Edit | Responsibility |
|---|---|---|
| `src/app/(dashboard)/video-editor/_v2/avatar-filter.ts` | new | `HeygenAvatar` type + pure `partitionAvatars(list, query)` |
| `scripts/verify-avatar-filter.ts` | new | Unit checks for `partitionAvatars` |
| `src/app/(dashboard)/video-editor/_hooks/useHeygenAvatars.ts` | new | Lazy data hook over `/api/heygen/avatars` |
| `src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx` | new | Presentational picker modal |
| `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx` | edit | Avatar group: selected card + "เลือกจากคลัง" + inline paste-ID; Advanced = mode/secs only |

---

### Task 1: `partitionAvatars` pure helper (+ verify)

**Files:**
- Create: `src/app/(dashboard)/video-editor/_v2/avatar-filter.ts`
- Test: `scripts/verify-avatar-filter.ts`

**Interfaces:**
- Produces:
  - `interface HeygenAvatar { avatar_id: string; avatar_name: string; preview_image_url: string; gender: string; is_public: boolean }`
  - `function partitionAvatars(list: HeygenAvatar[], query: string): { own: HeygenAvatar[]; publicOnes: HeygenAvatar[] }`

- [ ] **Step 1: Write the failing verify script**

Create `scripts/verify-avatar-filter.ts`:

```ts
//   npx tsx scripts/verify-avatar-filter.ts
import { partitionAvatars, type HeygenAvatar } from "../src/app/(dashboard)/video-editor/_v2/avatar-filter";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const A = (id: string, name: string, pub: boolean): HeygenAvatar =>
  ({ avatar_id: id, avatar_name: name, preview_image_url: "", gender: "unknown", is_public: pub });

const list: HeygenAvatar[] = [
  A("own1", "My Presenter", false),
  A("pub1", "HeyGen Anna", true),
  A("own2", "Studio Mew", false),
  A("pub2", "HeyGen Public Bob", true),
];

// empty query → split by is_public, input order preserved
const all = partitionAvatars(list, "");
assert(all.own.length === 2 && all.own[0].avatar_id === "own1" && all.own[1].avatar_id === "own2", "own = non-public, input order");
assert(all.publicOnes.length === 2 && all.publicOnes[0].avatar_id === "pub1", "publicOnes = public, input order");

// search filters across both sections, case-insensitive substring on name
const mew = partitionAvatars(list, "mew");
assert(mew.own.length === 1 && mew.own[0].avatar_id === "own2", "'mew' matches own 'Studio Mew'");
assert(mew.publicOnes.length === 0, "'mew' matches no public");

const heygen = partitionAvatars(list, "HEYGEN");
assert(heygen.own.length === 0 && heygen.publicOnes.length === 2, "'HEYGEN' (upper) matches both public");

// whitespace-only query behaves like empty
const ws = partitionAvatars(list, "   ");
assert(ws.own.length === 2 && ws.publicOnes.length === 2, "whitespace query = no filter");

// no match → both empty, never throws
const none = partitionAvatars(list, "zzz-nope");
assert(none.own.length === 0 && none.publicOnes.length === 0, "no match → empty");

// empty list → empty result
const e = partitionAvatars([], "x");
assert(e.own.length === 0 && e.publicOnes.length === 0, "empty list → empty");

console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/verify-avatar-filter.ts`
Expected: FAIL — cannot find module `../src/app/(dashboard)/video-editor/_v2/avatar-filter`.

- [ ] **Step 3: Implement the helper**

Create `src/app/(dashboard)/video-editor/_v2/avatar-filter.ts`:

```ts
/**
 * Pure helpers for the Step 2 avatar picker. No React — unit-tested by
 * scripts/verify-avatar-filter.ts. Mirrors the shape returned by
 * GET /api/heygen/avatars.
 */

export interface HeygenAvatar {
  avatar_id: string;
  avatar_name: string;
  preview_image_url: string;
  gender: string;
  is_public: boolean;
}

/**
 * Split a HeyGen avatar list into the user's own (is_public=false) vs HeyGen's
 * public/stock avatars, filtered by a case-insensitive name substring. Input
 * order is preserved within each section. A blank/whitespace query = no filter.
 */
export function partitionAvatars(
  list: HeygenAvatar[],
  query: string,
): { own: HeygenAvatar[]; publicOnes: HeygenAvatar[] } {
  const needle = query.trim().toLowerCase();
  const matches = (a: HeygenAvatar) =>
    needle === "" || (a.avatar_name ?? "").toLowerCase().includes(needle);
  const filtered = list.filter(matches);
  return {
    own: filtered.filter((a) => !a.is_public),
    publicOnes: filtered.filter((a) => a.is_public),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx scripts/verify-avatar-filter.ts`
Expected: PASS — `8 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_v2/avatar-filter.ts" scripts/verify-avatar-filter.ts
git commit -m "feat(editor-v2): partitionAvatars helper for avatar picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useHeygenAvatars` data hook

**Files:**
- Create: `src/app/(dashboard)/video-editor/_hooks/useHeygenAvatars.ts`

**Interfaces:**
- Consumes: `HeygenAvatar` from `../_v2/avatar-filter` (Task 1).
- Produces:
  - `type HeygenAvatarsError = "no-key" | "not-paid" | "bad-key" | "failed"`
  - `function useHeygenAvatars(): { avatars: HeygenAvatar[]; loading: boolean; loaded: boolean; error: HeygenAvatarsError | null; stale: boolean; load: () => void; reload: () => void }`
  - `load()` = lazy fetch (no-op once successfully loaded or while loading); `reload()` = force refetch.

- [ ] **Step 1: Implement the hook**

Create `src/app/(dashboard)/video-editor/_hooks/useHeygenAvatars.ts`:

```ts
"use client";

import { useCallback, useState } from "react";
import type { HeygenAvatar } from "../_v2/avatar-filter";

/**
 * Lazy loader for the user's HeyGen avatar list (GET /api/heygen/avatars — already
 * cached + durable-stale server-side). Mirrors the useBgm pattern. Maps the route's
 * HTTP statuses to a typed error so the picker can show the right message:
 *   400 → no-key · 403 → not-paid · 401 → bad-key · other → failed.
 */

export type HeygenAvatarsError = "no-key" | "not-paid" | "bad-key" | "failed";

export function useHeygenAvatars() {
  const [avatars, setAvatars] = useState<HeygenAvatar[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<HeygenAvatarsError | null>(null);
  const [stale, setStale] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/heygen/avatars");
      if (res.status === 400) { setError("no-key"); setAvatars([]); return; }
      if (res.status === 403) { setError("not-paid"); setAvatars([]); return; }
      if (res.status === 401) { setError("bad-key"); setAvatars([]); return; }
      if (!res.ok) { setError("failed"); setAvatars([]); return; }
      const d = await res.json().catch(() => null);
      setAvatars(Array.isArray(d?.avatars) ? (d.avatars as HeygenAvatar[]) : []);
      setStale(!!d?.stale);
      setLoaded(true);
    } catch {
      setError("failed");
      setAvatars([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy: fetch on first open. After a success it's a no-op (cached); after an
  // error `loaded` stays false so reopening retries (e.g. once the key is fixed).
  const load = useCallback(() => {
    if (loaded || loading) return;
    void fetchList();
  }, [loaded, loading, fetchList]);

  const reload = useCallback(() => { void fetchList(); }, [fetchList]);

  return { avatars, loading, loaded, error, stale, load, reload };
}
```

- [ ] **Step 2: Type-check the new file**

Run: `npx tsc --noEmit 2>&1 | grep -E "useHeygenAvatars|avatar-filter" || echo "no errors in new files"`
Expected: `no errors in new files` (pre-existing errors elsewhere in the repo, if any, are not from this change).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_hooks/useHeygenAvatars.ts"
git commit -m "feat(editor-v2): useHeygenAvatars lazy data hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `AvatarPickerModal` component

**Files:**
- Create: `src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx`

**Interfaces:**
- Consumes: `HeygenAvatar` + `partitionAvatars` (Task 1); `HeygenAvatarsError` (Task 2).
- Produces:
  - `function AvatarPickerModal(props: { open: boolean; onClose: () => void; selectedId: string; onSelect: (avatarId: string) => void; avatars: HeygenAvatar[]; loading: boolean; error: HeygenAvatarsError | null; stale: boolean; onReload: () => void }): JSX.Element | null`

**Notes:** Mirror `MusicLibraryModal.tsx` for the overlay chrome (`GlassPanel`, `GroupLabel`, `X` close, Escape + click-outside close). Presentational only — the hook lives in the parent (Task 4).

- [ ] **Step 1: Implement the modal**

Create `src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx`:

```tsx
"use client";

/**
 * คลังอวตาร — modal เลือกอวตารจากบัญชี HeyGen ของผู้ใช้ (ดึงผ่าน useHeygenAvatars ที่ parent).
 * ค้นหา + section "อวตารของคุณ" / "อวตารสาธารณะของ HeyGen" (พับได้) · เลือกแล้วปิด modal.
 * ตัวพิมพ์ Avatar ID เองอยู่ที่ Step 2 (ทางลัด) — modal นี้ presentation ล้วน.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, User, X } from "lucide-react";
import { color, font, radius } from "./tokens";
import { GlassPanel, GroupLabel } from "./ui";
import { partitionAvatars, type HeygenAvatar } from "./avatar-filter";
import type { HeygenAvatarsError } from "../_hooks/useHeygenAvatars";

const ERROR_COPY: Record<HeygenAvatarsError, string> = {
  "no-key": "ยังไม่ได้ตั้ง HeyGen API key — ไปตั้งที่หน้าตั้งค่า แล้วกดโหลดใหม่",
  "not-paid": "คลังอวตารใช้ได้เฉพาะแผน PRO / BUSINESS — อัปเกรดที่หน้าตั้งค่า",
  "bad-key": "HeyGen API key ไม่ถูกต้อง — อัปเดตที่หน้าตั้งค่า แล้วกดโหลดใหม่",
  failed: "โหลดรายชื่ออวตารไม่สำเร็จ ลองใหม่อีกครั้ง",
};

export function AvatarPickerModal({ open, onClose, selectedId, onSelect, avatars, loading, error, stale, onReload }: {
  open: boolean;
  onClose: () => void;
  selectedId: string;
  onSelect: (avatarId: string) => void;
  avatars: HeygenAvatar[];
  loading: boolean;
  error: HeygenAvatarsError | null;
  stale: boolean;
  onReload: () => void;
}) {
  const [q, setQ] = useState("");
  const [showPublic, setShowPublic] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const { own, publicOnes } = useMemo(() => partitionAvatars(avatars, q), [avatars, q]);

  if (!open) return null;

  const pick = (id: string) => { onSelect(id); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(6,6,12,.62)" }} onClick={onClose}>
      <GlassPanel className="flex w-[560px] max-w-full flex-col overflow-hidden" style={{ maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        {/* หัว */}
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <GroupLabel>เลือกอวตารจากบัญชี HeyGen</GroupLabel>
          <button onClick={onClose} aria-label="ปิด" style={{ background: "none", border: "none", color: color.textFaint, cursor: "pointer", padding: 4 }}>
            <X size={15} />
          </button>
        </div>

        {/* ค้นหา */}
        <div className="px-5 pb-3">
          <div className="flex items-center gap-2" style={{ padding: "8px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)" }}>
            <Search size={13} color={color.textFaint} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหาชื่ออวตาร…"
              className="min-w-0 flex-1 bg-transparent outline-none"
              style={{ fontSize: 12.5, color: color.text, fontFamily: font.body }}
            />
          </div>
          {stale && !error && (
            <div className="mt-2 flex items-center justify-between" style={{ fontSize: 10.5, color: color.textFaint }}>
              <span>อาจไม่ใช่รายการล่าสุด (HeyGen ตอบช้า)</span>
              <button onClick={onReload} style={{ background: "none", border: "none", color: color.link, cursor: "pointer", padding: 0, fontSize: 10.5 }}>โหลดใหม่</button>
            </div>
          )}
        </div>

        {/* เนื้อ */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading && (
            <div className="py-10 text-center" style={{ fontSize: 12, color: color.textFaint }}>กำลังโหลดรายชื่ออวตาร…</div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7, maxWidth: 360 }}>{ERROR_COPY[error]}</span>
              <div className="flex items-center gap-2">
                <a href="/settings" style={{ fontSize: 12, color: color.primary300, textDecoration: "none", padding: "6px 12px", borderRadius: radius.control, border: `1px solid ${color.selectedBorder}` }}>ไปหน้าตั้งค่า</a>
                <button onClick={onReload} style={{ fontSize: 12, color: color.textSecondary, background: "none", border: `1px solid ${color.cardBorder}`, borderRadius: radius.control, padding: "6px 12px", cursor: "pointer" }}>โหลดใหม่</button>
              </div>
            </div>
          )}

          {!loading && !error && own.length === 0 && publicOnes.length === 0 && (
            <div className="py-10 text-center" style={{ fontSize: 11.5, color: color.textFaintest, lineHeight: 1.7 }}>
              {q.trim() ? "ไม่พบอวตารที่ค้นหา" : "ยังไม่มีอวตารในบัญชี HeyGen — สร้างที่ heygen.com หรือวาง Avatar ID เองด้านล่าง"}
            </div>
          )}

          {!loading && !error && (own.length > 0 || publicOnes.length > 0) && (
            <div className="flex flex-col gap-4">
              {own.length > 0 && (
                <section className="flex flex-col gap-2">
                  <GroupLabel>อวตารของคุณ ({own.length})</GroupLabel>
                  <AvatarGrid list={own} selectedId={selectedId} onPick={pick} />
                </section>
              )}
              {publicOnes.length > 0 && (
                <section className="flex flex-col gap-2">
                  <button
                    onClick={() => setShowPublic((v) => !v)}
                    className="flex items-center gap-1 self-start"
                    style={{ background: "none", border: "none", color: color.textFaint, cursor: "pointer", padding: 0 }}
                  >
                    <ChevronDown size={12} strokeWidth={1.8} style={{ transform: showPublic ? "rotate(180deg)" : undefined, transition: "transform 150ms ease" }} />
                    <GroupLabel>อวตารสาธารณะของ HeyGen ({publicOnes.length})</GroupLabel>
                  </button>
                  {showPublic && <AvatarGrid list={publicOnes} selectedId={selectedId} onPick={pick} />}
                </section>
              )}
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

function AvatarGrid({ list, selectedId, onPick }: { list: HeygenAvatar[]; selectedId: string; onPick: (id: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
      {list.map((a) => {
        const isSelected = selectedId === a.avatar_id;
        return (
          <button
            key={a.avatar_id}
            onClick={() => onPick(a.avatar_id)}
            className="relative flex flex-col items-center gap-1.5 text-center"
            style={{
              borderRadius: radius.card, padding: "8px",
              background: isSelected ? color.selectedBg : color.cardBg,
              border: `1px solid ${isSelected ? color.selectedBorder : color.cardBorder}`,
              cursor: "pointer", transition: "all 150ms ease",
            }}
          >
            <div className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden" style={{ borderRadius: 8, background: "#1C1C2B" }}>
              {a.preview_image_url
                ? // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.preview_image_url} alt={a.avatar_name} className="h-full w-full object-cover" />
                : <User size={20} strokeWidth={1.5} color={color.textFaint} />}
            </div>
            <span className="w-full truncate" style={{ fontSize: 10.5, color: isSelected ? color.primary300 : color.textSecondary }}>{a.avatar_name || a.avatar_id}</span>
            {isSelected && (
              <span className="absolute right-1.5 top-1.5 flex h-[16px] w-[16px] items-center justify-center rounded-full" style={{ background: color.primary500 }}>
                <Check size={10} color="#fff" strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify `GlassPanel` / `GroupLabel` exports exist in `./ui`**

Run: `grep -nE "export (function|const) (GlassPanel|GroupLabel)" "src/app/(dashboard)/video-editor/_v2/ui.tsx"`
Expected: both are listed. (If `GlassPanel` is not exported, use the same overlay markup `MusicLibraryModal` uses — it already imports `GlassPanel` from `./ui`, so it exists.)

- [ ] **Step 3: Type-check the new file**

Run: `npx tsc --noEmit 2>&1 | grep -E "AvatarPickerModal" || echo "no errors in AvatarPickerModal"`
Expected: `no errors in AvatarPickerModal`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx"
git commit -m "feat(editor-v2): AvatarPickerModal gallery (own/public sections)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the picker into `Step2Elements`

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx` (avatar group, currently lines ~359–453)

**Interfaces:**
- Consumes: `useHeygenAvatars` (Task 2), `AvatarPickerModal` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Add imports**

At the top of `Step2Elements.tsx`, add to the existing imports:

```tsx
import { useHeygenAvatars } from "../_hooks/useHeygenAvatars";
import { AvatarPickerModal } from "./AvatarPickerModal";
```

- [ ] **Step 2: Add hook + modal-open state inside `Step2Elements`**

Near the other `useState` calls at the top of the `Step2Elements` component body (e.g. just after `const [musicLibOpen, setMusicLibOpen] = useState(false);`), add:

```tsx
const avatarLib = useHeygenAvatars();
const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
const openAvatarPicker = () => { setAvatarPickerOpen(true); avatarLib.load(); };
```

- [ ] **Step 3: Replace the avatar-group body**

In the "4 · อวตารพิธีกร" `Group`, replace the current `{p.useAvatar && (…)}` selected-avatar block AND the `<Advanced>` block with the version below. The `มีอวตาร / Faceless` `Segmented` and the `!p.useAvatar` faceless line stay unchanged; the mode/secs controls move verbatim into the new `Advanced`, and the paste-ID `<label>` is lifted OUT of Advanced into the main body.

```tsx
{p.useAvatar && (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-3">
      <div
        className="flex h-[66px] w-[50px] items-center justify-center overflow-hidden"
        style={{ borderRadius: 10, outline: `1.5px solid ${color.primary500}`, outlineOffset: 2, background: "#1C1C2B" }}
      >
        {p.avatarInfo?.previewUrl
          ? // eslint-disable-next-line @next/next/no-img-element
            <img src={p.avatarInfo.previewUrl} alt="avatar" className="h-full w-full object-cover" />
          : <User size={20} strokeWidth={1.5} color={color.textFaint} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span style={{ font: `500 12.5px ${font.heading}`, color: color.primary300 }}>
          {p.avatarInfo?.name || (p.avatarId ? p.avatarId : "ยังไม่ได้ตั้งอวตาร")}
        </span>
        <span style={{ fontSize: 10.5, color: color.textFaint }}>
          {p.avatarId ? "อวตารที่เลือกไว้" : "เลือกจากคลัง หรือวาง Avatar ID"}
        </span>
      </div>
      <button
        onClick={openAvatarPicker}
        className="shrink-0"
        style={{
          fontSize: 12, color: color.primary300, cursor: "pointer",
          padding: "8px 14px", borderRadius: radius.control,
          background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
        }}
      >
        เลือกจากคลัง
      </button>
    </div>

    {/* ทางลัด: วาง Avatar ID เอง (ผูก avatarId ตัวเดียวกับ picker) */}
    <label className="flex flex-col gap-1.5">
      <span style={{ fontSize: 11, color: color.textFaint }}>หรือวาง Avatar ID เอง</span>
      <input
        value={p.avatarId}
        onChange={(e) => p.setAvatarId(e.target.value)}
        placeholder="วาง HeyGen Avatar ID"
        className="w-full max-w-[280px]"
        style={{
          padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
          background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
          color: color.text, fontFamily: font.body, outline: "none",
        }}
      />
    </label>
  </div>
)}
{!p.useAvatar && (
  <div className="flex items-center gap-2" style={{ fontSize: 11.5, color: color.textFaint }}>
    <UserX size={14} strokeWidth={1.6} /> วิดีโอเสียง + บีโรล ไม่มีพิธีกร
  </div>
)}
<Advanced>
  {p.useAvatar && (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: 11, color: color.textFaint }}>โหมดพิธีกร (HeyGen คิดเงินตามวินาทีที่เจน)</span>
        <Segmented
          value={p.avatarMode}
          onChange={p.setAvatarMode}
          options={[
            { value: "bookend", label: "เปิดคลิป" },
            { value: "bookend-both", label: "เปิด+ปิด" },
            { value: "full", label: "ทั้งคลิป" },
          ]}
        />
      </label>
      {p.avatarMode !== "full" && (
        <div className="flex items-center gap-3" style={{ fontSize: 11.5, color: color.textSecondary }}>
          <label className="flex items-center gap-1.5">
            เปิด
            <input type="number" min={1} max={30} value={p.avatarIntroSecs}
              onChange={(e) => p.setAvatarIntroSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
              className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
            วิ
          </label>
          {p.avatarMode === "bookend-both" && (
            <label className="flex items-center gap-1.5">
              ปิด
              <input type="number" min={1} max={30} value={p.avatarTailSecs}
                onChange={(e) => p.setAvatarTailSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
                className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
              วิ
            </label>
          )}
        </div>
      )}
      <span style={{ fontSize: 10.5, color: color.textFaintest, lineHeight: 1.6 }}>
        ปรับตำแหน่ง/ขนาดอวตารได้ฟรีหลังเรนเดอร์ (ในจอแต่งซับ)
      </span>
    </div>
  )}
</Advanced>
```

- [ ] **Step 4: Render the modal**

Just before the closing `</Group>` of the avatar group (after `</Advanced>`), add:

```tsx
<AvatarPickerModal
  open={avatarPickerOpen}
  onClose={() => setAvatarPickerOpen(false)}
  selectedId={p.avatarId}
  onSelect={(id) => p.setAvatarId(id)}
  avatars={avatarLib.avatars}
  loading={avatarLib.loading}
  error={avatarLib.error}
  stale={avatarLib.stale}
  onReload={avatarLib.reload}
/>
```

- [ ] **Step 5: Build-verify**

Run: `npm run build`
Expected: build succeeds (no type/lint error from the edited/added files). If the machine OOMs, use the prod low-heap env from CLAUDE.md: `BUILD_HEAP_MB=4096 BUILD_WORKER_HEAP_MB=512 BUILD_NO_LINT=1 npm run build`.

- [ ] **Step 6: Browser QA** (manual — paid account with a HeyGen key)

1. Open `/video-editor?ui=v2` → Step 2 → กลุ่ม "อวตารพิธีกร" → toggle `มีอวตาร`.
2. Click "เลือกจากคลัง" → modal lists your HeyGen avatars (own section; expand public) → search works.
3. Pick one → modal closes, selected card + right-rail "อวตาร" summary update, preview thumbnail shows.
4. Clear/change the inline "วาง Avatar ID" field → preview + card stay in sync with the picker (same `avatarId`).
5. Render one short test clip → the chosen avatar appears (mode/secs still work from Advanced).
6. On a non-paid or no-key account: modal shows the Settings message; the paste-ID field still works.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx"
git commit -m "feat(editor-v2): avatar picker + inline paste-ID in Step 2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Picker sourced from HeyGen account → Tasks 2 (hook) + 3 (modal). ✓
- Search + own/public sections → Task 1 (`partitionAvatars`) + Task 3 (sections). ✓
- Always-visible paste-ID fast path, same `avatarId` → Task 4 Step 3. ✓
- States (loading / no-key / not-paid / bad-key / empty / stale) → Task 2 (typed errors) + Task 3 (rendering). ✓
- Mode/secs stay in Advanced; paste-ID relocated (move-not-cut) → Task 4 Step 3. ✓
- No pipeline/DB/API/job change; one avatar per clip → nothing in any task touches those. ✓
- Non-goals (v1, multi-avatar-per-video, new storage, talking_photos, default change) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; verify test has real assertions. ✓

**Type consistency:** `HeygenAvatar` (Task 1) used by Tasks 2/3; `HeygenAvatarsError` (Task 2) used by Task 3; `partitionAvatars` return `{ own, publicOnes }` consumed consistently in Task 3; `useHeygenAvatars` return shape consumed exactly in Task 4. ✓
