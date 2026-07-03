# Editor v2 Feedback Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** แก้ฟีดแบค 6 ข้อจากการใช้งาน editor v2 จริง — export lifecycle, timeline scrub, waveform, การ์ดซับตาม preview, คลังเพลง, และปรับตำแหน่งอวตารหลังเรนเดอร์ (spec: `docs/superpowers/specs/2026-07-03-editor-v2-feedback-round1-design.md`)

**Architecture:** ก้อน 1 (Task 1–5) แก้เฉพาะ client ใน `src/app/(dashboard)/video-editor/_v2/` + hook/lib ที่แชร์กับ v1 · ก้อน 2 (Task 6–8) เพิ่ม field ใน preview output ของ worker, เพิ่ม PATCH route, แล้วต่อ UI ปรับตำแหน่งอวตารเข้า `/api/heygen/composite` (ท่อ re-composite เดิม ไม่เรียก HeyGen ใหม่)

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript · Prisma/SQLite · ffmpeg composite เดิม

## Global Constraints

- ทุกอย่างอยู่หลัง flag `EDITOR_V2` เดิม — ห้ามแตะพฤติกรรม v1 (`page.tsx` แก้ได้เฉพาะจุดที่ระบุ)
- Design System v2: **1 จอ = 1 ปุ่ม `BtnPrimary` เท่านั้น · line icon (Lucide) เท่านั้น ห้าม emoji** (`_v2/ui.tsx` header)
- ไฟล์ v2 ใช้ token จาก `_v2/tokens.ts` (`color`, `font`, `radius`) — ห้าม hardcode สีใหม่นอก token ยกเว้นค่า rgba โปร่งใสประกอบ
- Task 6 แตะ worker/orchestrator (render backend) → ต้อง `npm run build` ผ่านก่อน commit (ธรรมเนียม build-verify)
- คอมเมนต์ในโค้ดภาษาไทยตามสไตล์ไฟล์เดิม
- ทดสอบ logic ล้วนด้วย `scripts/verify-*.ts` (รันด้วย `npx tsx`) ตาม pattern ของ repo · UI ตรวจด้วย `npx tsc --noEmit` + browser QA ท้ายก้อน
- Commit แยกราย task, ข้อความ commit อังกฤษ prefix `feat(editor-v2):` / `fix(editor-v2):`

---

### Task 1: Export lifecycle — ชื่อคลิปจาก script + success screen + เคลียร์ job

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Job.ts` (เพิ่ม `markExported`)
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx:82` (ส่ง props เพิ่ม)
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx` (props, exportVideo, success screen)

**Interfaces:**
- Consumes: `useV2Job` STORAGE_KEY `"editor-v2-job"` · `POST /api/videos` รับ `script` อยู่แล้ว (`src/app/api/videos/route.ts:115-127`) · Gallery ตั้งชื่อจาก `video.script.slice(0,40)` (`src/app/(dashboard)/videos/page.tsx:309`)
- Produces: `useV2Job()` คืน `markExported: () => void` เพิ่ม · `PostPhase` รับ props ใหม่ `script: string`, `onExported: () => void`

- [ ] **Step 1: เพิ่ม `markExported` ใน useV2Job**

ใน `useV2Job.ts` เพิ่มหลัง `reset` (บรรทัด ~164):

```ts
  /** Export สำเร็จ = งานนี้จบแล้ว: ลืม jobId (ออกจากหน้าแล้วกลับมา → เริ่ม step 1 สด)
   *  แต่ไม่แตะ state ในหน้า — user ยังแก้ซับต่อ/ส่งออกซ้ำได้จนกว่าจะออก (spec ข้อ 5) */
  const markExported = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  return { job, submit, cancel, reset, markExported };
```

(แทน return เดิม `return { job, submit, cancel, reset };`)

- [ ] **Step 2: ส่ง script + onExported จาก shell**

ใน `EditorV2Shell.tsx` บรรทัด 24 เปลี่ยนเป็น:

```ts
  const { job, submit, cancel, reset, markExported } = useV2Job(p);
```

บรรทัด 82 เปลี่ยนเป็น:

```tsx
        <PostPhase job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onNewProject={() => { reset(); setStep(0); }} />
```

- [ ] **Step 3: PostPhase — รับ props, ส่ง script ตอน save gallery, เรียก onExported**

เปลี่ยน signature (บรรทัด 40):

```tsx
export function PostPhase({ job, script, onExported, onNewProject }: {
  job: V2JobState; script: string; onExported: () => void; onNewProject: () => void;
}) {
```

ใน `exportVideo` เปลี่ยน body ของ `POST /api/videos` (บรรทัด ~196-203) เป็น:

```ts
        body: JSON.stringify({
          videoUrl: burnedUrl,
          audioUrl: preview?.voiceUrl ?? null,
          thumbnail: null,
          // ชื่อใน Gallery มาจาก script (v1 ก็ทำแบบนี้) — โหมดอัปคลิปใช้ fullText ที่ถอดได้
          script: script.trim() || preview?.fullText || null,
          sceneCount: captions.length,
          status: "COMPLETED",
        }),
```

และหลัง save gallery ก่อน `setExp({ phase: "done", url: burnedUrl })` เพิ่ม:

```ts
      onExported(); // งานนี้จบแล้ว — กลับเข้ามาใหม่ต้องเริ่มสด (spec ข้อ 5)
```

- [ ] **Step 4: Success screen — เพิ่มปุ่ม Gallery / แก้ซับต่อ / เริ่มใหม่**

เปลี่ยน import บรรทัด 13 ให้มี `BtnSecondary`:

```ts
import { BtnPrimary, BtnSecondary, BtnGhost, Card, GroupLabel, Segmented } from "./ui";
```

เปลี่ยนบล็อกปุ่มใน `exp.phase === "done"` (บรรทัด ~220-225) เป็น:

```tsx
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href={exp.url} download>
            <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
          </a>
          <a href="/videos"><BtnSecondary>ดูใน Gallery</BtnSecondary></a>
          <BtnGhost onClick={() => setExp({ phase: "idle" })}>แก้ซับต่อ &amp; ส่งออกใหม่</BtnGhost>
          <BtnGhost onClick={onNewProject}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: ไม่มี error ใหม่ (error เดิมของ repo ถ้ามี ให้เทียบกับ `git stash` ก่อนแก้)

- [ ] **Step 6: ตรวจด้วยมือ (dev)**

Run: `npm run dev` → เปิด `/video-editor?ui=v2` → เรนเดอร์คลิปสั้น → ส่งออก → เช็ค: (1) Gallery `/videos` ชื่อคลิป = ต้นสคริปต์ ไม่ใช่ Untitled (2) หน้า success มีปุ่ม 4 ปุ่ม (3) กด "แก้ซับต่อ" กลับเข้าจอแต่งซับ state เดิมอยู่ครบ (4) refresh หน้า → เริ่ม step 1 สด ไม่ resume งานเดิม (5) งานที่ยังไม่ export ยัง resume ได้เหมือนเดิม

- [ ] **Step 7: Commit**

```bash
git add src/app/\(dashboard\)/video-editor/_v2/useV2Job.ts src/app/\(dashboard\)/video-editor/_v2/EditorV2Shell.tsx src/app/\(dashboard\)/video-editor/_v2/PostPhase.tsx
git commit -m "feat(editor-v2): export ends the session - gallery title from script, success screen, fresh re-entry"
```

---

### Task 2: Timeline ruler ลาก scrub ได้

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx:176-188` (ruler) + `:247` (playhead top)

**Interfaces:**
- Consumes: `seekTo(ms)` (`TimelinePanel.tsx:75-78`), `toPx`/`pxPerSec` เดิม
- Produces: ไม่มี interface ใหม่ (behavior เท่านั้น)

- [ ] **Step 1: เปลี่ยน ruler จาก onClick เป็น pointer drag-scrub**

เพิ่ม ref ใกล้ `dragRef` (บรรทัด ~67):

```ts
  const scrubbingRef = useRef(false);
```

แทนที่บล็อก ruler เดิม (บรรทัด 175-188) ด้วย:

```tsx
          {/* ruler ลาก scrub ได้ (คลิก = jump, ลากค้าง = playhead วิ่งตาม) */}
          <div
            className="relative ml-[92px] h-[24px] cursor-pointer"
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              scrubbingRef.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seekTo(((e.clientX - rect.left) / pxPerSec) * 1000);
            }}
            onPointerMove={(e) => {
              if (!scrubbingRef.current) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seekTo(((e.clientX - rect.left) / pxPerSec) * 1000);
            }}
            onPointerUp={(e) => {
              scrubbingRef.current = false;
              try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
            }}
            onPointerCancel={() => { scrubbingRef.current = false; }}
          >
            {Array.from({ length: Math.floor(durMs / 1000) + 1 }, (_, s) => s).filter((s) => s % (pxPerSec < 18 ? 5 : 1) === 0).map((s) => (
              <span key={s} className="absolute top-0 select-none" style={{ left: toPx(s * 1000), fontSize: 8, color: color.textFaintest }}>
                {fmt(s * 1000)}
              </span>
            ))}
          </div>
