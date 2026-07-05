# Docs Redesign (หน้า "วิธีใช้งาน") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เปลี่ยนหน้า `/docs` จากไฟล์เดียว 853 บรรทัด (3 แท็บ neon) เป็นโซน docs เต็มจอแยกจากแอป มี sidebar สารบัญ + ค้นหา, เนื้อหาแยกไฟล์ TSX ต่อหัวข้อ, เขียนใหม่ให้ตรงผลิตภัณฑ์ปัจจุบัน (managed Gemini, minutes, credits) และเปลี่ยนป้ายปุ่มเป็น "วิธีใช้งาน".

**Architecture:** route group ใหม่ `(docs)` ทำให้ `/docs` ไม่สืบทอด `(dashboard)` shell (แก้ปัญหา sidebar ซ้อนกัน) — URL ยังเป็น `/docs`. Chrome ของโซน docs = topbar (โลโก้ + ค้นหา + กลับแอป) + sidebar สารบัญ + content column. เนื้อหาเก็บเป็น TSX module 1 ไฟล์/หัวข้อ, export `meta` + default component, รวมด้วย `registry.ts` ที่ขับ sidebar/routing/search.

**Tech Stack:** Next.js 15 App Router (React 19, TS), Tailwind v4, lucide-react, Clerk (auth via middleware — ไม่แตะ), design tokens `--ui-*` + utility `.premium-card`/`.eyebrow`/`.premium-glass` ใน `globals.css`.

## Global Constraints

- **URL ต้องคงเป็น `/docs` และ `/docs/[slug]`** (route group `(docs)` ไม่เปลี่ยน path) — เพื่อไม่ทำลาย middleware auth + ลิงก์เดิม
- **โทน:** สะอาด อ่านง่าย · accent เดียว = ม่วง (`hsl(262 83% 58%)` / `#8b5cf6`, class `text-violet-*`/`border-violet-*`) · หัวข้อฟอนต์ `Bai Jamjuree` · อนิเมชันเบา (ไม่มี orb/scanline หนัก) · เคารพ `prefers-reduced-motion`
- **ใช้ design tokens/utility เดิม** (`--ui-card-bg`, `--ui-text-primary`, `.premium-card`, `.premium-glass`, `.eyebrow`) — ห้าม hardcode สีนอกระบบเว้นแต่ accent ม่วง
- **BYOK/managed:** เนื้อหา default = managed ON (Gemini จัดการโดยระบบ, ผู้ใช้ใส่แค่ Pexels/Pixabay + optional ElevenLabs/HeyGen). ส่วน "ใส่ Gemini เอง" แสดงเฉพาะเมื่อ `managed === false` (fail-open → ถ้าโหลดสถานะพลาด ถือว่า managed=true)
- **ตัวเลข plan/minutes/credits ให้ hardcode ในเนื้อหา** (server-lib `credits.ts`/`plan-limits.ts` import prisma → ใช้ใน client ไม่ได้) พร้อมคอมเมนต์ `// keep in sync with src/lib/plan-limits.ts / src/lib/credits.ts`. ค่าจริง (verified):
  - นาที/30วัน: FREE **5** · PRO **80** · BUSINESS **150**
  - เครดิต grant/เดือน (paid-only, ไม่ทบ): FREE **0** · PRO **50** · BUSINESS **150** · trial 0
  - 1 เครดิต = ฿1 · นาที overflow = **2 เครดิต/นาที** · AI-gen คิดต่อการกระทำ 3–25 เครดิต (**ไม่ใช่ ×3 ตายตัว**)
  - แพ็กซื้อ (permanent): ฿199→200, ฿499→540, ฿999→1150
  - คลิป cap/30วัน: FREE 2 · PRO 100 · BUSINESS 300
- **ห้ามให้ผู้ใช้วาง API key ในแชท** — เนื้อหาต้องพาไป `/settings` เสมอ
- **Verify ต่อ task:** `npx tsc --noEmit` (ต้องไม่มี error ใหม่ในไฟล์ `src/app/(docs)/**`). Full `npm run build` + browser QA อยู่ใน Task 12
- **Commit ทุก task.** ปลาย commit message ต่อด้วย: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

```
src/app/(docs)/docs/
  layout.tsx                    # docs chrome: DocsProvider + topbar + sidebar + content column
  page.tsx                      # หน้าโฮม: hero + การ์ดหมวด
  [slug]/page.tsx               # เรนเดอร์หัวข้อตาม slug (notFound ถ้าไม่พบ)
  _content/
    types.ts                    # DocMeta, DocEntry (leaf — ไม่ import อะไรในโปรเจกต์)
    registry.ts                 # รวม modules → docs[], getDoc(), docsByCategory[], searchIndex
    getting-started.tsx
    setup-api-keys.tsx
    create-video.tsx
    subtitles.tsx
    avatar.tsx
    minutes-credits.tsx
    troubleshooting.tsx
  _components/
    docs-context.tsx            # DocsProvider + useDocsContext() (managed, plan)
    ui.tsx                      # Section, Step, PipelineRow, ApiRow, Callout, KeyLink, Tips
    docs-topbar.tsx
    docs-sidebar.tsx
    docs-search.tsx
```

**แก้ไข:** `src/components/layout/top-nav.tsx`, `src/app/(dashboard)/dashboard/page.tsx`, `src/components/layout/sidebar.tsx`
**ลบ:** `src/app/(dashboard)/docs/page.tsx`

---

## Task 1: Context provider + shared UI kit

