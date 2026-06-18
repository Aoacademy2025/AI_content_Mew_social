# Key Onboarding + Settings API-Keys Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ผู้ใช้ตั้ง Gemini + B-roll key ได้ง่ายและ proactive (แก้ 72% paid ไม่มีคีย์) ผ่าน welcome wizard + dashboard checklist + create-video pre-check และ redesign หน้า Settings → API Keys ให้จัดกลุ่มตามความจำเป็น โดยใช้โมเดล/คอมโพเนนต์ร่วมกัน

**Architecture:** source-of-truth เดียว `src/lib/key-tiers.ts` (นิยาม tier + copy + สถานะ) → render โดย `<ApiKeyField>` ที่ใช้ซ้ำทั้ง Wizard และ Settings; สถานะคีย์มาจาก endpoint ใหม่ที่คืน boolean เท่านั้น; reuse `test-key`/`api-keys`/`ApiKeyModal` เดิม; non-forcing (ข้ามได้ทุกจุด)

**Tech Stack:** Next.js 15 (App Router) + React 19 + TypeScript, Tailwind v4, lucide-react, sonner (toast), Prisma 6 (SQLite), Clerk auth (`getCurrentUser`)

## Global Constraints
- **ห้ามคืนค่า API key จริงไปที่ surface ใหม่** — status endpoint คืนเฉพาะ boolean (กันคีย์รั่ว). `GET /api/user/api-keys` เดิม (คืนค่า decrypt) ใช้เฉพาะหน้า Settings ที่ auth แล้ว
- **Tier-1 complete** = `gemini === true && (pexels === true || pixabay === true)` — นิยามเดียว ใช้ทุกที่
- **Non-forcing** — ทุก surface ต้องมีทางข้าม/ปิดได้เสมอ ไม่ hard-gate
- **Copy ภาษาไทย** ต่อคีย์ มาจาก `KEY_TIERS` ที่เดียว (ห้าม hardcode ซ้ำในหลายไฟล์)
- **fail-open** — ถ้า status endpoint ล่ม ห้าม block การใช้งาน (ถือว่าไม่ขึ้น checklist)
- ตาม pattern เดิม: keys ถูก base64-encode ก่อนเก็บ (route `api-keys` จัดการให้แล้ว); test ผ่าน `POST /api/user/test-key` body `{ keyType }`
- ทดสอบ logic ด้วย verify script (`scripts/verify-*.ts` รันด้วย `npx tsx`) — repo นี้ไม่มี jest/component runner; UI tasks ยืนยันด้วย `npx tsc --noEmit` + manual QA
- **อย่าแตะ render/pipeline backend** — งานนี้อยู่ฝั่ง settings/dashboard/onboarding เท่านั้น

---

## File Structure

| ไฟล์ | สร้าง/แก้ | หน้าที่ |
|---|---|---|
| `src/lib/key-tiers.ts` | สร้าง | นิยาม tier + copy + `computeKeyStatus()` + `isTier1Complete()` — source of truth |
| `scripts/verify-key-tiers.ts` | สร้าง | ทดสอบ logic ใน key-tiers |
| `prisma/schema.prisma` | แก้ | เพิ่ม `User.onboardingDismissedAt DateTime?` |
| `src/app/api/user/api-keys/status/route.ts` | สร้าง | `GET` คืน boolean สถานะคีย์ + `onboardingDismissedAt` |
| `src/app/api/user/onboarding/dismiss/route.ts` | สร้าง | `POST` set `onboardingDismissedAt = now` |
| `src/components/onboarding/ApiKeyField.tsx` | สร้าง | field ร่วม (label + desc + input + test + status) |
| `src/components/onboarding/KeyOnboardingWizard.tsx` | สร้าง | modal stepper |
| `src/components/onboarding/KeySetupChecklist.tsx` | สร้าง | การ์ด dashboard / แถบสถานะ |
| `src/components/settings/api-key-settings.tsx` | แก้ | จัดกลุ่ม 3 ชั้น + ใช้ `<ApiKeyField>` + status bar |
| `src/app/(dashboard)/dashboard/page.tsx` | แก้ | mount checklist + wizard (first-login) |
| `src/app/(dashboard)/video-editor/page.tsx` + `video-creator/page.tsx` | แก้ | pre-check ก่อนสร้าง |

---

## Task 1: Key-tiers model + status logic (pure, TDD)