```

- [ ] **Step 2: ขยับ playhead ให้ตรงกับ ruler สูงใหม่**

บรรทัด 247 เปลี่ยน `top-[16px]` เป็น `top-[24px]`:

```tsx
          <div className="pointer-events-none absolute bottom-0 top-[24px]" style={{ left: LABEL_W + toPx(timeMs) }}>
```

- [ ] **Step 3: Typecheck + ตรวจด้วยมือ**

Run: `npx tsc --noEmit` → ผ่าน · dev: ลากบน ruler ค้างแล้วเลื่อน → playhead + preview วิ่งตามต่อเนื่อง, คลิกจุดเดียวยัง jump ได้

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/video-editor/_v2/TimelinePanel.tsx
git commit -m "feat(editor-v2): timeline ruler drag-to-scrub (was click-only)"
```

---

### Task 3: Waveform เสียงพากย์ + snap เข้าเสียง ใน TimelinePanel

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx` (เลนใหม่ + snap)
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx:556-569` (ส่ง `voiceUrl`)

**Interfaces:**
- Consumes: `useAudioPeaks(voiceUrl)` → `{peaks: number[]|null, durationMs}` (`_components/useAudioPeaks.ts:10`) · `WaveformCanvas({peaks,width,height})` (`_components/WaveformCanvas.tsx:5`) · `snapPointsFromPeaks(peaks, msPerPeak)` + `snapToNearest(ms, points, thresholdMs)` (`_components/waveform-snap.ts:43,61`) · `preview.voiceUrl` (`video-job.ts:56`)
- Produces: `TimelinePanel` รับ prop ใหม่ `voiceUrl: string | null`

- [ ] **Step 1: ส่ง voiceUrl จาก PostPhase**

ใน `PostPhase.tsx` props ของ `<TimelinePanel>` (บรรทัด ~556) เพิ่ม:

```tsx
        voiceUrl={preview?.voiceUrl ?? null}
```

- [ ] **Step 2: TimelinePanel — โหลด peaks + เลนคลื่นเสียง**

เพิ่ม import ที่หัวไฟล์:

```ts
import { useAudioPeaks } from "../_components/useAudioPeaks";
import { WaveformCanvas } from "../_components/WaveformCanvas";
import { snapPointsFromPeaks, snapToNearest } from "../_components/waveform-snap";
```

เพิ่ม prop ใน signature (interface บรรทัด 49-62):

```ts
  voiceUrl: string | null;
```

(และรับใน destructure: `voiceUrl,`)

ใน body หลัง `const brollSpans = ...` (บรรทัด ~73) เพิ่ม:

```ts
  // Waveform เสียงพากย์ (fail-open: โหลด/decode ไม่ได้ = ไม่มีเลน, snap ตกกลับแบบเดิม)
  const { peaks, durationMs: waveDurMs } = useAudioPeaks(voiceUrl);
  const waveMs = waveDurMs || durMs;
  const audioSnapPoints = useMemo(
    () => (peaks?.length ? snapPointsFromPeaks(peaks, waveMs / peaks.length) : []),
    [peaks, waveMs],
  );
```

เพิ่มเลนเสียงพูด **หลังบล็อก ruler ก่อนแทร็กอวตาร** (แทรกก่อนบรรทัด `{/* อวตาร */}`):

```tsx
          {/* เสียงพูด (waveform) — ไว้เทียบขอบซับกับ wave ตอนตัดต่อ */}
          {peaks && peaks.length > 0 && (
            <div className="relative flex items-center" style={{ height: 34 }}>
              {trackLabel("เสียงพูด", "#8B7CF6")}
              <div className="relative flex-1 overflow-hidden" style={{ height: 34 }}>
                <div className="absolute left-0 top-0">
                  <WaveformCanvas peaks={peaks} width={Math.max(1, Math.round(toPx(waveMs)))} height={34} />
                </div>
              </div>
            </div>
          )}
```

ปรับความสูงแผง (บรรทัด 150) จาก `height: 192` เป็น:

```tsx
    <div className="flex shrink-0 flex-col" style={{ height: peaks && peaks.length > 0 ? 226 : 192, background: color.bgTimeline, borderTop: `1px solid ${color.cardBorder}` }}>
```

- [ ] **Step 3: snap เข้าจุดเสียงก่อนจุดอื่น**

แก้ `snapMs` (บรรทัด 87-99) เป็น:

```ts
  /** จุด snap: จุดเปลี่ยนเสียงพูด (ก่อน) > ขอบการ์ดข้างเคียง > วินาทีเต็ม */
  function snapMs(raw: number, idx: number): number {
    if (!snap) return raw;
    if (audioSnapPoints.length && audioSnapPoints.some((p) => Math.abs(p - raw) <= SNAP_MS)) {
      return snapToNearest(raw, audioSnapPoints, SNAP_MS);
    }
    const points: number[] = [0, durMs];
    captions.forEach((c, i) => { if (i !== idx) { points.push(c.startMs, c.endMs); } });
    for (let s = 0; s <= durMs; s += 1000) points.push(s);
    let best = raw;
    let bestDist = SNAP_MS + 1;
    for (const p of points) {
      const d = Math.abs(p - raw);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return bestDist <= SNAP_MS ? best : raw;
  }
```

- [ ] **Step 4: Typecheck + ตรวจด้วยมือ**