**Files:**
- Create: `src/app/(docs)/docs/_components/docs-context.tsx`
- Create: `src/app/(docs)/docs/_components/ui.tsx`

**Interfaces:**
- Produces: `DocsProvider` (component), `useDocsContext(): { managed: boolean; plan: string; loading: boolean }`
- Produces (ui.tsx): `Section`, `Step`, `PipelineRow`, `ApiRow`, `Callout`, `KeyLink`, `Tips`, `Tip` — presentational components used by all content files

- [ ] **Step 1: Create `docs-context.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface DocsContextValue {
  managed: boolean; // true = ระบบจัดการ Gemini ให้ (default = fail-open ไป prod)
  plan: string;     // "FREE" | "PRO" | "BUSINESS"
  loading: boolean;
}

const DocsContext = createContext<DocsContextValue>({ managed: true, plan: "FREE", loading: true });

export function useDocsContext(): DocsContextValue {
  return useContext(DocsContext);
}

export function DocsProvider({ children }: { children: React.ReactNode }) {
  // default managed=true → ถ้า fetch พลาดให้แสดงประสบการณ์ managed (ตรง prod)
  const [managed, setManaged] = useState(true);
  const [plan, setPlan] = useState("FREE");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      fetch("/api/user/api-keys/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/user/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ]).then(([statusRes, meRes]) => {
      if (cancelled) return;
      // `managed` key มีเฉพาะเมื่อ MANAGED_GEMINI=1; ไม่มี = legacy BYOK
      if (statusRes.status === "fulfilled" && statusRes.value) {
        setManaged(statusRes.value.managed === true);
      }
      if (meRes.status === "fulfilled" && meRes.value?.plan) {
        setPlan(String(meRes.value.plan));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return <DocsContext.Provider value={{ managed, plan, loading }}>{children}</DocsContext.Provider>;
}
```

- [ ] **Step 2: Create `ui.tsx`** (clean/violet restyle — ไม่มี neon glow/scanline)

```tsx
"use client";

import { AlertTriangle, Info, CheckCircle2, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

/** การ์ดหัวข้อย่อยภายในหน้า — สะอาด ใช้ token */
export function Section({ title, icon: Icon, children }: { title: string; icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="premium-card p-5 md:p-6">
      <div className="mb-3 flex items-center gap-2.5">
        {Icon && (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "hsl(262 83% 58% / 0.12)", border: "1px solid hsl(262 83% 58% / 0.28)" }}>
            <Icon className="h-4 w-4 text-violet-300" strokeWidth={2.25} />
          </span>
        )}
        <h2 className="text-[16px] font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>{title}</h2>
      </div>
      <div className="space-y-3 text-[13.5px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>{children}</div>
    </section>
  );
}

export function Step({ num, title, children }: { num: number | string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-violet-200"
        style={{ background: "hsl(262 83% 58% / 0.14)", border: "1px solid hsl(262 83% 58% / 0.30)" }}>{num}</span>
      <div className="flex-1 pt-0.5">
        <h3 className="mb-1 text-[13.5px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{title}</h3>
        <div className="space-y-1.5 text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>{children}</div>
      </div>
    </div>
  );
}

export function PipelineRow({ num, name, desc }: { num: number; name: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-bold text-violet-300"
        style={{ background: "hsl(262 83% 58% / 0.10)", border: "1px solid hsl(262 83% 58% / 0.25)" }}>{String(num).padStart(2, "0")}</span>
      <div className="min-w-0 pt-0.5">
        <p className="text-[13px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{name}</p>
        <p className="mt-0.5 text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
      </div>
    </div>
  );
}

export function ApiRow({ name, required, desc, link, linkLabel }: { name: string; required?: boolean; desc: string; link?: string; linkLabel?: string }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-divider)" }}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <p className="text-[13px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{name}</p>
        <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          required ? "text-violet-200" : "")}
          style={required
            ? { background: "hsl(262 83% 58% / 0.15)", border: "1px solid hsl(262 83% 58% / 0.35)" }
            : { background: "hsl(0 0% 100% / 0.05)", border: "1px solid var(--ui-divider)", color: "var(--ui-text-muted)" }}>
          {required ? "จำเป็น" : "ตัวเลือก"}
        </span>
      </div>
      <p className="text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-300 hover:text-violet-200">
          → {linkLabel ?? link}
        </a>
      )}
    </div>
  );
}

type CalloutKind = "warn" | "info" | "tip";
const CALLOUT: Record<CalloutKind, { icon: React.ElementType; fg: string; bg: string; bd: string }> = {
  warn: { icon: AlertTriangle, fg: "hsl(35 95% 75%)", bg: "hsl(35 100% 50% / 0.08)", bd: "hsl(35 100% 50% / 0.30)" },
  info: { icon: Info,          fg: "hsl(262 83% 80%)", bg: "hsl(262 83% 58% / 0.08)", bd: "hsl(262 83% 58% / 0.28)" },
  tip:  { icon: Lightbulb,     fg: "hsl(160 70% 72%)", bg: "hsl(160 70% 45% / 0.08)", bd: "hsl(160 70% 45% / 0.28)" },
};
export function Callout({ kind = "info", children }: { kind?: CalloutKind; children: React.ReactNode }) {
  const c = CALLOUT[kind];
  const Icon = c.icon;
  return (
    <div className="flex gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px]" style={{ background: c.bg, border: `1px solid ${c.bd}` }}>
      <Icon className="mt-px h-4 w-4 shrink-0" style={{ color: c.fg }} />
      <div className="leading-relaxed" style={{ color: c.fg }}>{children}</div>
    </div>
  );
}

/** ลิงก์ไปตั้งค่า key ที่ /settings (in-app) */
export function KeyLink({ children = "ไปที่ Settings → API Keys" }: { children?: React.ReactNode }) {
  return (
    <a href="/settings?tab=keys" className="font-semibold text-violet-300 underline-offset-2 hover:underline">{children}</a>
  );
}

export function Tips({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2">{children}</ul>;
}
export function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" strokeWidth={2.5} />
      <span className="text-[13px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>{children}</span>
    </li>
  );
}
```

