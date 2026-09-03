# Brands wave 1b — Pin for every plan, AI images stay gated (#430)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator on ANY plan can attach a Brand Profile / ชุดสไตล์ to a clip (brand pin, per-clip look, promotion) and get everything that costs nothing — stock B-roll mood, subtitle default, pacing, music default, script tone — while managed AI-image generation keeps today's paid + rollout gate. Close #430 on the way: the render-time "existing pin" grandfather clause is anchored to the image-access decision recorded when the pin was written, so a pin can never be a self-service ticket to AI images.

**Architecture:** Two independent decisions replace one. *Pin access* = `decideBrandLibraryAccess` (master switch + not suspended; every plan). *Image admission* = `decideBrandVisualAccess` (paid-equivalent + rollout cohort), recorded onto `EditorProject` by EVERY pin writer as `brandVisualPinAdmittedCohort` / `brandVisualPinAdmittedAt` (additive). `resolveBrandVisualRenderAccess` honours a persisted pin only when that stamp is non-null. Job creation snapshots the pinned visual context for every library user (so wave-1 readers see the pack) but writes `brandVisualAcceptanceJson` only for admitted users — `fetch-stock`'s image path already requires that envelope, so no AI image can be spent without admission.

**Tech Stack:** Next.js 16.3 (App Router), Prisma 6 / SQLite (two additive columns on `EditorProject`), Zod, React 19, `tsx` verify scripts.

**Spec:** ADR 0059 + Amendment 2026-09-02 (`docs/adr/0059-brand-library-opens-to-every-plan.md`) · issue #430 · ADR 0057/0058 (wave 1 readers) · `CONTEXT.md` (Brand Visual, Pin, ชุดสไตล์). Gate map (facts, file:line) in the SDD ledger's recon note.

## Global Constraints

- Branch `mew/brands-pack-pin-for-all` (Orca worktree `…-brands-wave1b`, from `main` b1b534d9); PR into `main`; CI green; `verify:brands-ci` gains every new verify (wave-1 rule R12).
- Schema: additive only — exactly `EditorProject.brandVisualPinAdmittedCohort String?` and `brandVisualPinAdmittedAt DateTime?`; the migration file contains only those two `ALTER TABLE` statements (wave-1 R17: hand-check, the local chain is drifted).
- No route loses a check it has today except by design here: `brand-revision`, `visual-context` PUT, `from-project-look` move from `requireBrandVisualUser` to `requireBrandLibraryUser`. `preview-quote`, Brand Look preview/reroll, `broll-window/generate`, Hero-image sources in `videos/jobs` keep the image gate unchanged.
- Fail-open for renders: a pin without admission renders with stock only — never an error, never a hidden AI-image attempt (ADR 0023). Subtitle timing untouched (ADR 0056).
- Customer copy Thai only; never `Treatment`, `Preset`, `Pin`, `Trend Pack`, `Style Pack`, `Brand Visual`, `Hero AI Image`, `Video Editor` in UI strings.
- Security review (branch-wide) is a gate: this wave touches authorization.

## Decisions (Mew, 2026-09-03)