Run: `npx tsc --noEmit` → ผ่าน · dev: จอแต่งซับมีเลน "เสียงพูด" เห็น waveform · ลากขอบการ์ดซับใกล้จุดเริ่ม/จบเสียง → ดูดเข้าหา · ปิด Snap → ไม่ดูด · งานเก่าที่ไม่มี voiceUrl → ไม่มีเลน แผงสูง 192 เท่าเดิม

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/video-editor/_v2/TimelinePanel.tsx src/app/\(dashboard\)/video-editor/_v2/PostPhase.tsx
git commit -m "feat(editor-v2): voice waveform lane + snap subtitle edges to speech boundaries"
```

---

### Task 4: การ์ดซับ highlight + auto-scroll ตาม preview

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_lib/find-active-caption.ts:16` (คลาย type)
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx` (aside การ์ดซับ)

**Interfaces:**
- Consumes: `timeMs` state (`PostPhase.tsx:56`), `playing` (`:57`), `editingIdx` (`:45`)
- Produces: `findActiveCaptionIdx(captions: readonly {startMs:number;endMs:number}[], captionMs: number): number` — โครงสร้างเดิม แค่ type กว้างขึ้น (V2Caption กับ Caption ของ v1 ใช้ได้ทั้งคู่)

- [ ] **Step 1: คลาย type ของ findActiveCaptionIdx**

ใน `find-active-caption.ts` ลบ `import type { Caption } ...` (บรรทัด 1) แล้วเปลี่ยน signature (บรรทัด 16) เป็น:

```ts
export function findActiveCaptionIdx(
  captions: readonly { startMs: number; endMs: number }[],
  captionMs: number,
): number {
```

(v1 caller ส่ง `Caption[]` เข้าได้เหมือนเดิม — structural typing)

- [ ] **Step 2: PostPhase — active card + follow state**

เพิ่ม import:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, CheckCircle2, Download, Loader2, Pencil } from "lucide-react";
import { findActiveCaptionIdx } from "../_lib/find-active-caption";
```

(แก้ 2 บรรทัด import เดิมที่บรรทัด 9, 11)

เพิ่ม state/refs ใกล้ `const [playing, setPlaying] = ...` (บรรทัด ~57):

```ts
  // การ์ดที่ "กำลังพูด" ตาม preview (แยกจาก selected = การ์ดที่เลือกแก้)
  const activeIdx = useMemo(() => findActiveCaptionIdx(captions, timeMs), [captions, timeMs]);
  const [follow, setFollow] = useState(true);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastAutoScrollAt = useRef(0);

  // auto-scroll ตามการ์ด active — หยุดชั่วคราวถ้ากำลังพิมพ์แก้ซับ (กันเลื่อนหนี)
  useEffect(() => {
    if (!follow || !playing || editingIdx !== null || activeIdx < 0) return;
    const el = cardRefs.current[activeIdx];
    if (!el) return;
    lastAutoScrollAt.current = Date.now();
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx, follow, playing, editingIdx]);

  function onListScroll() {
    // smooth scrollIntoView ยิง scroll event ต่อเนื่องช่วงสั้น ๆ — ช่วงนั้นไม่นับเป็นผู้ใช้เลื่อนเอง
    if (Date.now() - lastAutoScrollAt.current < 700) return;
    if (playing && follow) setFollow(false);
  }

  function resumeFollow() {
    setFollow(true);
    const el = activeIdx >= 0 ? cardRefs.current[activeIdx] : null;
    if (el) { lastAutoScrollAt.current = Date.now(); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
```

- [ ] **Step 3: ผูกเข้า aside การ์ดซับ**

แก้ `<aside>` ซ้าย (บรรทัด ~260) เพิ่ม `onScroll`:

```tsx
        <aside onScroll={onListScroll} className="flex w-[266px] shrink-0 flex-col gap-2 overflow-y-auto p-3" style={{ borderRight: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
```

แก้ div ครอบการ์ด (บรรทัด ~263) — เพิ่ม ref + resume follow ตอนคลิก:

```tsx
          {captions.map((c, i) => (
            <div
              key={`${i}-${c.startMs}`}
              ref={(el) => { cardRefs.current[i] = el; }}
              onClick={() => { setSelected(i); setFollow(true); const v = videoRef.current; if (v) v.currentTime = c.startMs / 1000 + 0.01; }}
              style={{ cursor: "pointer" }}
            >
              <Card
                selected={i === selected}
                style={i === activeIdx ? { boxShadow: `inset 2.5px 0 0 ${color.primary300}` } : undefined}
              >
```

(ที่เหลือในการ์ดคงเดิม)

เพิ่ม chip "ตามซับที่กำลังเล่น" **หลังจบ `captions.map(...)` ก่อนบล็อกปุ่มรวม/แยก**:

```tsx
          {!follow && (
            <button
              onClick={resumeFollow}
              className="sticky bottom-1 z-10 mx-auto flex shrink-0 items-center gap-1.5"
              style={{
                padding: "5px 12px", borderRadius: radius.pill,
                background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
                color: color.primary300, fontSize: 11, cursor: "pointer",
                backdropFilter: "blur(6px)",
              }}
            >
              <ArrowDownToLine size={11} strokeWidth={2} /> ตามซับที่กำลังเล่น
            </button>
          )}
```

(`radius` มีใน import เดิมบรรทัด 12 แล้ว)

- [ ] **Step 4: Typecheck + ตรวจด้วยมือ**

Run: `npx tsc --noEmit` → ผ่าน · dev: กดเล่น preview → การ์ดที่พูดอยู่มีขีดม่วงซ้าย + ลิสต์เลื่อนตาม · เลื่อนลิสต์เองระหว่างเล่น → หยุดตาม + chip โผล่ · กด chip → กลับไปตาม · คลิกการ์ด → seek + ตามต่อ · คลิกดินสอแก้ข้อความระหว่างเล่น → ลิสต์ไม่เลื่อนหนี · v1 (`?ui=v1`) timeline highlight ยังทำงานปกติ (แตะ find-active-caption ร่วมกัน)

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/video-editor/_lib/find-active-caption.ts src/app/\(dashboard\)/video-editor/_v2/PostPhase.tsx
git commit -m "feat(editor-v2): subtitle cards follow preview playback with manual-scroll pause + resume chip"
```

---

### Task 5: คลังเพลงเต็ม — modal ค้นหา/แท็บ/อัปโหลด + รองรับเพลงผู้ใช้

**Files:**
- Create: `src/app/(dashboard)/video-editor/_v2/MusicLibraryModal.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts` (เพิ่ม `musicTrackKind`)
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Job.ts:107` (bgmFile path ตาม kind)
- Modify: `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx` (ปุ่มเปิดคลัง + chip เพลงที่เลือก + summary)

**Interfaces:**
- Consumes: `useBgm()` → `systemTracks: SystemTrack[]`, `userTracks: UserMusicTrack[]`, `setUserTracks` (`_hooks/useBgm.ts:34-41`) · `POST /api/music/upload` (FormData `file`) → `{url, filename, track}` (`api/music/upload/route.ts:137`) · ไฟล์เล่นตัวอย่าง `/api/music/<filename>` ใช้ได้ทั้ง system/user · bgmFile ฝั่ง server: system = `/music/<filename>`, user = `/api/music/<filename>` (pattern เดียวกับ v1 `OrderPanel.tsx:659`)
- Produces: `useV2Project()` เพิ่ม `musicTrackKind: "system" | "user"` + `setMusicTrackKind` (persist ใน draft) · `MusicLibraryModal({open,onClose,systemTracks,userTracks,onUploaded,selected,selectedKind,onSelect})`

- [ ] **Step 1: useV2Project — เพิ่ม musicTrackKind**

`V2Draft` (บรรทัด 9-15) เพิ่ม field:

```ts
  musicTrack?: string | null; musicTrackKind?: "system" | "user"; useAvatar?: boolean; avatarId?: string;
```

หลัง state `musicTrack` (บรรทัด ~74) เพิ่ม:

```ts
  /** เพลงที่เลือกเป็นของระบบหรือของผู้ใช้ — ใช้เลือก path bgmFile ตอน submit */
  const [musicTrackKind, setMusicTrackKind] = useState<"system" | "user">(d.musicTrackKind ?? "system");
```

เพิ่ม `musicTrackKind` ใน object ที่ persist (บรรทัด ~118-123) และใน dependency array (บรรทัด ~127) และใน return (บรรทัด ~162):

```ts
    musicTrack, setMusicTrack,
    musicTrackKind, setMusicTrackKind,
```

- [ ] **Step 2: useV2Job — bgmFile ตาม kind**

บรรทัด 107 เปลี่ยนเป็น:

```ts
        // เพลง: system → /music/<f> (resolver เดิม) · ของผู้ใช้ → /api/music/<f> (แบบ v1)
        ...(p.musicTrack ? { bgmFile: p.musicTrackKind === "user" ? `/api/music/${p.musicTrack}` : `/music/${p.musicTrack}` } : {}),
```

- [ ] **Step 3: สร้าง MusicLibraryModal.tsx**

```tsx
"use client";

/**
 * คลังเพลงเต็ม (spec ข้อ 2) — modal: ค้นหา + แท็บ เพลงระบบ/เพลงของฉัน + ฟังตัวอย่าง +
 * อัปโหลด (แผน Pro ขึ้นไป — server เช็คเอง) · เลือกแล้วปิด modal, chip ใน step 2 อัปเดต
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Pause, Play, Search, Upload, X } from "lucide-react";
import { color, font, radius } from "./tokens";
import { GlassPanel, GroupLabel, Segmented } from "./ui";
import type { SystemTrack, UserMusicTrack } from "../_hooks/useBgm";

export function MusicLibraryModal({ open, onClose, systemTracks, userTracks, onUploaded, selected, selectedKind, onSelect }: {
  open: boolean;
  onClose: () => void;
  systemTracks: SystemTrack[];
  userTracks: UserMusicTrack[];
  /** เพลงอัปโหลดใหม่ — parent ต้อง setUserTracks เพิ่มเอง */
  onUploaded: (track: UserMusicTrack) => void;
  selected: string | null; // filename · "" = ยังไม่เลือก · null = ไม่ใส่เพลง
  selectedKind: "system" | "user";
  onSelect: (filename: string, kind: "system" | "user") => void;
}) {
  const [tab, setTab] = useState<"system" | "user">("system");
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing("");
  }
  useEffect(() => { if (!open) stopPreview(); }, [open]);
  useEffect(() => () => stopPreview(), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function togglePreview(filename: string) {
    if (previewing === filename) { stopPreview(); return; }
    stopPreview();
    const audio = new Audio(`/api/music/${filename}`);
    audio.volume = 0.5;
    audio.preload = "auto";
    audioRef.current = audio;
    setPreviewing(filename);
    audio.onended = () => { if (audioRef.current === audio) stopPreview(); };
    audio.onerror = () => { if (audioRef.current === audio) { stopPreview(); toast.error("เล่นเพลงตัวอย่างไม่สำเร็จ"); } };
    try { await audio.play(); } catch { if (audioRef.current === audio) { stopPreview(); toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง"); } }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/music/upload", { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.track) { toast.error(d?.message ?? d?.error ?? "อัปโหลดเพลงไม่สำเร็จ"); return; }
      onUploaded(d.track as UserMusicTrack);
      onSelect((d.track as UserMusicTrack).filename, "user");
      toast.success("อัปโหลดแล้ว — เลือกเพลงนี้ให้เลย");
      onClose();
    } catch {
      toast.error("อัปโหลดเพลงไม่สำเร็จ");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const list = useMemo(() => {
    const src = tab === "system" ? systemTracks : userTracks;
    const needle = q.trim().toLowerCase();
    return needle ? src.filter((t) => t.title.toLowerCase().includes(needle)) : src;
  }, [tab, q, systemTracks, userTracks]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(6,6,12,.62)" }} onClick={onClose}>
      <GlassPanel className="flex w-[520px] max-w-full flex-col overflow-hidden" style={{ maxHeight: "78vh" }} onClick={(e) => e.stopPropagation()}>
        {/* หัว */}
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <GroupLabel>คลังเพลงทั้งหมด ({systemTracks.length + userTracks.length})</GroupLabel>
          <button onClick={onClose} aria-label="ปิด" style={{ background: "none", border: "none", color: color.textFaint, cursor: "pointer", padding: 4 }}>
            <X size={15} />
          </button>
        </div>

        {/* ค้นหา + แท็บ + อัปโหลด */}
        <div className="flex items-center gap-2 px-5 pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-2" style={{ padding: "8px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)" }}>
            <Search size={13} color={color.textFaint} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหาชื่อเพลง…"
              className="min-w-0 flex-1 bg-transparent outline-none"
              style={{ fontSize: 12.5, color: color.text, fontFamily: font.body }}
            />
          </div>
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as "system" | "user")}
            options={[{ value: "system", label: `ระบบ (${systemTracks.length})` }, { value: "user", label: `ของฉัน (${userTracks.length})` }]}
          />
        </div>

        {/* ลิสต์เพลง */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {tab === "user" && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".mp3,.wav,.ogg,.aac,.m4a,audio/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="mb-2 flex w-full items-center justify-center gap-2"
                style={{
                  padding: "10px 0", borderRadius: radius.card, background: "none",
                  border: `1px dashed rgba(255,255,255,.18)`, color: color.textSecondary,
                  fontSize: 12, cursor: uploading ? "wait" : "pointer",
                }}
              >
                <Upload size={13} /> {uploading ? "กำลังอัปโหลด…" : "อัปโหลดเพลงของคุณ (mp3/wav/m4a ≤50MB)"}
              </button>
            </>
          )}
          {list.length === 0 && (
            <div className="py-8 text-center" style={{ fontSize: 11.5, color: color.textFaintest }}>
              {q.trim() ? "ไม่พบเพลงที่ค้นหา" : tab === "user" ? "ยังไม่มีเพลงของคุณ — อัปโหลดได้เลย" : "ยังไม่มีเพลงในระบบ"}
            </div>
          )}
          {list.map((t) => {
            const isSelected = selected === t.filename && selectedKind === tab;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => { stopPreview(); onSelect(t.filename, tab); onClose(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { stopPreview(); onSelect(t.filename, tab); onClose(); } }}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5"
                style={{
                  borderRadius: radius.card,
                  background: isSelected ? color.selectedBg : "none",
                  border: `1px solid ${isSelected ? color.selectedBorder : "transparent"}`,
                }}
              >
                <button
                  aria-label={previewing === t.filename ? "หยุดตัวอย่าง" : "ฟังตัวอย่าง"}
                  onClick={(e) => { e.stopPropagation(); void togglePreview(t.filename); }}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: previewing === t.filename ? "rgba(52,211,153,.15)" : "rgba(255,255,255,.07)",
                    border: `1px solid ${color.cardBorder}`,
                    color: previewing === t.filename ? color.success : color.textSecondary,
                    cursor: "pointer",
                  }}
                >
                  {previewing === t.filename ? <Pause size={11} strokeWidth={2} /> : <Play size={11} strokeWidth={2} style={{ marginLeft: 1 }} />}
                </button>
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, color: isSelected ? color.primary300 : color.text }}>
                  {t.title}
                </span>
                {isSelected && <Check size={13} color={color.primary300} strokeWidth={2.5} />}
              </div>
            );
          })}
        </div>
      </GlassPanel>
    </div>
  );
}
```

- [ ] **Step 4: Step2Elements — ปุ่มเปิดคลัง + chip เพลงที่เลือก + summary**

เพิ่ม import:

```ts
import { MusicLibraryModal } from "./MusicLibraryModal";
```

ใน `Step2Elements` body เพิ่ม state + chip list (หลัง `const [submitting, ...]` บรรทัด ~47):

```ts
  const [musicLibOpen, setMusicLibOpen] = useState(false);
  // chips = 6 เพลงแรกของระบบ · ถ้าเพลงที่เลือกไม่อยู่ในนั้น (ระบบตัวท้าย ๆ / ของผู้ใช้) เอามาโชว์หน้าสุด
  const baseChips = bgm.systemTracks.slice(0, 6).map((t) => ({ ...t, kind: "system" as const }));
  const selectedTrack = p.musicTrack
    ? (p.musicTrackKind === "user"
        ? bgm.userTracks.find((t) => t.filename === p.musicTrack)
        : bgm.systemTracks.find((t) => t.filename === p.musicTrack))
    : null;
  const selectedInChips = p.musicTrackKind === "system" && baseChips.some((t) => t.filename === p.musicTrack);
  const chipTracks = selectedTrack && !selectedInChips
    ? [{ id: selectedTrack.id, title: selectedTrack.title, filename: selectedTrack.filename, kind: p.musicTrackKind }, ...baseChips.slice(0, 5)]
    : baseChips;
```

เปลี่ยนกลุ่มเพลง (บรรทัด 264-270) เป็น:

```tsx
        {/* 3 · เพลงประกอบ */}
        {p.mode !== "upload" && (
        <Group title="เพลงประกอบ" desc="เพลงเบา ๆ ใต้เสียงพูด (ลดเสียงอัตโนมัติ) · กดไอคอนเพื่อฟังตัวอย่าง">
          <MusicChips p={p} tracks={chipTracks} />
          <button
            onClick={() => setMusicLibOpen(true)}
            className="self-start"
            style={{ fontSize: 11.5, color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            คลังเพลงทั้งหมด ({bgm.systemTracks.length + bgm.userTracks.length}) · อัปโหลดเพลงของคุณ
          </button>
          <MusicLibraryModal
            open={musicLibOpen}
            onClose={() => setMusicLibOpen(false)}
            systemTracks={bgm.systemTracks}
            userTracks={bgm.userTracks}
            onUploaded={(t) => bgm.setUserTracks([t, ...bgm.userTracks])}
            selected={p.musicTrack}
            selectedKind={p.musicTrackKind}
            onSelect={(filename, kind) => { p.setMusicTrack(filename); p.setMusicTrackKind(kind); }}
          />
          <Advanced note="ระดับเสียงเพลง" />
        </Group>
        )}
```

แก้ `MusicChips` ให้รับ kind (บรรทัด 427 + จุดเลือก 468-470):

```tsx
function MusicChips({ p, tracks }: { p: V2Project; tracks: { id: string; title: string; filename: string; kind: "system" | "user" }[] }) {
```

และในแต่ละ chip เปลี่ยน handler เลือกเพลง (2 จุด: onClick + onKeyDown) เป็น:

```tsx
          onClick={() => { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); } }}
```

แก้ summary แถวเพลง (บรรทัด ~399) เป็น:

```tsx
              <SummaryRow label="เพลง" value={p.musicTrack === null ? "ไม่ใส่" : (selectedTrack?.title ?? "ยังไม่เลือก")} />
```

- [ ] **Step 5: verify script — bgmFile path ตาม kind**

Create `scripts/verify-v2-bgm-path.ts`:

```ts
// verify-v2-bgm-path.ts — เพลง v2: system → /music/<f> · user → /api/music/<f> · ไม่เลือก → ไม่ส่ง
// Run: npx tsx scripts/verify-v2-bgm-path.ts
function bgmFileFor(musicTrack: string | null, kind: "system" | "user"): string | undefined {
  // สูตรเดียวกับ useV2Job.ts submit — คัดลอกมาทดสอบ logic (hook รันนอก React ไม่ได้)
  return musicTrack ? (kind === "user" ? `/api/music/${musicTrack}` : `/music/${musicTrack}`) : undefined;
}
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${String(got)} want=${String(want)}`);
  if (!ok) fail++;
}
eq("system track", bgmFileFor("calm.mp3", "system"), "/music/calm.mp3");
eq("user track", bgmFileFor("user-1-abc.mp3", "user"), "/api/music/user-1-abc.mp3");
eq("none (null)", bgmFileFor(null, "system"), undefined);
eq("none (empty)", bgmFileFor("", "system"), undefined);
process.exit(fail ? 1 : 0);
```

Run: `npx tsx scripts/verify-v2-bgm-path.ts`
Expected: `PASS` ทั้ง 4 บรรทัด, exit 0

- [ ] **Step 6: Typecheck + ตรวจด้วยมือ**

Run: `npx tsc --noEmit` → ผ่าน · dev: step 2 มีลิงก์ "คลังเพลงทั้งหมด (N)" → modal เปิด ค้นหา/ฟังตัวอย่าง/สลับแท็บได้ · เลือกเพลงนอก 6 ตัวแรก → chip เพลงนั้นโผล่ติดถูก · อัปโหลด mp3 → เข้าแท็บของฉัน + ถูกเลือกอัตโนมัติ · เรนเดอร์ด้วยเพลงผู้ใช้ → มีเสียงเพลงในคลิป

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-v2-bgm-path.ts src/app/\(dashboard\)/video-editor/_v2/MusicLibraryModal.tsx src/app/\(dashboard\)/video-editor/_v2/useV2Project.ts src/app/\(dashboard\)/video-editor/_v2/useV2Job.ts src/app/\(dashboard\)/video-editor/_v2/Step2Elements.tsx
git commit -m "feat(editor-v2): full music library modal - search, user uploads, out-of-chip selection"
```