- [ ] **Step 3: Verify** — Run `npx tsc --noEmit`. Expected: ไม่มี error ใหม่ในไฟล์ `src/app/(docs)/**`.
- [ ] **Step 4: Commit**

```bash
git add "src/app/(docs)/docs/_components/docs-context.tsx" "src/app/(docs)/docs/_components/ui.tsx"
git commit -m "feat(docs): context provider + clean UI kit for docs zone

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Content types + registry + first doc (getting-started)

**Files:**
- Create: `src/app/(docs)/docs/_content/types.ts`
- Create: `src/app/(docs)/docs/_content/registry.ts`
- Create: `src/app/(docs)/docs/_content/getting-started.tsx`

**Interfaces:**
- Consumes: `Section`, `Step`, `Callout`, `Tips`, `Tip` (Task 1 ui.tsx)
- Produces: `DocMeta`, `DocEntry` (types.ts); `docs: DocEntry[]`, `getDoc(slug): DocEntry | undefined`, `docsByCategory: {name,items}[]`, `searchIndex: DocMeta[]` (registry.ts)
- Produces: content module contract — ทุกไฟล์เนื้อหา `export const meta: DocMeta` + `export default function` component

- [ ] **Step 1: Create `types.ts`**

```ts
import type { ComponentType } from "react";

export interface DocMeta {
  slug: string;      // → /docs/<slug>
  title: string;
  category: string;  // จัดกลุ่มใน sidebar
  order: number;     // ลำดับรวม (เรียงทั้งชุด)
  keywords: string[];// ใช้ค้นหา
  summary: string;   // snippet ในผลค้นหา + การ์ดหน้าโฮม
}

export interface DocEntry {
  meta: DocMeta;
  Component: ComponentType;
}
```

- [ ] **Step 2: Create `registry.ts`** (เริ่มด้วย getting-started เท่านั้น — task ถัดไปจะ import เพิ่ม)

```ts
import type { DocEntry, DocMeta } from "./types";
import * as gettingStarted from "./getting-started";

// เพิ่มหัวข้อใหม่ = import ที่นี่ แล้วใส่ใน modules[]
const modules = [
  gettingStarted,
];

export const docs: DocEntry[] = modules
  .map((m) => ({ meta: m.meta as DocMeta, Component: m.default }))
  .sort((a, b) => a.meta.order - b.meta.order);

export function getDoc(slug: string): DocEntry | undefined {
  return docs.find((d) => d.meta.slug === slug);
}

export interface DocCategory { name: string; items: DocMeta[]; }

export const docsByCategory: DocCategory[] = (() => {
  const order: string[] = [];
  const map = new Map<string, DocMeta[]>();
  for (const d of docs) {
    if (!map.has(d.meta.category)) { map.set(d.meta.category, []); order.push(d.meta.category); }
    map.get(d.meta.category)!.push(d.meta);
  }
  return order.map((name) => ({ name, items: map.get(name)! }));
})();

export const searchIndex: DocMeta[] = docs.map((d) => d.meta);
```

- [ ] **Step 3: Create `getting-started.tsx`**

```tsx
"use client";

import { Rocket } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "getting-started",
  title: "เริ่มต้นใช้งาน",
  category: "เริ่มต้น",
  order: 10,
  keywords: ["เริ่ม", "แนะนำ", "ภาพรวม", "getting started", "start", "overview"],
  summary: "HERO ทำอะไรได้ + เริ่มสร้างวิดีโอแรกใน 3 นาที",
};

export default function GettingStartedDoc() {
  return (
    <div className="space-y-5">
      <Section title="HERO AI ทำอะไรได้" icon={Rocket}>
        <p>เปลี่ยน <strong>สคริปต์</strong> เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + B-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง + พิธีกร AI (avatar) ถ้าต้องการ</p>
        <p>ขั้นตอนหลัก: <strong>Style → Content → Video</strong></p>
      </Section>

      <Section title="เริ่มใน 3 นาที">
        <Step num={1} title="ใส่คีย์ B-roll">ไปที่ Settings → API Keys ใส่ Pexels หรือ Pixabay อย่างน้อย 1 ตัว (Gemini ระบบจัดการให้แล้ว)</Step>
        <Step num={2} title="เขียนสคริปต์">เปิด Video Editor พิมพ์/วางสคริปต์ที่อยากทำเป็นวิดีโอ</Step>
        <Step num={3} title="Render แล้ว Burn & Download">กด Render เพื่อดูตัวอย่าง แล้ว Burn & Download เพื่อได้ไฟล์จริง</Step>
        <Callout kind="info">รายละเอียดแต่ละขั้นดูได้ในหัวข้อ "สร้างวิดีโอ" และ "ตั้งค่าคีย์"</Callout>
      </Section>
    </div>
  );
}
```

- [ ] **Step 4: Verify** — Run `npx tsc --noEmit`. Expected: ไม่มี error ใหม่.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(docs)/docs/_content/"
git commit -m "feat(docs): content types, registry, getting-started doc

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Docs chrome components (topbar, sidebar, search)

**Files:**
- Create: `src/app/(docs)/docs/_components/docs-search.tsx`
- Create: `src/app/(docs)/docs/_components/docs-topbar.tsx`
- Create: `src/app/(docs)/docs/_components/docs-sidebar.tsx`

**Interfaces:**
- Consumes: `searchIndex`, `docsByCategory` (Task 2 registry)
- Produces: `DocsSearch` (no props), `DocsTopbar({ onMenuClick })`, `DocsSidebar({ open, onClose })`

- [ ] **Step 1: Create `docs-search.tsx`**

```tsx
"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { searchIndex } from "../_content/registry";