- **D1 Who can pin:** every plan including FREE (FREE is already capped at 2 clips / 30 days; pinning costs nothing). — *pending Mew*
- **D2 Content Preflight for non-admitted pinned renders:** run it (one managed-Gemini text call per job, same class as keyword extraction; gives beats + `suggestedStylePackId`; the compiled treatment is simply not used for images). — *pending Mew*
- **D3 Legacy pins:** one-off backfill stamps existing pins whose OWNER currently has image access (`internal` / `treatment-*`); all other legacy pins stay unadmitted (their owners still get live access whenever entitled — only self-admitted `rollout-wait` accounts lose the grandfather, which is the point of #430). — *pending Mew*

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Pin admission stamp: schema, `recordBrandVisualPinAdmission` in every pin writer (creator routes + Hero Script send-to-editor + First-Clip auto-spine), `resolveBrandVisualRenderAccess` honours only admitted pins, backfill script, tests | mew-worker-heavy | subagent | — | build+test, code review, security lens |
| 2 | Gate split server-side: three routes → library guard; GET visual-context readable for library users; `videos/jobs` snapshots the pinned context for every library user and writes acceptance only when admitted; `/api/user/me` exposes `brandLibraryAllowed`; tests | mew-worker-heavy | subagent | 1 | build+test, code review, security lens |
| 3 | Editor client: format / ชุดสไตล์ / treatment pickers usable by every library user; AI-image-only affordances (Brand Look preview, AI image sources, image-cost confirmations) follow `brandVisualAllowed`; Step-2 line; Thai copy | mew-worker | subagent | 2 | build+test, code review |
| 4 | Final gate: full ci.yml list, security review, ADR 0059 Amendment 2, `CONTEXT.md` term "Pin admission", plan status, deploy note (backfill) | (session) | inline | 1–3 | criteria check |

Frontier: 1 → 2 → 3 (each builds on the previous contract) → 4.

---

### Task 1: Pin admission stamp (#430)

**Files:**
- Modify: `prisma/schema.prisma` (`EditorProject` + `brandVisualPinAdmittedCohort String?`, `brandVisualPinAdmittedAt DateTime?`), `prisma/migrations/<ts>_brand_visual_pin_admission/migration.sql` (two ALTERs only)
- Create: `src/lib/brand-visual-pin-admission.server.ts`
- Modify: `src/lib/project-look.server.ts` (`saveProjectLookInTransaction`, `applyProjectLook`, `saveUploadProjectVisualFormatAwaitingPreflight`), `src/lib/brand-profile-library.server.ts` (`applyProjectBrandRevision`, both promote functions), `src/lib/hero-script.server.ts` (`sendScriptToEditor` → `createEditorProject({ brandProfileRevisionId })`), `src/lib/first-clip-path.server.ts` (`ensureFirstClipProjectSpine` → `pinProjectBrandRevision`), `src/lib/brand-visual-job-acceptance.server.ts` (`resolveBrandVisualRenderAccess`), `src/lib/project-look.server.ts` (`projectHasPersistedVisualPin` → also returns admission)
- Create: `scripts/backfill-brand-visual-pin-admission.ts` (`--dry-run` default; `--apply`)
- Test: extend `scripts/verify-brand-visual-job-acceptance.ts`, `scripts/verify-brand-visual-ops.ts` (the two system writers), `scripts/verify-project-look.ts`; add `scripts/verify-brand-visual-pin-admission.ts` (+ npm script, + brands-ci chain)

**Interfaces (Produces):**

```ts
// brand-visual-pin-admission.server.ts
export type PinAdmission = { cohort: BrandVisualCohort; at: Date } | null;
export function pinAdmissionFromDecision(decision: BrandVisualAccessDecision): PinAdmission; // canUse ? {cohort, at: now} : null
export async function recordBrandVisualPinAdmission(tx, projectId: string, admission: PinAdmission): Promise<void>; // writes both columns (null clears)
export function hasAdmittedPersistedPin(project: { brandVisualPinAdmittedCohort: string | null; /* + existing pin fields */ }): boolean;
// brand-visual-job-acceptance.server.ts
resolveBrandVisualRenderAccess({ requestsBrandVisualImage, liveAccess, hasAdmittedPersistedPin })  // renamed input; "existing-pin" only when admitted
```

Rules: every pin writer computes the writer's live image decision for the OWNER (`decideBrandVisualAccess(owner, paidEquivalent)`) inside the same transaction and stamps it; clearing a pin clears the stamp; the two system writers stamp exactly like creator routes (they may legitimately write null). Backfill: for each project with a pin and null stamp, stamp only if the owner's CURRENT decision has `canUse` (D3); prints counts; `--apply` writes.

- [ ] **Step 1: Failing tests** — acceptance: a pin with null stamp + `rollout-wait` live access → `null` (denied); stamped pin + `rollout-wait` → `existing-pin`; stamped pin + live `canUse` → live cohort. Ops: Hero-Script send-to-editor and First-Clip spine on a `rollout-wait` owner produce a pin with null stamp and the job is NOT admitted to images; the same on an `internal` owner stamps `internal`. Project-look: `applyProjectLook` + `clearProjectLook` stamp/clear. Backfill dry-run counts.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npm run verify:brand-visual-system && npm run verify:brand-visual-pin-admission && npx tsc --noEmit --pretty false` → PASS; commit `feat(brands): anchor the existing-pin grandfather to the admission recorded at pin time (#430)`.

### Task 2: Gate split (server)

**Files:**
- Modify: `src/app/api/editor-projects/[id]/brand-revision/route.ts`, `src/app/api/editor-projects/[id]/visual-context/route.ts` (PUT → `requireBrandLibraryUser`; GET → readable when library access, `hasPersistedVisualPin` no longer needed to read), `src/app/api/brand-library/from-project-look/route.ts` (→ library guard; the promoted profile's pin stamps admission from the live decision)
- Modify: `src/app/api/videos/jobs/route.ts` (~825–856): for a library user with a pinned project, prepare the visual snapshot / pin (`prepareProjectVisualPin` / `prepareUploadProjectVisualSnapshot`) regardless of image access; call `prepareBrandVisualJobAcceptance` ONLY when `resolveBrandVisualRenderAccess(...)` is non-null; the Hero-image / auto-mix SOURCE gates at ~735–786 unchanged
- Modify: `src/app/api/editor-projects/[id]/content-preflight/route.ts` (D2: allowed for library users with a pin)
- Modify: `src/app/api/user/me/route.ts` (+ `brandLibraryAllowed: boolean`), `src/lib/use-me.ts` (`resolveBrandLibraryClientAccess`)
- Test: extend `scripts/verify-brand-visual-ops.ts` (rollout-wait PRO can pin and render stock-only; FREE can pin; neither gets `brandVisualAcceptanceJson`; `fetch-stock` image path refuses without the envelope — reuse its existing 409 assertion), `scripts/verify-brand-visual-rollout.ts` (client access helpers)

- [ ] Steps: failing tests → implement → `npm run verify:brand-visual-system && npm run verify:brands-ci && npx tsc --noEmit --pretty false` → commit `feat(brands): every plan can pin a brand or style pack; AI-image admission stays gated`.

### Task 3: Editor client

**Files:** `src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx` (`canManageBrandVisual` ← library access; image-only UI ← `brandVisualAllowed`; Thai notice when a pack is pinned but images are not admitted: `คลิปนี้ใช้ชุดสไตล์กับฟุตเทจ ซับ และเพลงแล้ว · ภาพ AI ของแบรนด์ยังไม่เปิดสำหรับแผนนี้`), `useV2Project.ts` (`brandLibraryAllowed`), `Step2Elements.tsx` (no change to the read-only line unless needed), `src/lib/automix-plan.ts` (`shouldLoadBrandVisualContext` for library users with a pin)
- Test: extend `scripts/verify-brand-treatment-ui-v1.ts` (copy guard + source guards), `scripts/verify-brand-visual-system.ts` (client access helper)
- [ ] Steps: failing guards → implement → `npm run verify:brand-treatment-v1 && npm run verify:brands-ci && npx tsc --noEmit --pretty false && npm run lint:brands` → commit `feat(editor): style pack and brand pickers for every plan; AI-image controls follow the image gate`.

### Task 4: Final gate (session)

- [ ] Full `ci.yml` step list + tsc + build on the final head; branch-wide security review; final whole-branch review.
- [ ] ADR 0059 **Amendment 2** (pin opens to every plan; image admission anchored at pin time; the two system writers covered); `CONTEXT.md` term **Pin admission**; close #430 in the PR body.
- [ ] Deploy note in the PR: after `deploy.sh`, run `npx tsx scripts/backfill-brand-visual-pin-admission.ts --dry-run` then `--apply` once on prod (D3).

## Acceptance Criteria

- [ ] A FREE account and a `rollout-wait` PRO account can pin a Brand Profile / choose a ชุดสไตล์ per clip / promote, and a stock render on that clip carries the pack's mood, subtitles, pacing and music (verify scripts).
- [ ] Neither account can obtain `brandVisualAcceptanceJson` or an AI image through any route (jobs, broll-window/generate, fetch-stock image path, preview) — verify scripts + security review.
- [ ] Hero-Script send-to-editor and First-Clip auto-spine pins written for a non-admitted owner no longer admit that owner to images (#430 regression tests).
- [ ] Legacy pins: backfill dry-run on prod reports counts; admitted owners keep rerender grandfathering.
- [ ] Exactly two additive columns; all suites + build + CI green; no English internal terms in copy.

## Out of scope
- Changing `BRAND_VISUAL_ROLLOUT_PERCENT` (ops, Mew).
- Wave 2 treatments; per-clip กำหนดเอง semantics (open product call from wave 1).

## Status
interviewed 2026-09-03 | approved: pending (Mew — D1–D3 to confirm at execute time; recommendations recorded) | executed: deferred to the next session (`/mew-kickoff execute docs/plans/2026-09-03-brands-pack-pin-for-all.md`) | delivered: -