**Files:**
- Create: `src/lib/key-tiers.ts`
- Test: `scripts/verify-key-tiers.ts`

**Interfaces:**
- Produces:
  - `type KeyId = "gemini" | "pexels" | "pixabay" | "elevenlabs" | "heygen"`
  - `type KeyTier = "required" | "advanced"`
  - `interface KeyDef { id: KeyId; apiKeysField: "geminiKey"|"pexelsKey"|"pixabayKey"|"elevenlabsKey"|"heygenKey"; testKeyType: string; tier: KeyTier; group: "gemini"|"stock"|"voice"|"avatar"; label: string; desc: string; skipNote?: string; getUrl: string; free: boolean }`
  - `const KEY_TIERS: KeyDef[]`
  - `type KeyStatus = Record<KeyId, boolean> & { tier1Complete: boolean }`
  - `function computeKeyStatus(present: Partial<Record<KeyId, boolean>>): KeyStatus`
  - `function isTier1Complete(s: Pick<KeyStatus,"gemini"|"pexels"|"pixabay">): boolean`

- [ ] **Step 1: Write the failing test** — `scripts/verify-key-tiers.ts`

```ts
import { KEY_TIERS, computeKeyStatus, isTier1Complete, type KeyId } from "../src/lib/key-tiers";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

// every key has non-empty label, desc, getUrl
check("all keys have label/desc/getUrl", KEY_TIERS.every(k => k.label && k.desc && k.getUrl));
// required tier is exactly gemini + pexels + pixabay; advanced is elevenlabs + heygen
const required = KEY_TIERS.filter(k => k.tier === "required").map(k => k.id).sort();
const advanced = KEY_TIERS.filter(k => k.tier === "advanced").map(k => k.id).sort();
check("required = gemini,pexels,pixabay", JSON.stringify(required) === JSON.stringify(["gemini","pexels","pixabay"]));
check("advanced = elevenlabs,heygen", JSON.stringify(advanced) === JSON.stringify(["elevenlabs","heygen"]));
// advanced keys carry a skipNote ("ไม่ใส่ก็ใช้งานได้")
check("advanced keys have skipNote", KEY_TIERS.filter(k => k.tier === "advanced").every(k => !!k.skipNote));

// tier1Complete logic: needs gemini AND (pexels OR pixabay)
check("tier1 false when no gemini", isTier1Complete({ gemini: false, pexels: true, pixabay: true }) === false);
check("tier1 false when no stock", isTier1Complete({ gemini: true, pexels: false, pixabay: false }) === false);
check("tier1 true gemini+pexels", isTier1Complete({ gemini: true, pexels: true, pixabay: false }) === true);
check("tier1 true gemini+pixabay", isTier1Complete({ gemini: true, pexels: false, pixabay: true }) === true);

// computeKeyStatus fills all ids + tier1Complete
const st = computeKeyStatus({ gemini: true, pixabay: true });
check("computeKeyStatus defaults missing to false", st.pexels === false && st.elevenlabs === false && st.heygen === false);
check("computeKeyStatus tier1Complete true", st.tier1Complete === true);

console.log(failures === 0 ? "\n✅ ALL KEY-TIERS CHECKS PASSED" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-key-tiers.ts`
Expected: FAIL — `Cannot find module '../src/lib/key-tiers'`

- [ ] **Step 3: Write `src/lib/key-tiers.ts`**