---

### Task 6: Worker — เก็บข้อมูล re-composite ลง preview output

**Files:**
- Modify: `src/lib/mcp/video-job.ts:52-65` (`VideoJobPreviewData`)
- Modify: `src/lib/mcp/orchestrator.ts:356-404` (เก็บ field เพิ่มตอน preview finishJob)

**Interfaces:**
- Consumes: `runAvatarComposite` คืน `{compositeUrl, avatarUrl, tailAvatarUrl?}` (`avatar-steps.ts:96`) · `baseUrl` = base render ก่อน composite (`orchestrator.ts:348`)
- Produces: `VideoJobPreviewData` เพิ่ม `avatarMode?: string | null; avatarIntroSecs?: number; avatarTailSecs?: number; compositeBaseUrl?: string | null; tailAvatarUrl?: string | null` — Task 8 อ่านผ่าน `GET /api/videos/jobs/[id]` (parser ส่ง preview ผ่านทั้งก้อนอยู่แล้ว `video-job.ts:82-84`)

- [ ] **Step 1: ขยาย VideoJobPreviewData**

ใน `video-job.ts` interface `VideoJobPreviewData` (บรรทัด 52) เพิ่มหลัง `avatarVideoUrl`:

```ts
  avatarModel?: string;
  avatarVideoUrl?: string | null;
  /** ข้อมูลสำหรับ re-composite อวตารจากจอแต่งซับ (spec 07-03 ข้อ 1) — งานเก่าไม่มี = ซ่อนปุ่มปรับ */
  avatarMode?: string | null;
  avatarIntroSecs?: number;
  avatarTailSecs?: number;
  /** base render ก่อน composite อวตาร = bgVideoUrl ของ /api/heygen/composite */
  compositeBaseUrl?: string | null;
  /** อวตารท้ายคลิป (bookend-both) — จำเป็นตอน re-composite โหมดนั้น */
  tailAvatarUrl?: string | null;
```