export function DocsSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return searchIndex
      .filter((m) =>
        m.title.toLowerCase().includes(term) ||
        m.summary.toLowerCase().includes(term) ||
        m.keywords.some((k) => k.toLowerCase().includes(term)))
      .slice(0, 8);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(slug: string) {
    setOpen(false);
    setQ("");
    router.push(`/docs/${slug}`);
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <div className="flex items-center gap-2 rounded-lg px-3 py-1.5"
        style={{ background: "hsl(0 0% 100% / 0.05)", border: "1px solid var(--ui-divider)" }}>
        <Search className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="ค้นหาวิธีใช้งาน…"
          className="w-full bg-transparent text-[13px] outline-none"
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      {open && results.length > 0 && (
        <div className="premium-glass absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl">
          {results.map((m) => (
            <button key={m.slug} onClick={() => go(m.slug)}
              className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/5">
              <span className="text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>{m.title}</span>
              <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{m.category} · {m.summary}</span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim() && results.length === 0 && (
        <div className="premium-glass absolute left-0 right-0 top-full z-50 mt-1.5 rounded-xl px-3.5 py-3 text-[12px]"
          style={{ color: "var(--ui-text-muted)" }}>
          ไม่พบหัวข้อที่ตรงกับ “{q}”
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `docs-topbar.tsx`**

```tsx
"use client";

import Link from "next/link";
import { Sparkles, ArrowLeft, Menu } from "lucide-react";
import { DocsSearch } from "./docs-search";

export function DocsTopbar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-6"
      style={{ background: "var(--ui-nav-bg)", borderBottom: "1px solid var(--ui-nav-border)" }}>
      <button onClick={onMenuClick} aria-label="เมนู"
        className="flex h-8 w-8 items-center justify-center rounded-lg md:hidden"
        style={{ color: "var(--ui-text-secondary)" }}>
        <Menu className="h-4 w-4" />
      </button>

      <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5" aria-label="Hero AI Creator Studio">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{ background: "linear-gradient(135deg, hsl(262 83% 60%), hsl(252 83% 55%))" }}>
          <Sparkles className="h-4 w-4 text-white" strokeWidth={2.5} />
        </span>
        <span className="hidden flex-col leading-none sm:flex">
          <span className="text-[14px] font-bold tracking-tight text-white">วิธีใช้งาน</span>
          <span className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>Hero AI Creator Studio</span>
        </span>
      </Link>

      <div className="flex flex-1 justify-center px-2">
        <DocsSearch />
      </div>

      <Link href="/dashboard"
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium"
        style={{ color: "var(--ui-text-secondary)", background: "hsl(0 0% 100% / 0.04)", border: "1px solid var(--ui-divider)" }}>
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">กลับแอป</span>
      </Link>
    </header>
  );
}
```

- [ ] **Step 3: Create `docs-sidebar.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { docsByCategory } from "../_content/registry";

export function DocsSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          "z-40 w-64 shrink-0 overflow-y-auto",
          "fixed inset-y-0 left-0 top-16 transition-transform md:static md:top-0 md:translate-x-0 md:block",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        style={{ background: "var(--ui-sidebar-bg)", borderRight: "1px solid var(--ui-divider)" }}>
        <nav className="space-y-5 px-3 py-5">
          {docsByCategory.map((cat) => (
            <div key={cat.name}>
              <p className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>{cat.name}</p>
              <div className="space-y-0.5">
                {cat.items.map((m) => {
                  const href = `/docs/${m.slug}`;
                  const active = pathname === href;
                  return (
                    <Link key={m.slug} href={href} onClick={onClose}
                      className={cn("block rounded-lg px-2 py-1.5 text-[13px] transition-colors", active ? "font-semibold" : "hover:bg-white/5")}
                      style={{
                        background: active ? "hsl(262 83% 58% / 0.12)" : undefined,
                        color: active ? "var(--ui-text-primary)" : "var(--ui-text-secondary)",
                      }}>
                      {m.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
```

- [ ] **Step 4: Verify** — Run `npx tsc --noEmit`. Expected: ไม่มี error ใหม่.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(docs)/docs/_components/docs-search.tsx" "src/app/(docs)/docs/_components/docs-topbar.tsx" "src/app/(docs)/docs/_components/docs-sidebar.tsx"
git commit -m "feat(docs): topbar, sidebar, search chrome components

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route group layout + pages + remove old page (walking skeleton)

**Files:**
- Create: `src/app/(docs)/docs/layout.tsx`
- Create: `src/app/(docs)/docs/page.tsx`
- Create: `src/app/(docs)/docs/[slug]/page.tsx`
- Delete: `src/app/(dashboard)/docs/page.tsx`

**Interfaces:**
- Consumes: `DocsProvider`, `DocsTopbar`, `DocsSidebar` (Task 3); `docsByCategory`, `getDoc`, `docs` (Task 2)

- [ ] **Step 1: Create `layout.tsx`**

```tsx
"use client";

import { useState } from "react";
import { DocsProvider } from "./_components/docs-context";
import { DocsTopbar } from "./_components/docs-topbar";
import { DocsSidebar } from "./_components/docs-sidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <DocsProvider>
      <div className="flex h-screen flex-col" style={{ background: "var(--ui-card-bg-3)" }}>
        <DocsTopbar onMenuClick={() => setDrawerOpen((v) => !v)} />
        <div className="flex flex-1 overflow-hidden">
          <DocsSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">{children}</div>
          </main>
        </div>
      </div>
    </DocsProvider>
  );
}
```

- [ ] **Step 2: Create home `page.tsx`**

```tsx
"use client";

import Link from "next/link";
import { docsByCategory } from "./_content/registry";

export default function DocsHome() {
  return (
    <div className="space-y-8">
      <div>
        <p className="eyebrow mb-2">คู่มือการใช้งาน</p>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "'Bai Jamjuree', sans-serif" }}>
          วิธีใช้งาน Hero AI Creator Studio
        </h1>
        <p className="mt-2 text-[14px]" style={{ color: "var(--ui-text-secondary)" }}>
          เปลี่ยนสคริปต์เป็นวิดีโอสั้นอัตโนมัติ — เลือกหัวข้อด้านล่าง หรือค้นหาด้านบน
        </p>
      </div>
      {docsByCategory.map((cat) => (
        <div key={cat.name} className="space-y-2.5">
          <h2 className="text-[13px] font-bold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>{cat.name}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {cat.items.map((m) => (
              <Link key={m.slug} href={`/docs/${m.slug}`} className="premium-card premium-card-interactive block p-4">
                <p className="text-[14px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{m.title}</p>
                <p className="mt-1 text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{m.summary}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `[slug]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { getDoc, docs } from "../_content/registry";

export function generateStaticParams() {
  return docs.map((d) => ({ slug: d.meta.slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getDoc(slug);
  if (!entry) notFound();
  const { Component, meta } = entry;
  return (
    <article className="space-y-5">
      <header>
        <p className="eyebrow mb-1.5">{meta.category}</p>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "'Bai Jamjuree', sans-serif" }}>{meta.title}</h1>
      </header>
      <Component />
    </article>
  );
}
```

- [ ] **Step 4: Delete old docs page**

```bash
git rm "src/app/(dashboard)/docs/page.tsx"
```

- [ ] **Step 5: Verify — build + manual**

Run: `npm run build`
Expected: build ผ่าน (route `/docs` และ `/docs/[slug]` ปรากฏใน output)

Manual (dev): `npm run dev` → login → เปิด `http://localhost:3000/docs`
- [ ] หน้าโฮมโชว์การ์ดหมวด "เริ่มต้น" มี getting-started
- [ ] มี topbar (โลโก้ + ช่องค้นหา + ปุ่มกลับแอป) + sidebar ซ้าย — **ไม่มี**เมนูแอป (Admin/Dashboard/…)
- [ ] คลิกการ์ด → `/docs/getting-started` เรนเดอร์เนื้อหา
- [ ] พิมพ์ในช่องค้นหา "เริ่ม" → เจอ getting-started → คลิกไปได้
- [ ] ปุ่ม "กลับแอป" → `/dashboard`
- [ ] เปิด `/docs/ไม่มีจริง` → 404

- [ ] **Step 6: Commit**

```bash
git add "src/app/(docs)/" && git add -A "src/app/(dashboard)/docs"
git commit -m "feat(docs): standalone (docs) route group — layout, home, [slug]; remove old page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Tasks 5–10: Content docs

> ⚠️ **แก้ไข (พบระหว่าง Task 4's `npm run build`, ดู `.superpowers/sdd/progress.md` Minor findings):** อย่าใส่ `"use client"` ที่ `_content/<slug>.tsx` แบบเหมารวมอีกต่อไป — `[slug]/page.tsx` เป็น Server Component ที่อ่าน `meta.slug`/`meta.category`/`meta.title` ผ่าน `registry.ts`; ถ้าไฟล์เนื้อหามี `"use client"`, RSC จะแทนที่ **ทุก** export (รวม `meta`) ด้วย client-reference stub ทำให้ build พังที่ `generateStaticParams` (`meta.slug` เป็น `undefined`). **ค่าเริ่มต้นใหม่: ไม่ต้องใส่ `"use client"`** (`Section/Step/PipelineRow/ApiRow/Callout/KeyLink/Tips/Tip` ใน `ui.tsx` เป็น presentational ล้วน ไม่ต้องใช้ client) — ใส่เฉพาะไฟล์ที่เรียก hook จริง (เช่น Task 5 ที่ต้องใช้ `useDocsContext()`) และให้แยกเฉพาะส่วนที่ใช้ hook ออกเป็น nested Client Component เล็กๆ (ไฟล์เพิ่ม เช่น `setup-api-keys-gemini-section.tsx`) โดยไฟล์หลัก (`export const meta` + default component) ยังคงเป็น Server Component. ถ้าไฟล์ไหนต้องส่ง icon component reference เข้า `Section`, ห้ามส่ง `icon={SomeIcon}` ตรงๆ — ต้อง render เป็น JSX ก่อน: `icon={<SomeIcon className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}` (ตามที่ Task 4 แก้ไว้ใน `getting-started.tsx`).
>
> **รูปแบบเดียวกันทุก task:** สร้างไฟล์ `_content/<slug>.tsx` (`export const meta: DocMeta` + default component ที่ประกอบจาก `Section/Step/PipelineRow/ApiRow/Callout/KeyLink/Tips/Tip` ของ `ui.tsx` — **ไม่ใส่ `"use client"`** เว้นแต่ต้องใช้ hook ดูคำเตือนด้านบน) แล้ว **เพิ่ม import ใน `registry.ts`** (`import * as X from "./<slug>"` + ใส่ใน `modules[]`).
> เนื้อหาเขียนเป็นภาษาไทย โทนอ่านง่าย ตาม Global Constraints. Verify: `npx tsc --noEmit` + เปิด `/docs/<slug>` ดูเรนเดอร์ + หัวข้อโผล่ใน sidebar. **แนะนำเพิ่ม: รัน `npm run build` ต่อไฟล์แรกที่ใช้ hook (Task 5) เพื่อยืนยัน pattern การแยก client-subcomponent ใช้ได้จริงก่อนทำ task ถัดๆไป.** Commit ต่อ task.

### Task 5: setup-api-keys

**Files:** Create `src/app/(docs)/docs/_content/setup-api-keys.tsx`; Modify `src/app/(docs)/docs/_content/registry.ts`

**meta:**
```ts
export const meta: DocMeta = {
  slug: "setup-api-keys",
  title: "ตั้งค่าคีย์ API",
  category: "เริ่มต้น",
  order: 20,
  keywords: ["key", "api key", "pexels", "pixabay", "elevenlabs", "heygen", "gemini", "settings", "คีย์", "ตั้งค่า"],
  summary: "ระบบจัดการ Gemini ให้แล้ว — ใส่แค่ Pexels/Pixabay + optional ElevenLabs/HeyGen",
};
```

**เนื้อหา (ใช้ `useDocsContext` สำหรับ conditional):**
- นำด้วย `<Callout kind="info">` : **ระบบจัดการ Gemini ให้แล้ว — ไม่ต้องใส่ Gemini key เอง**
- `<Section title="คีย์ที่ต้องใส่เอง">` — `ApiRow` สามอัน:
  - Pexels — `required` — B-roll stock · link `https://www.pexels.com/api/`
  - Pixabay — `required` — B-roll stock · link `https://pixabay.com/api/docs/` — พร้อมข้อความ "ใส่ Pexels **หรือ** Pixabay อย่างน้อย 1 ตัวก็พอ"
  - ElevenLabs — optional — โคลนเสียง/เสียงพรีเมียม; ไม่ใส่ = ใช้เสียง Gemini · link `https://elevenlabs.io`
  - HeyGen — optional — avatar; ไม่ใส่ = เสียง+B-roll ปกติ · link `https://app.heygen.com`
- `<Section title="วิธีใส่และเทสคีย์">` — Step 1 เปิด `<KeyLink/>` · Step 2 วางคีย์แล้วกด Test (ขึ้น ✓ เขียว) · Step 3 Save
- `<Callout kind="warn">` : **ห้ามวางคีย์ในแชท** — วางที่หน้า Settings เท่านั้น
- **Conditional:** `const { managed } = useDocsContext();` — ถ้า `!managed` แสดง `<Section title="ใส่ Gemini key เอง">` (โหมด BYOK legacy) พร้อม `ApiRow` Gemini required + link `https://aistudio.google.com/apikey`; ถ้า `managed` ไม่ต้องแสดง

**registry.ts เพิ่ม:**
```ts
import * as setupApiKeys from "./setup-api-keys";
// modules = [ gettingStarted, setupApiKeys ];
```

**Commit:** `feat(docs): setup-api-keys content`

### Task 6: create-video

**meta:**
```ts
export const meta: DocMeta = {
  slug: "create-video",
  title: "สร้างวิดีโอ",
  category: "สร้างวิดีโอ",
  order: 30,
  keywords: ["video", "editor", "render", "pipeline", "burn", "สคริปต์", "สร้าง", "b-roll", "เสียง", "tts"],
  summary: "ขั้นตอนสร้างวิดีโอจากสคริปต์: pipeline, B-roll, เสียง, Render → Burn & Download",
};
```
**เนื้อหา:**
- `<Section title="Video Editor คืออะไร">` — เลย์เอาต์ 9:16 TikTok/Reels
- `<Section title="ขั้นตอนสร้าง">` — Step: เขียนสคริปต์ → ตั้งค่า pipeline → เลือกสไตล์ซับ → Render (preview) → `<strong>Burn & Download</strong>` (export จริง). `<Callout kind="info">` Render = พรีวิว, Burn = ไฟล์จริง
- `<Section title="Pipeline 6 ขั้น">` — `PipelineRow` ×6: 1 TTS Voice, 2 Transcribe, 3 Keywords, 4 B-roll, 5 Config, 6 Render
- `<Section title="B-roll & เสียง">` — B-roll เปลี่ยนทุก 3–5 วิ (content-matched); เลือกเสียง Gemini (default) หรือ ElevenLabs (ต้องมี voiceId)
- `<Section title="เคล็ดลับ">` — `Tips`

**Commit:** `feat(docs): create-video content`

### Task 7: subtitles

**meta:**
```ts
export const meta: DocMeta = {
  slug: "subtitles",
  title: "ซับไทย",
  category: "สร้างวิดีโอ",
  order: 40,
  keywords: ["subtitle", "ซับ", "caption", "viral", "ไวรัล", "timing", "คีย์เวิร์ด"],
  summary: "สองสไตล์ซับ (ยาว/ไวรัล) และซับตรงเสียงอัตโนมัติ",
};
```
**เนื้อหา:**
- `<Section title="สไตล์ซับ">` — ยาว vs ไวรัล (viral-keyword)
- `<Section title="ซับตรงเสียง">` — timing มาจาก TTS (แม่นยำ) · `<Callout kind="tip">` ปรับ/ลาก/แยก/ลบซับได้ใน timeline

**Commit:** `feat(docs): subtitles content`

### Task 8: avatar

**meta:**
```ts
export const meta: DocMeta = {
  slug: "avatar",
  title: "พิธีกร AI (Avatar)",
  category: "สร้างวิดีโอ",
  order: 50,
  keywords: ["avatar", "heygen", "พิธีกร", "bookend", "full", "green screen", "direct url"],
  summary: "โหมด full/bookend, HeyGen vs Direct URL, framing และค่าใช้จ่าย",
};
```
**เนื้อหา:**
- `<Section title="โหมด avatar">` — `Step`/รายการ: full (ทั้งคลิป, แพง), bookend (เปิด=หัว), bookend-both (เปิด-ปิด=หัว+ท้าย)
- `<Section title="2 วิธีสร้าง">` — Generate ผ่าน HeyGen (ต้องมี HeyGen key + avatarId) vs Direct URL (green screen / full video)
- `<Callout kind="warn">` — HeyGen คิดเงินตามวินาที แนะนำ bookend ประหยัดกว่า full
- `<Section title="framing & re-render">` — ตั้งตำแหน่ง/ขนาด, timing (intro/tail secs), re-render ได้โดยไม่เปลืองโควตา HeyGen

**Commit:** `feat(docs): avatar content`

### Task 9: minutes-credits

**meta:**
```ts
export const meta: DocMeta = {
  slug: "minutes-credits",
  title: "นาที & เครดิต",
  category: "แผน & การใช้งาน",
  order: 60,
  keywords: ["นาที", "เครดิต", "credit", "minute", "plan", "แผน", "pro", "business", "free", "pricing", "โควตา", "overflow"],
  summary: "โควตานาทีต่อแผน, เครดิตสำหรับ AI-gen และนาที overflow",
};
```
**เนื้อหา (hardcode ตัวเลขจริง + คอมเมนต์ source):**
```tsx
// ตัวเลขจาก src/lib/plan-limits.ts + src/lib/credits.ts (ณ 2026-07-01)
// keep in sync ถ้าแก้ที่ backend
```
- `<Section title="แผน & โควตานาที">` — ตาราง/รายการ 3 แผน: FREE 5 นาที · PRO 80 นาที · BUSINESS 150 นาที (ต่อ 30 วัน); คลิป cap 2/100/300; นับปัดใกล้สุด ขั้นต่ำ 1 นาที/คลิป
- `<Section title="เครดิต">` — 1 เครดิต = ฿1; grant/เดือน (ใช้แล้วหมด ไม่ทบ): FREE 0 · PRO 50 · BUSINESS 150 (trial ไม่ได้รับ); ซื้อเพิ่ม (permanent): ฿199→200, ฿499→540, ฿999→1150
- `<Section title="เครดิตใช้กับอะไร">` — นาที overflow เมื่อโควตาหมด = **2 เครดิต/นาที** (อัตโนมัติ); AI image/video gen คิดต่อการกระทำ 3–25 เครดิต; หัก granted ก่อน แล้ว purchased
- `<Callout kind="info">` — ดูยอดคงเหลือได้ที่ Settings → Billing

**Commit:** `feat(docs): minutes-credits content`

### Task 10: troubleshooting

**meta:**
```ts
export const meta: DocMeta = {
  slug: "troubleshooting",
  title: "แก้ปัญหา & FAQ",
  category: "แผน & การใช้งาน",
  order: 70,
  keywords: ["error", "ปัญหา", "แก้", "faq", "503", "b-roll", "key", "avatar fail", "troubleshoot"],
  summary: "error ที่พบบ่อยและวิธีแก้",
};
```
**เนื้อหา:** `<Section title="ปัญหาที่พบบ่อย">` พร้อม `Callout kind="warn"` ต่อปัญหา (พอร์ต+อัปเดตจากหน้าเดิม):
- 503 high demand → รอ 5–10 นาที หรือสลับเสียงเป็น ElevenLabs
- B-roll หาคลิปไม่เจอ → เช็ค Pexels/Pixabay key + Stock Source = Both
- avatar generate fail → เช็ค HeyGen key + avatarId
- key ไม่ถูกบันทึก → กด Save ที่ Settings, กด Test ให้ขึ้น ✓
- (managed) ไม่ต้องใส่ Gemini key แล้ว — ถ้ายังเห็นช่อง Gemini ข้ามได้

**Commit:** `feat(docs): troubleshooting content`

---

## Task 11: Rename entry buttons → "วิธีใช้งาน"

**Files:**
- Modify: `src/components/layout/top-nav.tsx:20`
- Modify: `src/app/(dashboard)/dashboard/page.tsx:154`
- Modify: `src/components/layout/sidebar.tsx` (import L9-11 + `userNavItems` L42-52)

- [ ] **Step 1: top-nav label** — เปลี่ยน L20:
```tsx
const navLinks = [
  { title: "วิธีใช้งาน", href: "/docs" },
];
```

- [ ] **Step 2: dashboard card** — เปลี่ยน L154:
```tsx
    { label: "วิธีใช้งาน", desc: "คู่มือ & สอนใช้ทีละขั้น", href: "/docs", Icon: BookOpen, color: "262 83% 58%" },
```

- [ ] **Step 3: sidebar — เพิ่มเมนู** — เพิ่ม `BookOpen` ใน import (L9-11):
```tsx
  Palette, FileText, Settings, Users, Film, Shield, Lock,
  LayoutDashboard, Video, HelpCircle, ChevronLeft, ChevronRight, Ticket, Clapperboard, CreditCard, Activity, Megaphone, BookOpen,
```
แล้วเพิ่ม item ใน `userNavItems` (หลัง Gallery, ก่อน "อัปเดต" — L48/49):
```tsx
  { title: "Gallery",       href: "/videos",      icon: Video },
  { title: "วิธีใช้งาน",     href: "/docs",        icon: BookOpen },
  { title: "อัปเดต",       href: "/updates",     icon: Megaphone },
```

- [ ] **Step 4: ยืนยัน middleware ยังคุ้มครอง `/docs`**

Run: `grep -nE "docs|isProtected|createRouteMatcher|isPublic" src/middleware.ts`
Expected: `/docs` **ไม่** อยู่ใน public routes (คือยังต้องล็อกอิน). ถ้าเป็น public-by-default + protect-list ให้ยืนยันว่า `/docs` ยัง match protected. ไม่ต้องแก้ถ้าพฤติกรรมเดิมคือ gated (URL ไม่เปลี่ยน).

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + `npm run dev`:
- [ ] top-nav โชว์ "วิธีใช้งาน" ลิงก์ไป /docs
- [ ] การ์ด dashboard label "วิธีใช้งาน"
- [ ] sidebar มีเมนู "วิธีใช้งาน" (ไอคอนหนังสือ) ลิงก์ไป /docs

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/top-nav.tsx "src/app/(dashboard)/dashboard/page.tsx" src/components/layout/sidebar.tsx
git commit -m "feat(docs): rename entry 'Docs' -> 'วิธีใช้งาน' + add sidebar link

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full build** — Run `npm run build`. Expected: ผ่าน, ไม่มี type/lint error, route `/docs` + `/docs/[slug]` อยู่ใน output
- [ ] **Step 2: Browser QA** — `npm run dev`, login, ไล่เช็ค:
  - [ ] `/docs` โฮม — ทุกหมวด/หัวข้อครบ (เริ่มต้น, สร้างวิดีโอ, แผน & การใช้งาน)
  - [ ] เปิดครบทั้ง 7 หัวข้อ เรนเดอร์ถูก ไม่มี error console
  - [ ] ค้นหา: "เครดิต" → minutes-credits, "avatar" → avatar, คำมั่ว → empty state
  - [ ] ปุ่ม "กลับแอป" + โลโก้ → /dashboard
  - [ ] ป้าย "วิธีใช้งาน" ทั้ง 3 จุด ลิงก์ถูก
  - [ ] **ไม่มี**เมนูแอปฝั่งซ้ายในโซน docs (ไม่มี sidebar ซ้อน)
- [ ] **Step 3: Mobile** — ย่อจอ/DevTools mobile: sidebar เป็น drawer (แฮมเบอร์เกอร์เปิด/ปิด), เนื้อหาเต็มจอ, ค้นหาใช้ได้
- [ ] **Step 4: managed on/off** — ยืนยันด้วยข้อมูลจริง: บน prod (managed ON) หัวข้อ setup-api-keys **ไม่** แสดงส่วน "ใส่ Gemini เอง"; ถ้าจำลอง fetch fail (offline) → default managed ON เช่นกัน (fail-open)
- [ ] **Step 5: ยืนยันตัวเลข** — minutes-credits ตรงกับ `plan-limits.ts`/`credits.ts` (5/80/150 นาที; grant 0/50/150; overflow 2/นาที)
- [ ] **Step 6:** ไม่มี commit ใหม่ (verification) — ถ้าเจอบั๊กให้แก้แล้ว commit ตาม task ที่เกี่ยวข้อง

---

## Self-Review (ผู้เขียนแผนตรวจแล้ว)

- **Spec coverage:** route group (Task 4) · sidebar+search (Task 3) · TSX+registry (Task 2,5–10) · ป้ายปุ่ม+sidebar link (Task 11) · IA 7 หัวข้อ (Task 2,5–10) · โทนสะอาด/violet (Task 1 ui.tsx + Global Constraints) · edge cases 404/fail-open/mobile (Task 4,12) · verify (ทุก task + Task 12) ✓ ครบ
- **Placeholder scan:** โครงสร้าง (context/registry/types/layout/pages/chrome/entry) เป็นโค้ดเต็ม; content docs ให้ meta เต็ม + outline + ค่าจริง (prose เขียนตอน implement ตาม frontend-design) — ตั้งใจ ไม่ใช่ placeholder ต้องห้าม
- **Type consistency:** `DocMeta`/`DocEntry` (types.ts) ใช้ตรงกันใน registry + ทุก content file; `getDoc`/`docs`/`docsByCategory`/`searchIndex` ชื่อตรงกันข้าม task; `useDocsContext()` คืน `{managed, plan, loading}` ตรงกับที่ setup-api-keys ใช้ ✓