```ts
export type KeyId = "gemini" | "pexels" | "pixabay" | "elevenlabs" | "heygen";
export type KeyTier = "required" | "advanced";
export type ApiKeysField = "geminiKey" | "pexelsKey" | "pixabayKey" | "elevenlabsKey" | "heygenKey";

export interface KeyDef {
  id: KeyId;
  apiKeysField: ApiKeysField;
  testKeyType: string;          // body.keyType สำหรับ POST /api/user/test-key
  tier: KeyTier;
  group: "gemini" | "stock" | "voice" | "avatar";
  label: string;
  desc: string;                 // คำอธิบาย 1 บรรทัด (ภาษาคน)
  skipNote?: string;            // ป้าย "ไม่ใส่ก็ใช้งานได้" สำหรับ tier advanced
  getUrl: string;
  free: boolean;
}

export const KEY_TIERS: KeyDef[] = [
  {
    id: "gemini", apiKeysField: "geminiKey", testKeyType: "gemini",
    tier: "required", group: "gemini",
    label: "Gemini API Key",
    desc: "สมองของระบบ — เขียน/วิเคราะห์สคริปต์, เสียงพากย์ AI และหาคีย์เวิร์ด B-roll",
    getUrl: "https://aistudio.google.com/app/apikey", free: true,
  },
  {
    id: "pexels", apiKeysField: "pexelsKey", testKeyType: "pexels",
    tier: "required", group: "stock",
    label: "Pexels API Key",
    desc: "คลังวิดีโอ B-roll ฟรี — ไม่มี B-roll = วิดีโอไม่มีภาพประกอบ",
    getUrl: "https://www.pexels.com/api/", free: true,
  },
  {
    id: "pixabay", apiKeysField: "pixabayKey", testKeyType: "pixabay",
    tier: "required", group: "stock",
    label: "Pixabay API Key",
    desc: "คลังวิดีโอ B-roll ฟรี (อีกแหล่ง) — มี Pexels หรือ Pixabay อย่างน้อย 1 ก็พอ",
    getUrl: "https://pixabay.com/api/docs/", free: true,
  },
  {
    id: "elevenlabs", apiKeysField: "elevenlabsKey", testKeyType: "elevenlabs",
    tier: "advanced", group: "voice",
    label: "ElevenLabs API Key",
    desc: "เสียงพากย์โคลน/พรีเมียม",
    skipNote: "ไม่ใส่ก็ใช้งานได้ — ระบบใช้เสียง Gemini แทน",
    getUrl: "https://elevenlabs.io/app/settings/api-keys", free: false,
  },
  {
    id: "heygen", apiKeysField: "heygenKey", testKeyType: "heygen",
    tier: "advanced", group: "avatar",
    label: "HeyGen API Key",
    desc: "พิธีกร AI (avatar) ในคลิป",
    skipNote: "ไม่ใส่ก็ใช้งานได้ — คลิปจะเป็นเสียง + ภาพ B-roll ปกติ",
    getUrl: "https://app.heygen.com/settings?nav=API", free: false,
  },
];

export type KeyStatus = Record<KeyId, boolean> & { tier1Complete: boolean };

export function isTier1Complete(s: { gemini: boolean; pexels: boolean; pixabay: boolean }): boolean {
  return s.gemini && (s.pexels || s.pixabay);
}

export function computeKeyStatus(present: Partial<Record<KeyId, boolean>>): KeyStatus {
  const base = {
    gemini: !!present.gemini, pexels: !!present.pexels, pixabay: !!present.pixabay,
    elevenlabs: !!present.elevenlabs, heygen: !!present.heygen,
  };
  return { ...base, tier1Complete: isTier1Complete(base) };
}

export const REQUIRED_KEYS = KEY_TIERS.filter((k) => k.tier === "required");
export const ADVANCED_KEYS = KEY_TIERS.filter((k) => k.tier === "advanced");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-key-tiers.ts`
Expected: PASS — `✅ ALL KEY-TIERS CHECKS PASSED`

- [ ] **Step 5: Commit**

```bash
git add src/lib/key-tiers.ts scripts/verify-key-tiers.ts
git commit -m "feat(onboarding): key-tiers model + status logic (Task 1)"
```

---

## Task 2: Schema field + status & dismiss endpoints

**Files:**
- Modify: `prisma/schema.prisma` (User model)
- Create: `src/app/api/user/api-keys/status/route.ts`
- Create: `src/app/api/user/onboarding/dismiss/route.ts`

**Interfaces:**
- Consumes: `computeKeyStatus` (Task 1), `getCurrentUser` (`@/lib/clerk-auth`), `prisma` (`@/lib/prisma`)
- Produces:
  - `GET /api/user/api-keys/status` → `{ gemini, pexels, pixabay, elevenlabs, heygen, tier1Complete, onboardingDismissed: boolean }`
  - `POST /api/user/onboarding/dismiss` → `{ ok: true }`

- [ ] **Step 1: Add the schema field**

In `prisma/schema.prisma`, inside `model User { ... }`, add near the other optional scalar fields (e.g. after `planExpiresAt DateTime?`):

```prisma
  onboardingDismissedAt DateTime?
```

- [ ] **Step 2: Apply schema + regenerate client**

Run: `npm run db:migrate` (local dev) — or if that prompts, `npx prisma db push`
Then: `npx prisma generate`
Expected: client regenerated; no error. (On prod, deploy.sh runs `prisma db push` — additive, safe.)