(อัปเดตคอมเมนต์ shape v2 บรรทัด 48-49 ให้ตรงด้วย)

- [ ] **Step 2: orchestrator — เก็บค่าตอน avatar step + ใส่ใน preview**

บรรทัด 357-359 เปลี่ยนเป็น:

```ts
    let finalBase = baseUrl;
    let avatarModel = "none";
    let avatarVideoUrl: string | null = null;
    let tailAvatarUrl: string | null = null;
```

ในบล็อก `if (input.avatarMode)` หลัง `avatarVideoUrl = av.avatarUrl;` (บรรทัด ~374) เพิ่ม:

```ts
      tailAvatarUrl = av.tailAvatarUrl ?? null;
```

ใน `finishJob` preview object (บรรทัด 390-401) เพิ่มหลัง `avatarVideoUrl,`:

```ts
          avatarModel,
          avatarVideoUrl,
          // ข้อมูล re-composite (จอแต่งซับปรับตำแหน่งอวตารได้โดยไม่เรียก HeyGen ใหม่)
          avatarMode: input.avatarMode ?? null,
          avatarIntroSecs: input.avatarIntroSecs ?? 5,
          avatarTailSecs: input.avatarTailSecs ?? 5,
          compositeBaseUrl: input.avatarMode ? baseUrl : null,
          tailAvatarUrl,
```

- [ ] **Step 3: verify script — parser รับ field ใหม่ + งานเก่าไม่พัง**

Create `scripts/verify-v2-preview-output.ts`:

