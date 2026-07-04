# Dashboard Redesign v2 (editor-CI unification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a **reskin + navigation restructure**, NOT a logic change — preserve every existing data fetch, API call, handler, and behavior unless a task explicitly says to change it.

**Goal:** Bring `/dashboard` (and the dashboard shell + selected sub-pages + a light sale-page pass) onto the Editor v2 design system — one calm, single-accent-violet house look — with a desktop sidebar + native mobile bottom-tabs IA that is ready to port to iOS/Android.

**Architecture:** The Editor v2 token system (`src/app/(dashboard)/video-editor/_v2/tokens.ts`, "Design System v1.1") becomes the **house standard**. We retire the loud neon `pp-*` layer (animated grid, floating orbs, spinning neon borders, cyberpunk corner brackets) on the dashboard and retune the shared `.dark` `--ui-*` CSS tokens toward the editor surfaces + a single violet accent. The shell keeps a restyled **sidebar on desktop** and gains a new **bottom-tab bar on mobile**. Nav is de-cluttered per role.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4, shadcn/ui, `lucide-react`, `next-themes` (dark-only), Kanit + Noto Sans Thai (app) via the root-layout Google Fonts link.

## Global Constraints

- **Dark-only.** `next-themes` is `defaultTheme="dark"` + `enableSystem={false}` and there is **no theme toggle in the UI**. Design all new surfaces dark. Do NOT add light-mode variants. Do NOT delete the legacy light `:root` / `:root:not(.dark)` CSS (other pages lean on those shims) — just don't build against them.
- **House tokens = Editor v2.** Source of truth for surfaces/accent/radius/type is `src/app/(dashboard)/video-editor/_v2/tokens.ts`. Prefer `--ui-*` CSS vars (retuned in Phase 1) over inlining raw hex. Where a v2 value has no `--ui-*` equivalent, copy the exact hex from `tokens.ts`.
- **Single accent = violet `#8B5CF6`** (`hsl(258 90% 66%)`). No cyan / amber / emerald as a *primary* accent anywhere in scope. Semantic status colors (success/warning/danger/info from `tokens.ts`) stay their own hues.
- **Retire neon on the dashboard.** No `PremiumBackdrop`, `CornerBrackets`, `PremiumCard`/`pp-card` spinning border, `pp-grid-bg`, or `pp-orb-*` on `/dashboard` or the shell. (Do NOT delete `premium-page.tsx` or the `pp-*` CSS — `/docs` still uses them and is out of scope. Just stop importing them on in-scope surfaces.)
- **Fonts:** app surfaces use Kanit (headings) + Noto Sans Thai (body). The sale page KEEPS Bai Jamjuree + Anton (deliberate marketing display voice). All are already loaded by the root layout's Google Fonts `<link>` — no new font loading.
- **`/admin/insights` is OUT OF SCOPE** — do not modify its files. It was redesigned 2026-07-03 (PR #153). After the Phase 1 token retune, **eyeball it to confirm no visual regression**; if the retune breaks it, scope the offending token change so insights is unaffected.
- **`/video-editor` is the reference — do not touch it.** The `if (pathname === "/video-editor")` branch in `dashboard-layout.tsx` must remain byte-identical. `_v2/*` files are read-only inputs.
- **App-readiness discipline:** interactive targets ≥ 44×44px on mobile; no hover-only affordances (every hover action has a tap/visible equivalent); bottom-tab IA; token-driven (no magic numbers where a token exists). This is design discipline, NOT an actual React Native/Capacitor port.
- **Legacy nav cut:** remove `Styles` (`/style`), `Content` (`/content`), `Video Creator` (`/video-creator`) from the sidebar for BOTH roles. **Keep the routes/pages/files alive** (bookmarks still work) — nav-level removal only.
- **Config shadowing gotcha:** `next.config.js` shadows `next.config.ts`. Build with the prod-safe low-heap env when verifying (see CLAUDE.md). `npm run build` must pass.
- **No-regression rule:** any page NOT named in this plan must stay byte-identical in output. Verify with `git diff --stat` staying limited to intended files (plus globals.css).

---

## File Structure

**Create:**
- `src/components/layout/bottom-tabs.tsx` — mobile bottom-tab bar (client). Renders <lg only. 4 primary tabs, role-agnostic, ≥44px, safe-area inset.

**Modify (shell):**
- `src/app/globals.css` — Phase 1: retune `.dark` `--ui-*` block to editor surfaces; swap `--accent-primary` to violet; add `.bottom-tabs`/v2-fade helper classes if needed.
- `src/components/layout/sidebar.tsx` — restyle to v2 tokens; cut legacy items; add role sections (STUDIO / ADMIN) with labels.
- `src/components/layout/top-nav.tsx` — restyle to v2 tokens (mostly token-based already).
- `src/components/layout/mobile-sidebar.tsx` — either restyle to match, or retire in favor of bottom-tabs + a "More" sheet (see Task 2b).
- `src/components/layout/dashboard-layout.tsx` — mount `<BottomTabs>` (mobile), keep the `/video-editor` branch byte-identical, add bottom padding on mobile so content clears the tab bar.

**Modify (pages, in scope):**
- `src/app/(dashboard)/dashboard/page.tsx` — full rebuild to v2 tokens (Phase 3).
- `src/app/(dashboard)/settings/page.tsx` — restyle (Phase 4a).
- `src/app/(dashboard)/pricing/page.tsx` — restyle (Phase 4b).
- `src/app/(dashboard)/admin/page.tsx` — restyle (Phase 4c, 1699 lines → heavy).
- `src/app/(dashboard)/admin/users/page.tsx` — restyle (Phase 4d).
- `src/app/(dashboard)/admin/coupons/page.tsx` — restyle (Phase 4e).
- `src/app/(dashboard)/videos/page.tsx` — light no-seam align only (Phase 4f).
- `src/app/page.tsx` + `src/components/marketing/*` — light consistency pass (Phase 5).

**Supporting components (restyle in place, keep behavior):**
- `src/components/quota-status.tsx`, `src/components/onboarding/DashboardOnboarding.tsx`, `src/components/v2-job-badge.tsx` — touched only as the dashboard page needs; keep their data logic.

**Read-only references (never modify):**
- `src/app/(dashboard)/video-editor/_v2/{tokens.ts,fonts.ts,ui.tsx,EditorV2Shell.tsx}`, `src/components/layout/account-menu.tsx`, `src/app/(dashboard)/admin/insights/*`.

---

## Phase 0 — Design mockup + approval gate  *(session model, inline)*

**This is the real design gate.** Before any React changes, the session model produces ONE self-contained HTML Artifact (using the `frontend-design` skill) showing the new dashboard in v2 tokens:
1. Desktop — **User (Pro/Business)** dashboard: restyled sidebar + content.
2. Desktop — **Admin** dashboard: sidebar with STUDIO / ADMIN sections, legacy items gone.
3. Mobile — dashboard with the **bottom-tab bar** + a card-stacked layout.

- [ ] Build the mockup as `scratchpad` HTML, publish via Artifact, present to Mew.
- [ ] **CHECKPOINT:** Mew approves the visual (or requests changes — iterate here, cheaply, before touching code). The approved mockup is the visual spec every build task implements against.

---

## Phase 1 — Token foundation  *(mew-worker)*

Highest-leverage change: retuning the shared `.dark` tokens shifts many pages toward the house look at once.

**Files:** Modify `src/app/globals.css` (`.dark` block ~L194-247; `--accent-primary` ~L252).

**Interfaces — Produces:** the retuned `--ui-*` dark palette + violet `--accent-primary` that every later phase consumes via existing `var(--ui-*)` usages.

- [ ] **Step 1 — Retune `.dark` surfaces toward Editor v2.** Nudge to match `tokens.ts` (`bg0 #0A0A10`, `bg1 #0F0F17`, card `rgba(255,255,255,.03)`, border `rgba(255,255,255,.08)`): set `--ui-nav-bg`/`--ui-sidebar-bg` ≈ `hsl(240 13% 5%)`, `--ui-card-bg` ≈ `hsl(240 20% 7%)`, `--ui-card-border` ≈ `hsl(0 0% 100% / 0.08)`, `--ui-divider` ≈ `hsl(0 0% 100% / 0.06)`. Keep text tokens (already good).
- [ ] **Step 2 — Swap primary accent to violet.** `--accent-primary: 258 90% 66%;` (was `220 90% 65%` blue). Leave `--accent-secondary` violet-ish or align to the same family.
- [ ] **Step 3 — Build.** Run: `BUILD_NO_LINT=1 npm run build` → Expected: success.
- [ ] **Step 4 — No-regression eyeball.** Load `/admin/insights` and 1–2 untouched pages (`/updates`) in the browser. Expected: still legible, no broken contrast. If insights regresses, wrap the offending change so it targets only in-scope surfaces.
- [ ] **Step 5 — Commit.** `git commit -m "dashboard-v2: retune .dark tokens to editor surfaces + violet accent"`

---

## Phase 2 — Shell chrome  *(mew-worker-heavy)*

The nav backbone. One task-cluster because sidebar + bottom-tabs + layout change together.

**Files:** Modify `sidebar.tsx`, `top-nav.tsx`, `mobile-sidebar.tsx`, `dashboard-layout.tsx`; Create `bottom-tabs.tsx`.

**Interfaces — Consumes:** retuned tokens (Phase 1). **Produces:** `<BottomTabs />` (default export component, no required props); restructured nav arrays in `sidebar.tsx`.

- [ ] **Step 1 — Cut legacy nav items.** In `sidebar.tsx`, remove `Styles` / `Content` / `Video Creator` entries from `userNavItems` (they are `adminOnly: true` today, so this removes them from the admin view; users already don't see them). Do NOT touch the routes.
- [ ] **Step 2 — Role sections in the sidebar.** For ADMIN, render two labeled groups: **STUDIO** = `Dashboard · Video Editor · Gallery · Settings`; **ADMIN** = `Admin · Insights · Users · Coupons · Updates(admin)`. Move `Pricing` + `วิธีใช้งาน` + `อัปเดต(user)` under a subtle "More" affordance or keep at the bottom for USER; for USER keep the lean list `Dashboard · Video Editor · Gallery · วิธีใช้งาน · อัปเดต · Pricing · Settings`. Small uppercase section labels use `--ui-text-muted`.
- [ ] **Step 3 — Restyle sidebar to v2.** Replace the cyan active-accent (`hsl(190 100% 50%)`) with violet (`#8B5CF6`): active bar, active icon, active bg tint. Keep the collapse toggle + localStorage behavior. Keep the plan/usage footer card but recolor to violet (drop any cyan). Icons stay `lucide-react`.
- [ ] **Step 4 — Create `BottomTabs`.** New client component: fixed bottom bar, `lg:hidden`, `env(safe-area-inset-bottom)` padding, background `--ui-nav-bg` + top border `--ui-nav-border`, 4 tabs (`Dashboard /dashboard` `LayoutDashboard`, `Editor /video-editor` `Clapperboard`, `Gallery /videos` `Video`, `Settings /settings` `Settings`), each ≥44px tall, active = violet icon+label, inactive = `--ui-text-muted`, uses `usePathname()` for active state, `next/link` with prefetch.
- [ ] **Step 5 — Wire into layout.** In `dashboard-layout.tsx`: render `<BottomTabs />` in the non-editor branch; hide the mobile hamburger's full drawer if bottom-tabs cover primary nav (retire `mobile-sidebar.tsx` drawer OR repurpose it as a "More" sheet holding secondary links — Docs/Updates/Pricing/Admin). Add `pb-[calc(64px+env(safe-area-inset-bottom))] lg:pb-0` to the mobile `<main>` so content clears the bar. **Keep the `/video-editor` branch byte-identical.**
- [ ] **Step 6 — Restyle TopNav** to v2 tokens (logo tile already uses a blue→violet gradient — align to `tokens.ts` `gradientPrimary`). On mobile, the hamburger opens the "More" sheet (not the full old drawer) — or is hidden if all nav lives in tabs + account menu.
- [ ] **Step 7 — Build + manual QA.** `BUILD_NO_LINT=1 npm run build`. Then in the browser (both an admin and a user account, desktop + mobile viewport): sidebar sections correct per role, legacy items gone, bottom-tabs switch pages + active states, `/video-editor` shell unchanged.
- [ ] **Step 8 — Commit.** `git commit -m "dashboard-v2: restyle shell + mobile bottom-tabs + role nav sections"`

---

## Phase 3 — Dashboard landing page  *(mew-worker-heavy)*

**Files:** Modify `src/app/(dashboard)/dashboard/page.tsx`; touch `quota-status.tsx`, `DashboardOnboarding.tsx`, `v2-job-badge.tsx` only to recolor to v2 (keep their data logic).

**Interfaces — Consumes:** retuned tokens, shell. **Produces:** the reference implementation of the house page look other pages copy.

- [ ] **Step 1 — Strip neon.** Remove `PremiumBackdrop`, `CornerBrackets`, `pp-card`, `pp-fade-*` neon usages. Replace the animated grid/orbs background with the flat editor surface (`--ui-*` / `tokens.ts bg0`).
- [ ] **Step 2 — Rebuild layout to match the approved Phase 0 mockup:** greeting header (Kanit), plan badge (violet/business, keep expiry logic), `QuotaStatus` chip (restyled), `DashboardOnboarding` (restyled), quick-action cards (violet, flat v2 cards, ≥44px, `ArrowRight` affordance), stats cards, recent activity, upgrade CTA. Keep ALL existing `fetch('/api/user/stats')` + `/api/user/me` logic and every link target.
- [ ] **Step 3 — Role-aware.** Admin sees an admin quick-action row (Insights / Users / Coupons); user sees the creator row (Editor / Gallery / Docs). **The admin dashboard body is a pure launchpad — do NOT add a system-snapshot / stats row (payers/trials/MRR); that lives in Insights.** Data unchanged.
- [ ] **Step 4 — Build + eyeball vs mockup** (desktop + mobile). `BUILD_NO_LINT=1 npm run build`.
- [ ] **Step 5 — Commit.** `git commit -m "dashboard-v2: rebuild /dashboard on editor tokens"`

---

## Phase 4 — In-scope sub-pages  *(parallel where isolated)*

Each: restyle to v2 tokens, single violet accent, keep every handler/fetch/route. Each ends with `BUILD_NO_LINT=1 npm run build` + a browser eyeball + a commit. Independently reviewable.

- [ ] **Task 4a — Settings** (`settings/page.tsx`, 592 L) — *mew-worker*. Restyle tabs/cards/inputs/buttons to `--ui-*`. Preserve API-keys tab, billing tab, all save flows. Verify keys still save.
- [ ] **Task 4b — Pricing** (`pricing/page.tsx`, 459 L) — *mew-worker*. Restyle to v2; keep the lean-convert behavior + the pricing-display rule (monthly price, no annual total). Do NOT re-hardcode tier features (they come from `/api/plans`).
- [ ] **Task 4c — Admin home** (`admin/page.tsx`, 1699 L) — *mew-worker-heavy*. Restyle to v2; preserve every admin control/table/action. Largest surface — verify no admin action breaks.
- [ ] **Task 4d — Admin users** (`admin/users/page.tsx`, 525 L) — *mew-worker*. Restyle table/filters/actions; preserve user-management calls.
- [ ] **Task 4e — Admin coupons** (`admin/coupons/page.tsx`, 243 L) — *mew-worker*. Restyle; preserve coupon CRUD.
- [ ] **Task 4f — Gallery light align** (`videos/page.tsx`, 461 L) — *mew-worker*. **Light no-seam only:** ensure it reads the retuned tokens and doesn't clash with the new dashboard as a primary tab. Not a full redesign. Keep all gallery/download logic.

---

## Phase 5 — Sale page light consistency pass  *(mew-worker)*

**Files:** `src/app/page.tsx`, `src/components/marketing/*` (esp. `pricing-toggle.tsx`, `auth-shell.tsx`, `motion-fx.tsx`).

- [ ] **Step 1 — Accent parity.** Ensure the marketing violet is the exact house `#8B5CF6` and the logo/H tile matches the app's `gradientPrimary`.
- [ ] **Step 2 — Component vibe.** Nudge marketing cards/buttons/badges toward the app's flat-violet surfaces so `sale → /login → /dashboard` feels like one brand. **KEEP Bai Jamjuree + Anton** (marketing display voice) and all marketing copy verbatim.
- [ ] **Step 3 — Build + eyeball** the full funnel (`/` → `/login` → `/dashboard`). `BUILD_NO_LINT=1 npm run build`.
- [ ] **Step 4 — Commit.** `git commit -m "dashboard-v2: sale-page light consistency pass"`

---

## Phase 6 — Verify + regression gate

- [ ] **Tier-1 review** (`mew-reviewer`): spec compliance + code quality on the full diff; run `BUILD_NO_LINT=1 npm run build`; confirm `git diff --stat` touches only intended files (+ globals.css).
- [ ] **`/security-review`** — Settings touches API keys/billing → run it on the diff.
- [ ] **No-regression:** `/admin/insights` visually unchanged; untouched pages byte-identical; `/video-editor` shell byte-identical.
- [ ] **Mobile QA:** bottom-tabs on both roles; ≥44px targets; no horizontal scroll; content clears the tab bar (safe-area).
- [ ] **Tier-2 final gate** (session): review Tier-1 summary + flagged spots vs Acceptance Criteria.

---

## Execution Directive

| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 0 | Design mockup (Artifact) | (session model) | inline | Mew visual approval (checkpoint) |
| 1 | Token foundation (globals.css) | mew-worker | subagent | build, insights no-regress |
| 2 | Shell chrome + bottom-tabs | mew-worker-heavy | subagent | build, manual nav QA, code review |
| 3 | /dashboard rebuild | mew-worker-heavy | subagent | build, eyeball vs mockup, code review |
| 4a | Settings | mew-worker | subagent | build, keys-save QA, code review, security-review |
| 4b | Pricing | mew-worker | subagent | build, code review |
| 4c | Admin home | mew-worker-heavy | subagent | build, admin-action QA, code review |
| 4d | Admin users | mew-worker | subagent | build, code review |
| 4e | Admin coupons | mew-worker | subagent | build, code review |
| 4f | Gallery light align | mew-worker | subagent | build, no-seam eyeball |
| 5 | Sale-page light pass | mew-worker | subagent | build, funnel eyeball, code review |
| 6 | Verify + regression | mew-reviewer + session | subagent+inline | build, security-review, no-regression, criteria |

## Acceptance Criteria

- [ ] `/dashboard` uses the Editor v2 token system (violet single-accent, flat surfaces, Kanit/Noto) with **zero** `pp-*` neon (grid/orbs/spinning border/corner brackets).
- [ ] Desktop shows a restyled sidebar; mobile (<lg) shows a native bottom-tab bar (Dashboard/Editor/Gallery/Settings), each ≥44px, correct active state.
- [ ] Admin sidebar shows STUDIO + ADMIN sections; **Styles/Content/Video Creator are absent from nav for both roles**, but their routes still load if visited directly.
- [ ] User (Pro/Business) sidebar is the lean list; no admin items leak to users.
- [ ] `/settings`, `/pricing`, `/admin`, `/admin/users`, `/admin/coupons` are restyled to the house look with **all functionality intact** (keys save, coupons CRUD, user mgmt, pricing display rule).
- [ ] `/admin/insights` is **unmodified and visually un-regressed**.
- [ ] Gallery (`/videos`) does not visually seam against the new dashboard.
- [ ] Sale page shares the exact violet + logo/brand, keeps Bai Jamjuree; funnel `/` → `/login` → `/dashboard` reads as one brand.
- [ ] `/video-editor` shell + all untouched pages are byte-identical.
- [ ] `BUILD_NO_LINT=1 npm run build` passes; `/security-review` on the Settings diff is clean.
- [ ] App-readiness: no hover-only affordances on in-scope surfaces; ≥44px targets on mobile; no horizontal scroll.

## Status

interviewed 2026-07-04 | approved: 2026-07-04 | executed: 2026-07-05 (14 commits, build+review clean) | delivered: pending Mew merge+deploy

## Open decisions carried in (already resolved with Mew — do not re-ask)

- Nav model = restyled sidebar (desktop) + bottom-tabs (mobile).
- Sale page = light consistency pass, keep Bai Jamjuree.
- Legacy routes = hide from nav, keep routes.
- Scope = shell + /dashboard + token retune + redesign settings/pricing/admin/users/coupons; **exclude insights**; gallery light-align.
- Theme = dark-only.
- iOS/Android = design discipline only, not an RN port.