- [ ] **Step 3: Create the status route** — `src/app/api/user/api-keys/status/route.ts`

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { computeKeyStatus } from "@/lib/key-tiers";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        geminiKey: true, pexelsKey: true, pixabayKey: true, elevenlabsKey: true, heygenKey: true,
        onboardingDismissedAt: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const present = (v: string | null) => !!(v && v.length > 0);
    const status = computeKeyStatus({
      gemini: present(user.geminiKey), pexels: present(user.pexelsKey), pixabay: present(user.pixabayKey),
      elevenlabs: present(user.elevenlabsKey), heygen: present(user.heygenKey),
    });
    return NextResponse.json({ ...status, onboardingDismissed: user.onboardingDismissedAt != null });
  } catch (error) {
    return apiError({ route: "user/api-keys/status", error });
  }
}
```

- [ ] **Step 4: Create the dismiss route** — `src/app/api/user/onboarding/dismiss/route.ts`

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function POST() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await prisma.user.update({ where: { id: authUser.id }, data: { onboardingDismissedAt: new Date() } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "user/onboarding/dismiss", error });
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors (status/dismiss routes compile; `onboardingDismissedAt` recognized after `prisma generate`)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/app/api/user/api-keys/status/route.ts src/app/api/user/onboarding/dismiss/route.ts
git commit -m "feat(onboarding): key-status + dismiss endpoints + onboardingDismissedAt (Task 2)"
```

---

## Task 3: `<ApiKeyField>` shared component

**Files:**
- Create: `src/components/onboarding/ApiKeyField.tsx`

**Interfaces:**
- Consumes: `KeyDef` (Task 1), `POST /api/user/test-key`
- Produces: `ApiKeyField` (named export) with props:
  `{ def: KeyDef; value: string; isSaved: boolean; onChange: (value: string) => void; onTest: () => Promise<void>; testResult: { ok: boolean; message: string } | null; testing: boolean; onDelete?: () => void }`