```ts
// verify-v2-preview-output.ts — parseVideoJobOutput: v2 ใหม่มี field re-composite ครบ,
// v2 เก่า (ไม่มี field) และ v1 ยังอ่านได้ (readers MUST accept both — ADR 0001)
// Run: npx tsx scripts/verify-v2-preview-output.ts
import { parseVideoJobOutput } from "../src/lib/mcp/video-job";

let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) fail++;
}

const newV2 = parseVideoJobOutput(JSON.stringify({
  version: 2, mode: "preview", videoUrl: "/api/renders/composite-1.mp4",
  preview: {
    captions: [], config: {}, voiceUrl: "/api/renders/tts.mp3", audioDurationMs: 10000,
    avatarModel: "avat_1", avatarVideoUrl: "https://files.heygen.ai/a.mp4",
    avatarMode: "bookend", avatarIntroSecs: 5, avatarTailSecs: 5,
    compositeBaseUrl: "/api/renders/base-1.mp4", tailAvatarUrl: null,
  },
}));
check("new v2: compositeBaseUrl present", newV2?.preview?.compositeBaseUrl === "/api/renders/base-1.mp4");
check("new v2: avatarMode present", newV2?.preview?.avatarMode === "bookend");
check("new v2: intro/tail secs", newV2?.preview?.avatarIntroSecs === 5 && newV2?.preview?.avatarTailSecs === 5);

const oldV2 = parseVideoJobOutput(JSON.stringify({
  version: 2, mode: "preview", videoUrl: "/api/renders/x.mp4",
  preview: { captions: [], config: {}, voiceUrl: "/v.mp3", audioDurationMs: 1, avatarModel: "none", avatarVideoUrl: null },
}));
check("old v2: parses fine", oldV2?.version === 2 && !!oldV2.preview);
check("old v2: new fields undefined", oldV2?.preview?.compositeBaseUrl === undefined && oldV2?.preview?.tailAvatarUrl === undefined);

const v1 = parseVideoJobOutput(JSON.stringify({ videoUrl: "/api/renders/y.mp4", videoId: "vid1" }));
check("v1: parses fine", v1?.version === 1 && v1.videoUrl === "/api/renders/y.mp4");
check("garbage: null", parseVideoJobOutput("{not json") === null);

process.exit(fail ? 1 : 0);
```

Run: `npx tsx scripts/verify-v2-preview-output.ts`
Expected: PASS 7 บรรทัด, exit 0

- [ ] **Step 4: Build-verify (แตะ render backend)**

Run: `npm run build`
Expected: build ผ่าน (worker import ไฟล์นี้ — ธรรมเนียม build-verify ก่อน merge)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/video-job.ts src/lib/mcp/orchestrator.ts scripts/verify-v2-preview-output.ts
git commit -m "feat(worker): persist re-composite inputs (base url, tail avatar, mode/secs) in v2 preview output"
```

---

### Task 7: PATCH /api/videos/jobs/[id] — persist videoUrl หลัง re-composite

**Files:**
- Modify: `src/app/api/videos/jobs/[id]/route.ts` (เพิ่ม PATCH)

**Interfaces:**
- Consumes: `prisma.videoJob` (`outputJson` string), owner check pattern เดียวกับ GET (`route.ts:14`)
- Produces: `PATCH /api/videos/jobs/[id]` body `{videoUrl: string}` — เฉพาะเจ้าของ + status done + videoUrl ขึ้นต้น `/api/renders/` → อัปเดต `outputJson.videoUrl` · Task 8 เรียกหลัง composite สำเร็จ เพื่อให้ resume งาน (ยังไม่ export) เห็นวิดีโอตำแหน่งใหม่

- [ ] **Step 1: เพิ่ม PATCH handler**

เพิ่มท้าย `src/app/api/videos/jobs/[id]/route.ts`:

```ts
// PATCH /api/videos/jobs/[id] — จอแต่งซับ re-composite อวตารแล้วบันทึก videoUrl ใหม่ลง output
// (ไม่งั้น resume งานที่ยังไม่ export จะเห็นวิดีโอตำแหน่งเก่า) · เจ้าของ + done เท่านั้น ·
// รับเฉพาะไฟล์ใน /api/renders/ (กัน URL ภายนอก/path แปลก)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl : "";
    if (!/^\/api\/renders\/[\w.-]+$/.test(videoUrl)) {
      return NextResponse.json({ error: "bad_video_url" }, { status: 400 });
    }

    const job = await prisma.videoJob.findFirst({ where: { id, userId: user.id, status: "done" } });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let output: Record<string, unknown> = {};
    try { output = JSON.parse(job.outputJson ?? "{}") as Record<string, unknown>; } catch {}
    output.videoUrl = videoUrl;
    await prisma.videoJob.update({ where: { id: job.id }, data: { outputJson: JSON.stringify(output) } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/videos/jobs/:id] patch error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
```

- [ ] **Step 2: verify script — guard ของ PATCH**

Create `scripts/verify-v2-job-patch.ts` (pattern temp-DB เหมือน verify script อื่น — ใช้ regex + JSON merge logic ล้วน ไม่ต้องแตะ DB):

```ts
// verify-v2-job-patch.ts — PATCH jobs/[id]: url guard + merge outputJson ไม่ทำ field อื่นหาย
// Run: npx tsx scripts/verify-v2-job-patch.ts
const URL_RE = /^\/api\/renders\/[\w.-]+$/;

let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) fail++;
}

check("accepts renders file", URL_RE.test("/api/renders/composite-999-bookend.mp4"));
check("rejects external url", !URL_RE.test("https://evil.com/x.mp4"));
check("rejects traversal", !URL_RE.test("/api/renders/../../etc/passwd"));
check("rejects nested path", !URL_RE.test("/api/renders/a/b.mp4"));
check("rejects empty", !URL_RE.test(""));

// merge เดียวกับ route: parse → set videoUrl → stringify (preview ต้องคงอยู่)
const before = JSON.stringify({ version: 2, mode: "preview", videoUrl: "/api/renders/old.mp4", preview: { captions: [{ text: "a", startMs: 0, endMs: 1 }] } });
const output = JSON.parse(before) as Record<string, unknown>;
output.videoUrl = "/api/renders/new.mp4";
const after = JSON.parse(JSON.stringify(output)) as { videoUrl: string; preview?: { captions: unknown[] } };
check("videoUrl replaced", after.videoUrl === "/api/renders/new.mp4");
check("preview preserved", Array.isArray(after.preview?.captions) && after.preview.captions.length === 1);

process.exit(fail ? 1 : 0);
```

Run: `npx tsx scripts/verify-v2-job-patch.ts`
Expected: PASS 7 บรรทัด, exit 0

- [ ] **Step 3: Typecheck + Commit**

Run: `npx tsc --noEmit` → ผ่าน

```bash
git add src/app/api/videos/jobs/\[id\]/route.ts scripts/verify-v2-job-patch.ts
git commit -m "feat(editor-v2): PATCH job output videoUrl for post-recomposite persistence"
```

---

### Task 8: ปรับตำแหน่งอวตารหลังเรนเดอร์ (จอแต่งซับ) + re-composite ฟรี

**Files:**
- Create: `src/app/(dashboard)/video-editor/_v2/AvatarAdjustOverlay.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx` (ปุ่ม + state baseUrl + integration)

**Interfaces:**
- Consumes: `preview.avatarModel` (= avatarId), `preview.avatarVideoUrl`, `preview.avatarMode`, `preview.avatarIntroSecs/TailSecs`, `preview.compositeBaseUrl`, `preview.tailAvatarUrl` (Task 6) · `GET/PUT /api/avatar-presets/[avatarId]` body/response `{layout: {scale,offsetX,offsetY} | null}` · `POST /api/heygen/composite` body `{avatarVideoUrl, tailAvatarVideoUrl?, bgVideoUrl, mode:"chromakey", avatarTiming, avatarBookendSecs, avatarTailSecs, avatarLayout}` → `{videoUrl}` (`composite/route.ts:479-500`; ฟรี — `recordChargedClip` ภายในทำให้ burn ต่อไม่คิดเงิน `:590-593`) · `normalizedBox(layout)` (`src/lib/avatar-layout.ts:33`) · `PATCH /api/videos/jobs/[id]` (Task 7)
- Produces: `AvatarAdjustOverlay({avatarId, avatarMode, introSecs, tailSecs, avatarVideoUrl, tailAvatarUrl, bgVideoUrl, jobId, onDone, onClose})` — `onDone(newVideoUrl: string)` ให้ PostPhase สลับวิดีโอ

- [ ] **Step 1: สร้าง AvatarAdjustOverlay.tsx**

หมายเหตุพิกัด: layout space เดียวกับ v1 — `scale` 0.1..2.5, `offsetX/Y` หน่วย ±200 = ครึ่งหนึ่งของ ±400 space ใน `avatar-layout.ts` (ลาก nx∈[-1,1] × 200, ดู `OrderPanel.tsx:150-159`) · กล่อง preview วางด้วย `normalizedBox()` — สูตรเดียวกับ ffmpeg (`layoutGeometry`) เพราะแชร์ source เดียวกัน = WYSIWYG

```tsx
"use client";