Reuse the exact field markup from `src/components/settings/api-key-settings.tsx:160-217` but parameterized by `def`. Show `def.desc` under the label, and `def.skipNote` (amber, small) when present.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { Input } from "@/components/ui/input";
import { CheckCircle2, XCircle, Loader2, Eye, EyeOff, FlaskConical, Trash2, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { KeyDef } from "@/lib/key-tiers";

export function ApiKeyField({
  def, value, isSaved, onChange, onTest, testResult, testing, onDelete,
}: {
  def: KeyDef;
  value: string;
  isSaved: boolean;
  onChange: (value: string) => void;
  onTest: () => Promise<void> | void;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
  onDelete?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{def.label}</label>
          <a href={def.getUrl} target="_blank" rel="noopener noreferrer"
            className="transition-colors hover:text-cyan-400" style={{ color: "var(--ui-text-muted)" }}>
            <ExternalLink className="h-3 w-3" />
          </a>
          {def.free && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 bg-emerald-500/10">ฟรี</span>}
        </div>
        {isSaved && !testResult
          ? <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-400" style={{ background: "hsl(142 72% 29% / 0.15)", border: "1px solid hsl(142 72% 29% / 0.3)" }}>ตั้งแล้ว</span>
          : !isSaved && !testResult
          ? <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-slate-400 bg-white/5">ยังไม่ตั้ง</span>
          : null}
        {testResult?.ok && <span className="flex items-start gap-1 text-xs text-green-400"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="leading-snug">{testResult.message}</span></span>}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>{def.desc}</p>
      {def.skipNote && <p className="text-[11px] leading-relaxed text-amber-300/80">↪ {def.skipNote}</p>}
      {testResult && !testResult.ok && (
        <div className="flex items-start gap-1.5 text-xs text-red-400 px-2 py-1.5 rounded-lg bg-red-500/5 border border-red-500/20">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="leading-snug">{testResult.message}</span>
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`วาง ${def.label}...`}
            className="border-0 pr-16 font-mono text-xs focus-visible:ring-1 focus-visible:ring-cyan-500/50"
            style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
            <button type="button" onClick={() => setShow((v) => !v)} className="transition-colors hover:text-cyan-400" style={{ color: "var(--ui-text-muted)" }}>
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            {isSaved && onDelete && (
              <button type="button" onClick={onDelete} className="transition-colors hover:text-red-400" style={{ color: "var(--ui-text-muted)" }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <button type="button" disabled={!value || testing} onClick={() => onTest()}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all hover:opacity-80 disabled:opacity-30"
          style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          ทดสอบ
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/components/onboarding/ApiKeyField.tsx
git commit -m "feat(onboarding): shared ApiKeyField component (Task 3)"
```

---

## Task 4: `<KeySetupChecklist>` component (dashboard card)

**Files:**
- Create: `src/components/onboarding/KeySetupChecklist.tsx`

**Interfaces:**
- Consumes: `KeyStatus` (Task 1), status endpoint (Task 2)
- Produces: `KeySetupChecklist` with props `{ status: KeyStatus; onSetup: () => void }`. Renders nothing when `status.tier1Complete` is true.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { CheckCircle2, Circle, KeyRound, ArrowRight } from "lucide-react";
import type { KeyStatus } from "@/lib/key-tiers";

export function KeySetupChecklist({ status, onSetup }: { status: KeyStatus; onSetup: () => void }) {
  if (status.tier1Complete) return null;
  const stockDone = status.pexels || status.pixabay;
  const doneCount = (status.gemini ? 1 : 0) + (stockDone ? 1 : 0);

  const Row = ({ done, label }: { done: boolean; label: string }) => (
    <div className="flex items-center gap-2 text-sm">
      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" /> : <Circle className="h-4 w-4 text-slate-500 shrink-0" />}
      <span className={done ? "text-slate-400 line-through" : "text-slate-200"}>{label}</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-sky-400/25 bg-gradient-to-r from-sky-500/10 to-transparent p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-sky-300" />
          <span className="text-sm font-semibold text-white">ตั้งค่าให้พร้อมสร้างวิดีโอ ({doneCount}/2)</span>
        </div>
        <button type="button" onClick={onSetup}
          className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/15">
          ตั้งค่า <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        <Row done={status.gemini} label="Gemini key (จำเป็น)" />
        <Row done={stockDone} label="Pexels หรือ Pixabay — B-roll (จำเป็น)" />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">ขั้นสูง (ไม่บังคับ): ElevenLabs · HeyGen — ไม่ใส่ก็ใช้งานได้</p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + Commit**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

```bash
git add src/components/onboarding/KeySetupChecklist.tsx
git commit -m "feat(onboarding): KeySetupChecklist dashboard card (Task 4)"
```

---

## Task 5: `<KeyOnboardingWizard>` component (stepper modal)

**Files:**
- Create: `src/components/onboarding/KeyOnboardingWizard.tsx`

**Interfaces:**
- Consumes: `KEY_TIERS`, `REQUIRED_KEYS`, `ADVANCED_KEYS`, `KeyDef` (Task 1); `ApiKeyField` (Task 3); `PUT /api/user/api-keys`, `POST /api/user/test-key`
- Produces: `KeyOnboardingWizard` with props `{ open: boolean; onClose: () => void; onComplete: () => void; startKeyId?: import("@/lib/key-tiers").KeyId }`. On close via "ข้ามก่อน" it calls `POST /api/user/onboarding/dismiss` then `onClose()`. On finishing it `PUT`s all entered keys, then `onComplete()`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { X, ExternalLink, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { REQUIRED_KEYS, ADVANCED_KEYS, KEY_TIERS, type KeyId } from "@/lib/key-tiers";
import { ApiKeyField } from "./ApiKeyField";

type TestResult = { ok: boolean; message: string } | null;

export function KeyOnboardingWizard({
  open, onClose, onComplete, startKeyId,
}: { open: boolean; onClose: () => void; onComplete: () => void; startKeyId?: KeyId }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(startKeyId && ADVANCED_KEYS.some((k) => k.id === startKeyId)));

  if (!open) return null;

  function setValue(id: string, v: string) {
    setValues((p) => ({ ...p, [id]: v }));
    setResults((p) => ({ ...p, [id]: null }));
  }

  async function test(id: KeyId, testKeyType: string) {
    setTesting(id);
    try {
      // save first so the server can read the key, then test (test-key reads stored key)
      await fetch("/api/user/api-keys", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [KEY_TIERS.find((k) => k.id === id)!.apiKeysField]: values[id] ?? "" }),
      });
      const res = await fetch("/api/user/test-key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyType: testKeyType }),
      });
      setResults((p) => ({ ...p, [id]: await res.json() }));
    } catch {
      setResults((p) => ({ ...p, [id]: { ok: false, message: "เชื่อมต่อไม่สำเร็จ" } }));
    } finally {
      setTesting(null);
    }
  }

  async function saveAll() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const def of KEY_TIERS) {
        const v = values[def.id];
        if (v != null && v.length > 0) payload[def.apiKeysField] = v;
      }
      if (Object.keys(payload).length > 0) {
        await fetch("/api/user/api-keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      toast.success("บันทึก API key แล้ว");
      onComplete();
    } catch {
      toast.error("บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    try { await fetch("/api/user/onboarding/dismiss", { method: "POST" }); } catch { /* fail-open */ }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#0c1018] p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-sky-300" />
            <h2 className="text-lg font-semibold text-white">เริ่มต้นใช้ HERO AI</h2>
          </div>
          <button type="button" onClick={skip} className="text-slate-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-sm text-slate-400">ตั้งแค่ 2 อย่างก็เริ่มสร้างวิดีโอได้เลย</p>

        <div className="mt-5 space-y-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-sky-200">จำเป็น</div>
          {REQUIRED_KEYS.map((def) => (
            <ApiKeyField key={def.id} def={def} value={values[def.id] ?? ""} isSaved={false}
              onChange={(v) => setValue(def.id, v)} onTest={() => test(def.id, def.testKeyType)}
              testResult={results[def.id] ?? null} testing={testing === def.id} />
          ))}

          <button type="button" onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5">
            <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            ขั้นสูง (ไม่บังคับ) — ไม่ใส่ก็ใช้งานได้
          </button>
          {showAdvanced && ADVANCED_KEYS.map((def) => (
            <ApiKeyField key={def.id} def={def} value={values[def.id] ?? ""} isSaved={false}
              onChange={(v) => setValue(def.id, v)} onTest={() => test(def.id, def.testKeyType)}
              testResult={results[def.id] ?? null} testing={testing === def.id} />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={skip} className="text-sm text-slate-400 hover:text-white">ข้ามก่อน</button>
          <button type="button" onClick={saveAll} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} บันทึกแล้วเริ่มเลย
          </button>
        </div>
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300">
          ขอ Gemini key ฟรี <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + Commit**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

```bash
git add src/components/onboarding/KeyOnboardingWizard.tsx
git commit -m "feat(onboarding): KeyOnboardingWizard stepper modal (Task 5)"
```

---

## Task 6: Dashboard integration (checklist + first-login wizard)

**Files:**
- Modify: `src/app/(dashboard)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `GET /api/user/api-keys/status` (Task 2), `KeySetupChecklist` (Task 4), `KeyOnboardingWizard` (Task 5), `computeKeyStatus`/`KeyStatus` (Task 1)

> Note: ถ้า `dashboard/page.tsx` เป็น Server Component อยู่ ให้สร้าง client wrapper `src/components/onboarding/DashboardOnboarding.tsx` (`"use client"`) ที่ทำ fetch + state + render `<KeySetupChecklist>`/`<KeyOnboardingWizard>` แล้ว import มา render ในหน้า dashboard แทนการแปลงทั้งหน้าเป็น client.

- [ ] **Step 1: Create the client wrapper** — `src/components/onboarding/DashboardOnboarding.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";
import { KeySetupChecklist } from "./KeySetupChecklist";
import { KeyOnboardingWizard } from "./KeyOnboardingWizard";
import { computeKeyStatus, type KeyStatus } from "@/lib/key-tiers";

export function DashboardOnboarding() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/user/api-keys/status", { cache: "no-store" });
      if (!res.ok) return; // fail-open
      const data = await res.json();
      const st = computeKeyStatus(data);
      setStatus(st);
      // เด้ง wizard อัตโนมัติเฉพาะครั้งแรก: Tier-1 ยังไม่ครบ และยังไม่เคยกดข้าม
      if (!st.tier1Complete && !data.onboardingDismissed) setWizardOpen(true);
    } catch { /* fail-open */ }
  }
  useEffect(() => { void load(); }, []);

  if (!status) return null;
  return (
    <>
      <KeySetupChecklist status={status} onSetup={() => setWizardOpen(true)} />
      <KeyOnboardingWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={() => { setWizardOpen(false); void load(); }}
      />
    </>
  );
}
```

- [ ] **Step 2: Mount it on the dashboard**

In `src/app/(dashboard)/dashboard/page.tsx`, add import at top:
```tsx
import { DashboardOnboarding } from "@/components/onboarding/DashboardOnboarding";
```
Then render `<DashboardOnboarding />` near the top of the page's main content (above the existing usage/quick-action cards). Example — place it as the first child inside the page's main container `<div>`:
```tsx
<DashboardOnboarding />
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 4: Manual QA**

`npm run dev` → login as a user **without** Gemini key (QA rig per project notes) → expect wizard pops once; close → checklist card visible on dashboard; reload → wizard does NOT pop again (dismissed) but checklist stays. Set Gemini + a stock key → checklist disappears.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/DashboardOnboarding.tsx "src/app/(dashboard)/dashboard/page.tsx"
git commit -m "feat(onboarding): dashboard checklist + first-login wizard (Task 6)"
```

---

## Task 7: Settings → API Keys redesign

**Files:**
- Modify: `src/components/settings/api-key-settings.tsx`

**Interfaces:**
- Consumes: `KEY_TIERS`, `REQUIRED_KEYS`, `ADVANCED_KEYS`, `computeKeyStatus`, `isTier1Complete` (Task 1); `ApiKeyField` (Task 3)

Goal: keep the existing fetch/save/test/delete handlers and the Gemini collapsible guide, but (a) render fields via `<ApiKeyField>` driven by `KEY_TIERS`, (b) group into "จำเป็น" (gemini, then stock pair) and a collapsed "ขั้นสูง (ไม่บังคับ)" (elevenlabs, heygen), (c) add a status bar at top.

- [ ] **Step 1: Replace the `KEY_CONFIG` map render with grouped `<ApiKeyField>`**

Keep `apiKeys` state, `handleTestKey`, `handleSave`, `handleDelete`, `handleDiscard`, `updateKey`, `testResults`, `isSet`, and the Gemini guide block (lines ~99-153) unchanged. Replace the `{KEY_CONFIG.map(...)}` block (lines 155-218) with:

```tsx
{(() => {
  const status = computeKeyStatus({
    gemini: isSet("geminiKey"), pexels: isSet("pexelsKey"), pixabay: isSet("pixabayKey"),
    elevenlabs: isSet("elevenlabsKey"), heygen: isSet("heygenKey"),
  });
  const field = (id: KeyId) => {
    const def = KEY_TIERS.find((k) => k.id === id)!;
    return (
      <ApiKeyField
        key={def.id} def={def}
        value={apiKeys[def.apiKeysField] || ""}
        isSaved={isSet(def.apiKeysField)}
        onChange={(v) => updateKey(def.apiKeysField, v)}
        onTest={() => handleTestKey(def.testKeyType as KeyType)}
        testResult={testResults[def.testKeyType as KeyType]}
        testing={testingKey === (def.testKeyType as KeyType)}
        onDelete={() => handleDelete(def.apiKeysField)}
      />
    );
  };
  return (
    <>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium"
        style={{ color: status.tier1Complete ? "rgb(110 231 183)" : "rgb(252 211 77)" }}>
        {status.tier1Complete ? "✓ พร้อมสร้างวิดีโอ" : "ตั้งค่าจำเป็นให้ครบเพื่อเริ่มสร้างวิดีโอ"}
      </div>

      <div className="text-xs font-semibold uppercase tracking-wide text-sky-200">จำเป็น</div>
      {field("gemini")}
      {field("pexels")}
      {field("pixabay")}

      <button type="button" onClick={() => setAdvancedOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5">
        <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
        ขั้นสูง (ไม่บังคับ) — ไม่ใส่ก็ใช้งานได้
      </button>
      {advancedOpen && (<>{field("elevenlabs")}{field("heygen")}</>)}
    </>
  );
})()}
```

- [ ] **Step 2: Add imports + the `advancedOpen` state**

At top of `api-key-settings.tsx` add:
```tsx
import { KEY_TIERS, computeKeyStatus, type KeyId } from "@/lib/key-tiers";
import { ApiKeyField } from "@/components/onboarding/ApiKeyField";
```
Inside the component, add state:
```tsx
const [advancedOpen, setAdvancedOpen] = useState(false);
```
(`ChevronDown` is already imported.) `KeyType` type already exists in this file.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 4: Manual QA**

Settings → API Keys: order is Gemini → Pexels → Pixabay, advanced collapsed; each key shows its 1-line desc; status bar reflects tier-1; test/save/delete still work; Gemini guide still present.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/api-key-settings.tsx
git commit -m "feat(onboarding): regroup Settings API Keys by tier + shared field (Task 7)"
```

---

## Task 8: Create-video pre-check

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`
- Modify: `src/app/(dashboard)/video-creator/page.tsx`

**Interfaces:**
- Consumes: `GET /api/user/api-keys/status` (Task 2), `KeyOnboardingWizard` (Task 5), `computeKeyStatus` (Task 1)

Goal: before kicking off generation, check Tier-1; if incomplete, open the wizard instead of letting the pipeline 400. Keep the existing reactive `ApiKeyModal` flow as a fallback.

- [ ] **Step 1: Add wizard state + a guard helper in each page**

Add near the page component's other `useState`:
```tsx
const [keyWizardOpen, setKeyWizardOpen] = useState(false);
```
Add a guard run before the existing "create/run" handler body:
```tsx
async function ensureKeysReady(): Promise<boolean> {
  try {
    const res = await fetch("/api/user/api-keys/status", { cache: "no-store" });
    if (!res.ok) return true; // fail-open — let the existing reactive modal handle it
    const st = await res.json();
    if (!st.tier1Complete) { setKeyWizardOpen(true); return false; }
  } catch { return true; }
  return true;
}
```

- [ ] **Step 2: Call the guard at the top of the create/run handler**

In the handler that starts generation (the one that currently posts to the pipeline / opens render), make it the first line:
```tsx
if (!(await ensureKeysReady())) return;
```

- [ ] **Step 3: Render the wizard in each page's JSX**

```tsx
<KeyOnboardingWizard
  open={keyWizardOpen}
  onClose={() => setKeyWizardOpen(false)}
  onComplete={() => setKeyWizardOpen(false)}
/>
```
Add import:
```tsx
import { KeyOnboardingWizard } from "@/components/onboarding/KeyOnboardingWizard";
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 5: Manual QA**

As a user without keys: click "สร้างวิดีโอ" → wizard opens (no 400 error toast). Set keys → retry succeeds.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-creator/page.tsx"
git commit -m "feat(onboarding): create-video pre-check opens wizard (Task 8)"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run logic test**

Run: `npx tsx scripts/verify-key-tiers.ts` → `✅ ALL KEY-TIERS CHECKS PASSED`

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds (no type/lint blocker introduced)

- [ ] **Step 4: Manual end-to-end (QA rig / staging)**

1. New user, no keys → login → wizard pops → enter Gemini, click ทดสอบ → ✓ → enter Pexels → บันทึกแล้วเริ่ม → lands editor
2. Reload dashboard → checklist gone (tier-1 complete)
3. User with keys already → no wizard, no checklist; Settings shows "✓ พร้อมสร้างวิดีโอ", grouped, advanced collapsed
4. User dismisses wizard (ข้ามก่อน) → reload → wizard does not re-pop, checklist persists; clicking "สร้างวิดีโอ" re-opens wizard

- [ ] **Step 5: Open PR**

```bash
git push -u origin mew/key-onboarding
gh pr create --base main --title "feat(onboarding): key-onboarding flow + Settings API-keys redesign" --body "ดู KEY_ONBOARDING_REDESIGN.md — fixes 72% paid-no-Gemini-key. Non-forcing wizard + dashboard checklist + create-video pre-check + Settings regroup, shared key-tiers model. tsc 0-err, verify-key-tiers pass, build ok."
```

---

## Self-Review notes (done while writing)
- **Spec coverage:** 3-tier model → Task 1; status/dismiss/schema → Task 2; shared field → Task 3; checklist → Task 4; wizard → Task 5; dashboard mount + first-login → Task 6; Settings redesign → Task 7; pre-check → Task 8; verify/build → Task 9. ✓ all spec surfaces covered.
- **Type consistency:** `KeyDef.apiKeysField` / `testKeyType` used consistently across Tasks 3,5,7; `computeKeyStatus`/`KeyStatus`/`isTier1Complete` names stable across Tasks 1,2,4,6,8. ✓
- **No placeholders:** all steps carry real code/commands. Component tasks honestly verify via tsc+build+manual (repo has no component test runner) rather than fake unit tests.
- **Open integration detail:** Task 8 says "the handler that starts generation" — the implementer must locate the exact create/run handler in each page (it currently catches `{missingKey}` via `handleMissingKey`/`ApiKeyModal`); the guard goes at its top. Flagged, not a blocker.