/**
 * ปรับตำแหน่ง/สเกลอวตารหลังเรนเดอร์ (spec 07-03 ข้อ 1, ทางเลือก A) — ลากกล่องบน preview +
 * slider ซูม → (1) save preset ต่อ avatar (ครั้งหน้าเรนเดอร์ถูกตั้งแต่แรก) (2) re-composite
 * ฟรีบน base เดิมผ่าน /api/heygen/composite (ไม่เรียก HeyGen ใหม่) (3) PATCH videoUrl ลง job
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Move, RotateCcw } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnGhost, GroupLabel } from "./ui";
import { normalizedBox, type AvatarLayout } from "@/lib/avatar-layout";

const DEFAULT_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

export function AvatarAdjustOverlay({ avatarId, avatarMode, introSecs, tailSecs, avatarVideoUrl, tailAvatarUrl, bgVideoUrl, jobId, onDone, onClose }: {
  avatarId: string;
  avatarMode: string;              // full | bookend | bookend-both
  introSecs: number;
  tailSecs: number;
  avatarVideoUrl: string;
  tailAvatarUrl: string | null;
  bgVideoUrl: string;              // base render ก่อน composite (compositeBaseUrl)
  jobId: string | null;
  onDone: (newVideoUrl: string) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_LAYOUT);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ค่าเริ่มต้น = preset ที่บันทึกไว้ (ใกล้เคียงค่าที่งานนี้ใช้เรนเดอร์ที่สุด)
  useEffect(() => {
    let alive = true;
    fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.layout) setLayout(d.layout as AvatarLayout); })
      .catch(() => {});
    return () => { alive = false; };
  }, [avatarId]);

  const box = normalizedBox(layout);

  function onBoxPointerDown(e: React.PointerEvent) {
    if (busy) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.offsetX, origY: layout.offsetY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onBoxPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const frame = frameRef.current;
    if (!d || !frame) return;
    const rect = frame.getBoundingClientRect();
    // ลากเต็มกรอบ = ±200 หน่วย (สเปซเดียวกับ v1 OrderPanel: nx ±1 → ×200) · แกน y บวก = ลง
    const nx = ((e.clientX - d.startX) / rect.width) * 2 * 200;
    const ny = ((e.clientY - d.startY) / rect.height) * 2 * 200;
    setLayout((l) => ({
      ...l,
      offsetX: Math.max(-200, Math.min(200, Math.round(d.origX + nx))),
      offsetY: Math.max(-200, Math.min(200, Math.round(d.origY + ny))),
    }));
  }
  function onBoxPointerUp() { dragRef.current = null; }

  async function apply() {
    if (busy) return;
    setBusy(true);
    try {
      // 1) save preset ก่อน — ต่อให้ composite พังก็ยังได้ประโยชน์รอบหน้า (spec: error handling)
      await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });

      // 2) re-composite ฟรีบน base เดิม (ไม่เรียก HeyGen ใหม่)
      const res = await fetch("/api/heygen/composite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          avatarVideoUrl,
          ...(tailAvatarUrl ? { tailAvatarVideoUrl: tailAvatarUrl } : {}),
          bgVideoUrl,
          mode: "chromakey",
          avatarTiming: avatarMode,
          avatarBookendSecs: introSecs,
          avatarTailSecs: tailSecs,
          avatarLayout: layout,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.videoUrl) throw new Error(d?.error ?? `composite failed (${res.status})`);

      // 3) persist ลง job — resume งานที่ยังไม่ export จะเห็นตำแหน่งใหม่ (best-effort)
      if (jobId) {
        await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: d.videoUrl }),
        }).catch(() => {});
      }

      toast.success("ปรับตำแหน่งอวตารแล้ว — บันทึกเป็นค่าเริ่มต้นของอวตารนี้ให้ด้วย");
      onDone(d.videoUrl as string);
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : "re-composite ไม่สำเร็จ"} — ตำแหน่งถูกบันทึกไว้แล้ว จะถูกใช้ในการเรนเดอร์ครั้งหน้า`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col" style={{ borderRadius: radius.cardLg, overflow: "hidden" }}>
      {/* พื้นที่ลาก — ทับ preview ทั้งกรอบ */}
      <div ref={frameRef} className="relative flex-1" style={{ background: "rgba(10,10,16,.35)" }}>
        <div
          onPointerDown={onBoxPointerDown}
          onPointerMove={onBoxPointerMove}
          onPointerUp={onBoxPointerUp}
          className="absolute flex items-center justify-center"
          style={{
            left: `${box.centerXPct}%`, top: `${box.centerYPct}%`,
            width: `${box.widthPct}%`, height: `${box.heightPct}%`,
            transform: "translate(-50%,-50%)",
            border: `1.5px dashed ${color.primary300}`, borderRadius: 10,
            background: "rgba(139,92,246,.10)", cursor: busy ? "wait" : "move",
            touchAction: "none",
          }}
        >
          <span className="flex items-center gap-1" style={{ fontSize: 10.5, color: color.primary300, background: "rgba(10,10,16,.55)", padding: "3px 8px", borderRadius: 8 }}>
            <Move size={11} /> อวตาร — ลากเพื่อย้าย
          </span>
        </div>
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: "rgba(10,10,16,.66)" }}>
            <Loader2 size={22} className="animate-spin" color={color.primary300} />
            <span style={{ fontSize: 11.5, color: color.textSecondary }}>กำลังวางอวตารตำแหน่งใหม่… (~1-2 นาที ไม่คิดค่า HeyGen เพิ่ม)</span>
          </div>
        )}
      </div>

      {/* แถบคุมล่าง */}
      <div className="flex items-center gap-3 px-4 py-3" style={{ background: "rgba(10,10,16,.88)", borderTop: `1px solid ${color.cardBorder}` }}>
        <GroupLabel>ขนาด</GroupLabel>
        <input
          type="range" min={0.1} max={2.5} step={0.05} value={layout.scale}
          disabled={busy}
          onChange={(e) => setLayout((l) => ({ ...l, scale: Number(e.target.value) }))}
          className="flex-1"
          style={{ accentColor: color.primary500 }}
        />
        <span style={{ fontSize: 11, color: color.textSecondary, fontVariantNumeric: "tabular-nums", width: 38 }}>{layout.scale.toFixed(2)}×</span>
        <button onClick={() => setLayout(DEFAULT_LAYOUT)} disabled={busy} title="รีเซ็ต" className="flex items-center gap-1" style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer", fontSize: 11 }}>
          <RotateCcw size={11} /> รีเซ็ต
        </button>
        <BtnGhost onClick={onClose} disabled={busy} style={{ padding: "8px 14px" }}>ยกเลิก</BtnGhost>
        <BtnPrimary onClick={() => void apply()} disabled={busy} style={{ padding: "8px 16px", ...(busy ? { opacity: 0.7, cursor: "wait" } : {}) }}>
          {busy ? "กำลังประมวลผล…" : "ใช้ตำแหน่งนี้"}
        </BtnPrimary>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: PostPhase — state baseUrl + ปุ่มเปิดโหมดปรับ**

เปลี่ยน `const baseUrl = job.output?.videoUrl ?? "";` (บรรทัด 42) เป็น state (re-composite แล้วสลับไฟล์ได้):

```ts
  const [baseUrl, setBaseUrl] = useState(job.output?.videoUrl ?? "");
```

เพิ่ม state + เงื่อนไขโชว์ปุ่ม (ใต้ `const [playing, ...]`):

```ts
  const [adjustingAvatar, setAdjustingAvatar] = useState(false);
  // ปรับได้เมื่องานนี้มีอวตาร + worker เก็บข้อมูล re-composite ไว้ (งานเก่าก่อนฟีเจอร์นี้ = ซ่อน)
  // bookend-both ต้องมี tailAvatarUrl ด้วย ไม่งั้น composite split ขาดท่อน
  const canAdjustAvatar = !!(
    preview?.avatarModel && preview.avatarModel !== "none" &&
    preview.avatarVideoUrl && preview.compositeBaseUrl && preview.avatarMode &&
    (preview.avatarMode !== "bookend-both" || preview.tailAvatarUrl)
  );
```

เพิ่ม import:

```ts
import { AvatarAdjustOverlay } from "./AvatarAdjustOverlay";
```

ในกล่อง preview (div `className="relative"` บรรทัด ~307) เพิ่ม overlay ก่อนบล็อก burning spinner:

```tsx
            {adjustingAvatar && canAdjustAvatar && preview && (
              <AvatarAdjustOverlay
                avatarId={preview.avatarModel!}
                avatarMode={preview.avatarMode!}
                introSecs={preview.avatarIntroSecs ?? 5}
                tailSecs={preview.avatarTailSecs ?? 5}
                avatarVideoUrl={preview.avatarVideoUrl!}
                tailAvatarUrl={preview.tailAvatarUrl ?? null}
                bgVideoUrl={preview.compositeBaseUrl!}
                jobId={job.jobId}
                onClose={() => setAdjustingAvatar(false)}
                onDone={(url) => {
                  setBaseUrl(url);
                  setAdjustingAvatar(false);
                  const v = videoRef.current;
                  if (v) { v.load(); v.currentTime = 0; }
                }}
              />
            )}
```

เข้าโหมดปรับ = pause + กลับไปต้นคลิป (อวตารเห็นชัดที่ t=0 ทุกโหมด) — เพิ่มปุ่มในแผงขวา ก่อน section "ความยาวการ์ดซับ" (บรรทัด ~340):

```tsx
          {canAdjustAvatar && (
            <section className="flex flex-col gap-2">
              <GroupLabel>อวตาร</GroupLabel>
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) { v.pause(); v.currentTime = 0; }
                  setAdjustingAvatar(true);
                }}
                className="flex items-center justify-center gap-2"
                style={{
                  padding: "9px 0", borderRadius: radius.control, background: "none",
                  border: `1px solid ${color.cardBorder}`, color: color.textSecondary,
                  fontSize: 12, cursor: "pointer",
                }}
              >
                ปรับตำแหน่งอวตาร (ฟรี — ไม่เรียก HeyGen ใหม่)
              </button>
            </section>
          )}
```

หมายเหตุ: ซับที่แก้ค้าง (`captions/overrides/cfg`) เป็น state ฝั่ง client อยู่แล้ว — การสลับ `baseUrl` ไม่แตะมัน (spec: "ซับที่แก้ค้างไว้ต้องไม่หาย") · `exportVideo` ใช้ `baseUrl` state → export หลังปรับ = ได้ไฟล์ตำแหน่งใหม่อัตโนมัติ

- [ ] **Step 3: Typecheck + Build**

Run: `npx tsc --noEmit` แล้ว `npm run build`
Expected: ผ่านทั้งคู่

- [ ] **Step 4: ตรวจด้วยมือ e2e (ต้องมี HeyGen key + งบวินาที)**

dev: เรนเดอร์งานมีอวตาร bookend (user ที่ไม่มี preset — ลบแถว `avatarPreset` ใน dev.db ก่อนถ้าจำเป็น) → จอแต่งซับมีปุ่ม "ปรับตำแหน่งอวตาร" → เข้าโหมด ลากกล่อง+ซูม → ใช้ตำแหน่งนี้ → รอ composite → preview เปลี่ยนเป็นตำแหน่งใหม่ ซับที่แก้ไว้ยังอยู่ → export → ไฟล์สุดท้ายตำแหน่งใหม่ → เช็ค `avatarPreset` มีแถวใหม่ → เรนเดอร์งานถัดไปด้วย avatar เดิม → ตำแหน่งถูกตั้งแต่แรก · งานเก่า (ก่อน Task 6) → ไม่มีปุ่ม

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/video-editor/_v2/AvatarAdjustOverlay.tsx src/app/\(dashboard\)/video-editor/_v2/PostPhase.tsx
git commit -m "feat(editor-v2): post-render avatar position adjust with free re-composite + preset autosave"
```

---

### Task 9: Final verification + PR

- [ ] **Step 1: รัน verify scripts ทั้งหมดของงานนี้**

Run: `npx tsx scripts/verify-v2-bgm-path.ts && npx tsx scripts/verify-v2-preview-output.ts && npx tsx scripts/verify-v2-job-patch.ts`
Expected: exit 0 ทุกตัว

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: ผ่าน

- [ ] **Step 3: Browser QA รวบยอด (v2 + v1 regression)**

- v2 ครบ flow: script → เรนเดอร์ (เลือกเพลงจาก modal) → แต่งซับ (การ์ดตาม preview, waveform, ลาก ruler, ปรับอวตาร) → export → Gallery ชื่อถูก → refresh → เริ่มสด
- v1 (`?ui=v1`): เลือกเพลง/อัปโหลดเพลง, timeline highlight, avatar position save — ต้องไม่เปลี่ยน (แตะร่วมเฉพาะ `find-active-caption.ts` ที่คลาย type)

- [ ] **Step 4: เปิด PR**

```bash
git push -u origin mew/editor-v2-feedback-round1
gh pr create --title "Editor v2: feedback round 1 (export lifecycle, music library, waveform, card follow, scrub, avatar adjust)" --body "$(cat <<'EOF'
แก้ฟีดแบค 6 ข้อจากการใช้งาน v2 จริง (spec: docs/superpowers/specs/2026-07-03-editor-v2-feedback-round1-design.md)

1. อวตารครั้งแรกตำแหน่งเพี้ยน → ปุ่มปรับตำแหน่งหลังเรนเดอร์ + re-composite ฟรี + save preset อัตโนมัติ
2. เพลงมีให้เลือกน้อย → modal คลังเพลงเต็ม (ค้นหา/แท็บระบบ-ของฉัน/อัปโหลด)
3. ไม่มี waveform → เลนเสียงพูด + snap ขอบซับเข้าจุดเปลี่ยนเสียง
4. การ์ดซับไม่ตาม preview → highlight + auto-scroll + ปุ่มกลับมาตาม
5. Untitled + งานค้าง → ชื่อจากสคริปต์ + success screen + ออกแล้วกลับมาเริ่มสด
6. timeline เลื่อนไม่ได้ → ruler ลาก scrub ได้

⚠️ deploy: มีการแก้ orchestrator (Task 6) — ต้อง restart render worker (`pm2 restart mcp-video-worker --update-env`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## หมายเหตุ deploy (หลัง merge)

- worker เปลี่ยน (Task 6) → หลัง `bash deploy/deploy.sh` ต้อง restart PM2 app ของ render worker ด้วย (deploy.sh restart เฉพาะ `ai-content`)
- ฟีเจอร์ทั้งหมดโชว์เฉพาะเมื่อ `NEXT_PUBLIC_EDITOR_V2=1` (ยัง dormant บน prod จนกว่า Mew จะ flip ตาม launch runbook เดิม)
