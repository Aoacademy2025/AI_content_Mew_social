# Task A3 — Code audit: request fan-out, DB work per request, render pipeline (read-only)

**Date:** 2026-09-12 · **Worktree:** `AI_content_Mew_social-perf-a3-code-audit` (branch `mew/perf-a3-code-audit`, at `origin/main` = `84e4d8c2`)
**Stack as built (not as `CLAUDE.md` says):** Next **16.3.0** (Turbopack, App Router) · React 19.2.3 · Prisma 6.19.3 on SQLite · Clerk · Remotion.
**No production code was changed.** One temporary, env-gated query logger was added to `src/lib/prisma.ts` for the measurement and reverted; `git diff` is empty. No production access, no customer data anywhere in this report.

> **Deviation from `CLAUDE.md` worth flagging to Mew:** there is no `src/middleware.ts` in this tree. Next 16 renamed it and the file is now **`src/proxy.ts`** (exports `proxy`, build output says `ƒ Proxy (Middleware)`). The Clerk matcher / static-media whitelist gotcha in `CLAUDE.md` still applies, but at the new path. Likewise `src/lib/run-render.ts` is now **`src/lib/render/run-render.ts`**, and `src/components/remotion/` does not exist.

---

## §A3.1 Query and write count per endpoint (local run)

### Method

`next dev` on port 3105 against a freshly `prisma db push`-ed local `prisma/dev.db` seeded with 31 users (1 ADMIN, 6 PRO, 2 BUSINESS, 8 trialing, rest FREE), 24 payments, 40 projects/videos/video-jobs/render-jobs, 12 tickets, 15 notifications, 8 product updates, 600 telemetry events, 8 SiteConfig keys, 10 music rows.

Authentication used the **internal service-actor header** (`x-heroai-service-secret` + `x-heroai-act-as`, `src/lib/mcp/service-actor.ts`), which `src/proxy.ts` lets through and `getCurrentUser()` honours. This is a real end-to-end HTTP request through the real proxy and the real route handler. Its **only** difference from a browser Clerk session is the auth prefix, quantified exactly in §A3.2: **service-actor = Clerk + 1 statement** (a trailing full `User` re-read), and the first lookup is `WHERE id = ?` instead of `WHERE clerkId = ?`. Subtract 1 from every number below for the Clerk-session equivalent.

Counting was done by slicing the dev-server log between line offsets around one `curl`, after a warm-up request to the same route. The counter snippet is reproduced at the end of this section.

**Correctness note (a trap for whoever repeats this):** in Next dev, `src/lib/prisma.ts` can be instantiated twice over the same global `PrismaClient`, which registers the `$on("query")` listener twice and **doubles every logged statement**. The first non-admin measurement showed exactly 2× counts before this was caught. The logger below is guarded with a `globalThis` flag; every number in this report was taken with the guard in place, and two independent runs (r1/r2) agree within ±2 (log-flush boundary jitter).

### Results — ADMIN, PRO, `subStatus='active'`, **with** a qualifying `Payment` row

Auth prefix = **9** statements, **0** writes (`/api/admin/storage` is the pure-prefix probe: it does no DB work of its own).

| Endpoint | HTTP | total r1 | total r2 | writes | route's own (total − 9) |
|---|---|---|---|---|---|
| `/api/user/me` | 200 | 30 | 31 | 0 | **21–22** |
| `/api/admin/insights?days=30` | 200 | 30 | 30 | 0 | **21** |
| `/api/admin/revenue` | 500¹ | 28 | 26 | 0 | 17–19¹ |
| `/api/admin/stats` | 200 | 21 | 23 | 0 | 12–14 |
| `/api/admin/cleanup?days=7` | 200 | 18 | 18 | 0 | 9 |
| `/api/user/stats` | 200 | 18 | 18 | 0 | 9 |
| `/api/admin/support?status=OPEN` | 200 | 12 | 12 | 0 | 3 |
| `/api/admin/settings` | 200 | 12 | 11 | 0 | 2–3 |
| `/api/admin/music` | 200 | 12 | 11 | 0 | 2–3 |
| `/api/updates?summary=1` | 200 | 11 | 11 | 0 | 2 |
| `/api/videos` | 200 | 11 | 11 | 0 | 2 |
| `/api/notifications` | 200 | 11 | 10 | 0 | 1–2 |
| `/api/editor-projects` | 200 | 10 | 10 | 0 | 1 |
| `/api/admin/storage` | 200 | 9 | 9 | 0 | **0** |

¹ `/api/admin/revenue` returned 500 locally because the seeded Stripe key is fake. **The route makes live Stripe API calls on every request** — `for await (const charge of stripe.charges.list(...))` and `stripe.refunds.list(...)` (unbounded async pagination) plus one `stripe.invoices.list()` per bundle subscription inside a `Promise.all` (`src/lib/revenue-growth.server.ts:100`, `:188`, `:202`). The counts above are therefore a **lower bound**: they are the DB work that completed before the first Stripe call threw. This is the single biggest latency risk on `/admin/revenue` and A2's cold number will be dominated by Stripe round-trips, not SQLite.

### Results — non-admin PRO user

| Endpoint | HTTP | total | note |
|---|---|---|---|
| `/api/user/me` | 200 | **35** | +5 vs ADMIN: `resolveHeroAiImageAccess` short-circuits for the ADMIN/beta cohort (`isHeroAiBetaUser`) and skips a 5th `resolvePaidEquivalentEntitlement` + starter-allowance read. **35 is the number that describes a paying customer.** |
| `/api/user/stats` | 200 | 18 | |
| `/api/updates?summary=1` | 200 | 11 | |
| `/api/videos` | 200 | 11 | |
| `/api/notifications`, `/api/editor-projects` | 200 | 10 | |
| every `/api/admin/*` | **403** | **9–10** | A rejected admin request still pays the entire 9-statement entitlement prefix before the role check. |

### Results — ADMIN, PRO, `subStatus='active'`, **without** a qualifying `Payment` row

This is the same account with its `Payment` row deleted, re-measured after a clean dev-server restart. Every endpoint gains **+4 statements and one write transaction**:

| Endpoint | total | reads | **writes** |
|---|---|---|---|
| `/api/user/me` | 38 | 36 | **2** |
| `/api/admin/insights?days=30` | 34 | 33 | **1** |
| `/api/admin/revenue` | 32 (500) | 31 | **1** |
| `/api/admin/stats` | 25 | 24 | **1** |
| `/api/user/stats` | 22 | 21 | **1** |
| `/api/admin/cleanup?days=7` | 21 | 20 | **1** |
| `/api/admin/support?status=OPEN` | 16 | 15 | **1** |
| `/api/admin/settings`, `/api/admin/music`, `/api/updates`, `/api/videos` | 15 | 14 | **1** |
| `/api/notifications`, `/api/editor-projects` | 14 | 13 | **1** |
| **`/api/admin/storage`** | **13** | 12 | **1** |

The write is `syncUserEntitlement`'s downgrade guard (`src/lib/entitlements.ts:365`), and it runs as a **real write transaction** — the auth prefix for this account is:

```
 1. SELECT User      (63 cols, by id/clerkId)
 2. SELECT User      (15 cols)   syncUserEntitlement
 3. SELECT User      (10 cols)   syncStoredBundleEntitlementForUser
 4. SELECT BundleEntitlement     by email
 5. SELECT User      (11 cols)   resolvePaidEquivalentEntitlement
 6. SELECT Payment               relation load
 7. SELECT CouponRedemption      relation load (LEFT JOIN Coupon)
 8. SELECT AdministratorGrant    relation load
 9. BEGIN IMMEDIATE          ← takes the SQLite WRITE lock
10. UPDATE User SET plan=?, planExpiresAt=?, trialEndsAt=?, bundlePrimary=?, usage*=? …
11. COMMIT
12. SELECT User      (15 cols)
13. SELECT User      (63 cols)   [service-actor only]
```

The `UPDATE` matches **0 rows** (its `WHERE` requires `subStatus <> 'active'`), so it changes nothing — but `BEGIN IMMEDIATE` acquires the SQLite write lock regardless, on **every authenticated request, including the ones that end in 403**. `/api/user/me` does it twice, because `syncUserEntitlement` runs twice per request (see §A3.2).

**Exact predicate for who is affected** (from `src/lib/entitlements.ts:347`) — the early return requires `action !== "DOWNGRADE"` **AND** (`plan == 'FREE'` **OR** an active trial). So the write fires on every request for any account where:

> `plan IN ('PRO','BUSINESS')` **AND** `trialEndsAt IS NULL OR trialEndsAt <= now` **AND** `resolvePaidEquivalentEntitlement()` finds no evidence — i.e. no `Payment` with `status='PAID' AND periodDays>0 AND plan IN ('PRO','BUSINESS')`, no active bundle with `bundleAmountThb > 0`, no live GRANT coupon, no live `AdministratorGrant`.

FREE users and active trials are unaffected (they early-return). Candidates on prod: admin/comped rows whose plan label was set by hand, legacy manual payments that never wrote a `Payment` row, credit-pack-only payers, bundle rows with a null `bundleAmountThb`, and `outcome='LEGACY'` coupon redemptions. **A1b can count them read-only:**

```sql
SELECT COUNT(*) FROM User u
WHERE u.plan IN ('PRO','BUSINESS')
  AND (u.trialEndsAt IS NULL OR u.trialEndsAt <= strftime('%s','now')*1000)
  AND NOT EXISTS (SELECT 1 FROM Payment p
                  WHERE p.userId = u.id AND p.status = 'PAID'
                    AND p.periodDays > 0 AND p.plan IN ('PRO','BUSINESS'))
  AND NOT EXISTS (SELECT 1 FROM AdministratorGrant g
                  WHERE g.userId = u.id AND g.revokedAt IS NULL)
  AND NOT (u.bundleStatus = 'ACTIVE' AND COALESCE(u.bundleAmountThb,0) > 0
           AND u.bundleAccessExpiresAt > strftime('%s','now')*1000);
```

This is the strongest local candidate for the HERO-10 write-lock contention: it is not one slow transaction, it is one **short** write transaction multiplied by every request of an affected user.

### Expected-finding verdict

| Brief's expectation | Measured | Verdict |
|---|---|---|
| `getCurrentUser()` + `syncUserEntitlement()` ≈ 5–8 queries | **8** (Clerk, paid evidence) / **12** incl. 1 write (no evidence) | **at the top of the range at best, 50 % over it at worst** |
| `/api/user/me` ≈ 15–20 | **29** (Clerk, ADMIN) / **34** (Clerk, non-admin paying customer) / **37** + 2 writes (no evidence) | **refuted — roughly double** |

### The query counter (report-only snippet, not a repo script)

Temporary logger, added to `src/lib/prisma.ts` for the run and reverted afterwards:

```ts
// in the PrismaClient constructor options
...(process.env.A3_QUERY_LOG === "1"
  ? { log: [{ emit: "event" as const, level: "query" as const }] }
  : {}),

// immediately after the client is constructed — the globalThis guard is REQUIRED:
// Next dev can instantiate this module twice over the same global client and
// double every logged line.
if (process.env.A3_QUERY_LOG === "1"
  && !(globalThis as unknown as { __a3QueryLog?: boolean }).__a3QueryLog) {
  (globalThis as unknown as { __a3QueryLog?: boolean }).__a3QueryLog = true;
  (prisma as unknown as { $on: (e: string, cb: (x: { query: string }) => void) => void })
    .$on("query", (e) => console.log("prisma:query " + e.query));
}
```

`DEBUG=prisma:query` alone emits **nothing** on Prisma 6.19 — that is why the event hook is needed.

Driver:

```bash
#!/bin/bash
set -u
WT=<worktree>; LOG=<dev-server-log>; BASE=http://localhost:3105
SEC=$(grep '^MCP_SERVICE_SECRET=' $WT/.env | cut -d= -f2- | tr -d '"')
ACT=${A3_ACT:-<seeded user id>}

hit () {  # $1 = slug, $2 = path
  curl -s -o /dev/null -H "x-heroai-service-secret: $SEC" -H "x-heroai-act-as: $ACT" "$BASE$2"
  sleep 4; local before=$(wc -l < "$LOG")
  curl -s -o "$1.body.json" -w "%{http_code} %{time_total}\n" \
    -H "x-heroai-service-secret: $SEC" -H "x-heroai-act-as: $ACT" "$BASE$2"
  sleep 4; local after=$(wc -l < "$LOG")
  sed -n "$((before+1)),${after}p" "$LOG" | grep -a 'prisma:query' | sed 's/^prisma:query //' > "$1.sql"
  echo "$1 total=$(wc -l < $1.sql) writes=$(grep -acE '^\s*(INSERT|UPDATE|DELETE)' $1.sql)"
}
# start the server with:  A3_QUERY_LOG=1 PORT=3105 npm run dev -- --port 3105
hit user-me /api/user/me
hit admin-insights "/api/admin/insights?days=30"
# … one line per endpoint
```

---

## §A3.2 `getCurrentUser()` chain — per-step, with duplicate marking

**This is Task B3's contract.** Measured directly by replaying the Clerk fast path statement-by-statement against the seeded DB (`getCurrentUserForClerkId` is module-private, so its exact sequence from `src/lib/clerk-auth.ts:94-113` was replayed; `syncUserEntitlement` itself was called for real).

### `getCurrentUser()` — Clerk fast path, steady state, paid evidence = **8 statements**

| # | Function | Query | Duplicate of a row already loaded? |
|---|---|---|---|
| 1 | `clerk-auth.ts:96` `getCurrentUserForClerkId` | `SELECT User` (all 63 cols) `WHERE clerkId = ?` | N — first load of the row |
| — | `clerk-auth.ts:103` admin upgrade | `UPDATE User SET role` | none (only when `role != 'ADMIN'` and email qualifies) |
| 2 | `entitlements.ts:185` `syncUserEntitlement` | `SELECT User` (15 cols) `WHERE id = ?` | **Y — same row as #1** |
| 3 | `bundle-entitlement.ts:103` `syncStoredBundleEntitlementForUser` | `SELECT User` (10 cols) `WHERE id = ?` | **Y — same row as #1/#2** |
| 4 | `bundle-entitlement.ts:120` | `SELECT BundleEntitlement WHERE email = ?` | N — but the email came from #3, which re-read it |
| 5 | `paid-equivalent-entitlement.server.ts:249` `resolvePaidEquivalentEntitlement` | `SELECT User` (11 cols) `WHERE id = ?` | **Y — same row as #1/#2/#3** |
| 6 | same call, relation | `SELECT Payment WHERE status=? AND periodDays>? AND userId IN (?)` | N |
| 7 | same call, relation | `SELECT CouponRedemption LEFT JOIN Coupon … userId IN (?)` | N |
| 8 | same call, relation | `SELECT AdministratorGrant WHERE userId IN (?)` | N |
| — | `entitlements.ts:347` early return | — | returns here **only** when the plan is FREE or a trial is active |
| 9–11 | `entitlements.ts:365` `updateMany` (paid plan, no evidence) | `BEGIN IMMEDIATE` / `UPDATE User` / `COMMIT` | **write; matches 0 rows in steady state** |
| 12 | `entitlements.ts:411` final re-read | `SELECT User` (15 cols) | **Y** |
| — | `clerk-auth.ts:109` `demoteLapsedPaidPlan` | 0 queries when `classifyEntitlement().action !== 'DOWNGRADE'` | — |

So: **4 reads of the identical `User` row** (#1, #2, #3, #5) before any route code runs — 5 with #12 on the no-evidence path.

### `/api/user/me` — full request chain (non-admin paying customer, Clerk-equivalent **34 statements**)

| Step | Function (file) | Statements | Duplicate? |
|---|---|---|---|
| 1 | `getCurrentUser()` (`clerk-auth.ts`) | **8** (as above) | 4 of them re-read the same `User` row |
| 2 | route's own `prisma.user.findUnique` (`user/me/route.ts:26`) | **1** — `SELECT User` (18 cols) `WHERE id=?` | **Y — `authUser` already holds every one of these columns** |
| 3 | `syncUsageWindow` → `syncSharedUsageCycle` (`usage-limits.ts:53`) | **9** | contains a **second full `syncUserEntitlement`** (7 stmts, all duplicates of step 1) + 2 more `SELECT User` (10 cols) around the rollover check |
| 4 | `resolvePaidEquivalentEntitlement(authUser.id)` (route line 75) | **4** | **Y — 3rd execution of the identical 4-statement evidence bundle** |
| 5 | `resolveHeroAiImageAccess` (`internal-ai-access.ts:159`) | **4 + 2** | **Y — 4th `resolvePaidEquivalentEntitlement`**, plus `SELECT User`(6) + `SELECT ConversionTrialAiImageAllowance` from `getStarterAiImageAllowanceStatus`. Skipped entirely for ADMIN/beta accounts (`isHeroAiBetaUser` early return) — that is the whole ADMIN-vs-customer delta |
| 6 | `resolveHeroScriptAccess` (`hero-script-rollout.server.ts:99`) | **4** | **Y — 5th** |
| 7 | `resolveBrandVisualAccess` (`brand-visual-rollout.server.ts:102`) | **4** | **Y — 6th** |
| 8 | `getStarterAiImageAllowanceStatus` (route line 79) | **2** | **Y — same two statements as inside step 5** |
| 9 | `resolveFirstClipPath` (`first-clip-path.server.ts:41-48`) | **4 + 1 + 1** | **Y — 7th `resolvePaidEquivalentEntitlement`**, plus `SELECT Video` (first completed clip) and `SELECT User` (3 cols: `trialStartedAt/trialEndsAt/suspended`) — **another duplicate of the same row** |
| 10 | `resolveManagedStockAccess` | 0 | flag-gated, no query |
| 11 | `decideBrandLibraryAccess`, `classifyEntitlement`, `limitsForPlan` | 0 | pure |

Because steps 4–9 run inside one `Promise.all`, several of those `resolvePaidEquivalentEntitlement` calls collapse onto the same event-loop tick but each still issues its own 4 statements — **there is no request-scoped cache anywhere in this chain.**

Measured per-table tally for one ADMIN `/api/user/me` (30 statements):

```
14 × User   4 × Payment   4 × CouponRedemption   4 × AdministratorGrant
 2 × BundleEntitlement   1 × Video   1 × ConversionTrialAiImageAllowance
```

**14 reads of one `User` row in a single request**, and the 3-table paid-equivalent evidence bundle executed **4 times** (5 for a non-admin: 35 statements, 5×Payment/CouponRedemption/AdministratorGrant). Nothing in the request mutates any of those rows between reads.

The same pattern is visible on cheaper endpoints — `/api/user/stats` (18 statements) runs the evidence bundle twice because it also calls `syncUsageWindow`; `/api/admin/settings` spends **9 of its 11 statements** on the entitlement prefix, and reads all 32 `SiteConfig` rows with one query.

**Design note for B3:** the cheapest correct fix is a request-scoped memo (React `cache()` or an `AsyncLocalStorage` keyed on `userId`) around `resolvePaidEquivalentEntitlement` and `syncUserEntitlement` — not new queries, not new indexes. That alone removes 3–4 evidence bundles (12–16 statements) and one whole `syncUserEntitlement` from `/api/user/me`. Passing the already-loaded `User` row down instead of re-selecting it removes most of the remaining 14 `User` reads.

---

## §A3.3 Every `$transaction(async` site

**122 transaction callbacks across 44 files.** Enumerated with the TypeScript compiler API (not regex — a brace-matching regex over-ran on template literals and produced 11 false positives). Each callback body was scanned for direct external I/O, and every awaited helper it calls was resolved one level and scanned too.

| Class | Count |
|---|---|
| DB-only (`tx.*` and `*InTransaction` helpers only) | **120** |
| Direct external I/O inside the callback | **1** |
| Dynamic `await import()` inside the callback | **1** |
| External I/O reached via an awaited helper (transitive, 1 level) | **0** |

### Holder candidates

| Site | Span | Awaited inside | Verdict / max plausible hold |
|---|---|---|---|
| `src/lib/hero-voice-canary-ledger.server.ts:995` | 57 lines, 3 loops | `loadRunForMutation`, `verifyLedgerWithClient`, `appendHeroVoiceCanaryLedgerRecordInTransaction`, `tx.reviewRun.update` | The only **direct** I/O match is an `ffmpeg`-shaped identifier inside the ledger-evidence validation. **Hold: bounded by ledger size, not by a network call** — it is CPU + DB over the run's slot manifest. Gated behind `HERO_VOICE_CANARY_*` (never on together with prod clone). **Estimated worst case: hundreds of ms.** Low priority: canary-only path. |
| `src/lib/brand-profile-library.server.ts:941` | 125 lines, 4 `tx.*` ops | `await import(…)` + `createBrandProfileFromPayloadInTransaction`, `pinProjectBrandRevisionInTransaction`, `starterAllowanceStatusInTransaction` | A **dynamic module import inside an open write transaction**. First call per process pays module resolution + compile while holding the lock; afterwards it is a resolved-cache hit. **Max plausible hold: first call after a deploy/restart — tens to low hundreds of ms; steady state ≈ 0.** Worth hoisting the import above the `$transaction`, but it is not the HERO-10 shape. |
| `src/lib/brand-setup.server.ts:42` | 61 lines | `resolveBrandProfileRevisionForNewProjectInTransaction`, `publishBrandProfileDraft`, `saveBrandProfileDraft`, `createBrandProfileFromPayloadInTransaction`, `createEditorProject` | **False positive** — the matches were `GEMINI_VOICES.some(...)` / `RUNPOD_HERO_VOICES.some(...)` / `["gemini","elevenlabs","omnivoice"].includes(...)`, i.e. array predicates on constant lists, not provider calls. DB-only. Already wrapped in `withTransientSqliteRetry`. |

### The honest conclusion on write-lock hold

**No `$transaction` in this codebase awaits a network call, an ffmpeg spawn, or file I/O inside the callback.** The 44-file, 122-site sweep found nothing of the shape "transaction opened, HTTP request awaited, transaction committed". The transactions are uniformly short and DB-only, and the longest ones by statement count are in `ai-generation-jobs.server.ts`, `story-film.server.ts` and `hero-voice-generation.server.ts` — all `tx.*` only.

That makes the §A3.1 finding the better explanation for HERO-10: **not one long holder, but a very large number of very short `BEGIN IMMEDIATE` write transactions** issued by `syncUserEntitlement` on the authentication path of every request from an affected account, against a single-process web app (`ecosystem.config.js` gives `ai-content` no `instances` key → one fork) sharing one SQLite file with 2 × `render-worker`, `mcp-video-worker` and `story-film-system-worker`. A1b should read this section together with §A3.1 rather than looking for a long transaction.

---

## §A3.4 Fonts by route (excluding `src/remotion/**`) — **B4's contract**

### What is loaded, globally

`src/app/layout.tsx:20` declares one `GOOGLE_FONTS_URL` with **24 families**, linked as a **render-blocking stylesheet on every route** (`layout.tsx:52`), plus `Inter` via `next/font/google` (self-hosted, not blocking).

Measured (Chrome UA, `display=swap`):

| Variant | CSS bytes | `@font-face` blocks | distinct `.woff2` URLs |
|---|---|---|---|
| **current, 24 families** | **109,637 B (107.1 KB)** | **278** | **240** |
| 24 − the 5 with no consumer anywhere | 98,794 B (96.5 KB) | 251 | 221 |
| the 12 editor-picker families (editor routes only) | 71,261 B (69.6 KB) | 182 | 167 |
| Bai Jamjuree + IBM Plex Sans Thai only (what non-editor routes need) | **11,294 B (11.0 KB)** | 28 | 28 |

Every prerendered route in the build carries this link — verified by grepping `fonts.googleapis.com/css2` in all 26 prerendered HTML files (`true` for all except `/_global-error`).

### Family → consumer → route map

`src/app/layout.tsx` itself is excluded as a consumer (it is the loader). `src/remotion/**` is excluded per the brief.

| Family | Non-remotion consumers | Route(s) that render it |
|---|---|---|
| **Kanit** | `_v2/fonts.ts` (`next/font`, self-hosted), `_components/constants.ts` `FONTS_LIST`, `_v2/subtitle-style.ts`, `video-editor/page.tsx`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `top-nav.tsx`, `return-loop-card.tsx`, `revenue-growth-dashboard.tsx`, `dashboard/page.tsx`, `videos/page.tsx`, `settings/page.tsx`, `pricing*`, `admin/*`, `ai-studio*`, `hero-script/page.tsx`, `headline-hook.ts`, `story-film-editorial.ts`, `mcp/orchestrator-steps.ts` | `/video-editor`, `/video-creator`, `/dashboard`, `/videos`, `/settings`, `/pricing`, `/admin`, `/admin/users`, `/admin/coupons`, `/ai-studio`, `/ai-studio/story-film`, `/hero-script` — **already self-hosted via `next/font` for the v2 editor** |
| **Noto Sans Thai** | `_v2/fonts.ts` (`next/font`, self-hosted), `_v2/tokens.ts`, `FONTS_LIST`, `video-creator/page.tsx`, `admin/insights/page.tsx`, `ThumbnailEditor.tsx`, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/admin/insights` — **already self-hosted via `next/font`** |
| **Bai Jamjuree** | `globals.css:974`, `page.tsx` (marketing), `auth-shell.tsx`, `pricing-toggle.tsx`, `youtube-lite.tsx`, `first-clip-hero.tsx`, `docs/page.tsx`, `docs/[slug]/page.tsx`, `FONTS_LIST`, `video-creator/page.tsx` | **every route** (`globals.css`) + `/`, `/login`, `/register`, `/docs/*`, `/dashboard`, `/video-editor`, `/video-creator` |
| **IBM Plex Sans Thai** | `page.tsx` (marketing), `auth-shell.tsx`, `FONTS_LIST`, `video-creator/page.tsx` | `/`, `/login`, `/register`, `/video-editor`, `/video-creator` |
| **Sarabun** | `FONTS_LIST`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `send-email.ts` (email HTML, not browser), `ThumbnailEditor.tsx`†, `StoryFilmWorkbench.tsx`, `headline-hook.ts`, `story-film-editorial.ts`, `api/story-film/[transport]/route.ts` (server JSON) | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **Prompt** | `FONTS_LIST`, `video-creator/page.tsx`, `style-pack-catalog.ts`, `StoryFilmWorkbench.tsx`, `ThumbnailEditor.tsx`†, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **Mitr** | `FONTS_LIST`, `video-creator/page.tsx`, `StoryFilmWorkbench.tsx`, `ThumbnailEditor.tsx`†, `headline-hook.ts`, `story-film-editorial.ts` | `/video-editor`, `/video-creator`, `/ai-studio/story-film` |
| **K2D** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Krub** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Pridi** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Chonburi** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Itim** | `FONTS_LIST`, `video-creator/page.tsx` | `/video-editor`, `/video-creator` |
| **Chakra Petch** | *none outside `src/remotion/**`* | **no browser route** (burn-only; in the Remotion URLs) |
| **Fahkwang** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Charm** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Sriracha** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Oswald** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Anton** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Bebas Neue** | *none outside `src/remotion/**`* | **no browser route** (burn-only) |
| **Bangers** | *none anywhere* | **none — not in any Remotion URL either** |
| **Lobster** | *none anywhere* | **none — not in any Remotion URL either** |
| **Pacifico** | *none anywhere* | **none — not in any Remotion URL either** |
| **Playfair Display** | *none anywhere* | **none — not in any Remotion URL either** |
| **Righteous** | *none anywhere* | **none — not in any Remotion URL either** |

† `src/components/thumbnail/ThumbnailEditor.tsx` (24 font declarations) has **no importer anywhere in `src` or `scripts`** — it is dead code and must not be treated as a live consumer.

**Summary for B4:** 12 families are reachable in the browser via the editor's `FONTS_LIST` picker and the in-editor Remotion Player preview (`/video-editor`, `/video-creator`, `/ai-studio/story-film`). 7 more (Chakra Petch, Fahkwang, Charm, Sriracha, Oswald, Anton, Bebas Neue) appear only in the burn-side Remotion URLs and have **no browser consumer at all**. 5 (Bangers, Lobster, Pacifico, Playfair Display, Righteous) appear in **no** Remotion URL and **no** app file — they are pure dead weight in the global stylesheet. Two of the 12 (Kanit, Noto Sans Thai) are already self-hosted through `next/font` for the v2 editor, so the Google copy is partly redundant on the exact route that needs them most.

### Remotion self-loading — confirmed

`src/remotion/**` loads its own Google Fonts URLs and **imports nothing from `src/app/layout.tsx`**:

| File | Families in its own URL |
|---|---|
| `src/remotion/captionStyles.ts:219` | 4 — Sarabun, Kanit, Prompt, Mitr |
| `src/remotion/SubtitleOverlayComposition.tsx:12` | 19 |
| `src/remotion/VideoComposition.tsx:7` | 1 — Sarabun (`@import url(...)`) |
| `src/remotion/ShortVideoComposition.tsx:26` | 19 (a 4th file, not named in Global Constraints — flagged so B4 keeps it in sync) |

The only references to `layout.tsx` inside `src/remotion/` are two "keep in sync with" **comments** (`SubtitleOverlayComposition.tsx:9`, `ShortVideoComposition.tsx:26`). Grep for `app/layout` / `@/app/` under `src/remotion/` returns nothing else. **Every family that Remotion needs is present in a Remotion-owned URL**, so trimming `layout.tsx` cannot change render output. B4 must still leave the four Remotion files untouched (Global Constraints), and should keep the "in sync" comments honest by updating them.

---

## §A3.5 Per-route First Load JS

**Method note — a real deviation from the brief.** Next 16's `next build` route table no longer prints `Size` / `First Load JS`; it prints `Revalidate` / `Expire` only, and Next 16 emits no `app-build-manifest.json`. There is nothing to copy. The numbers below were computed instead by extracting every `/_next/static/**.js` referenced by each route's prerendered HTML (`.next/server/app/*.html`) and summing the on-disk raw and gzip sizes; dynamic (`ƒ`) routes were fetched from `next start` on port 3106 using the service-actor header and processed identically. `/video-editor` is prerendered **and** was fetched live — both methods agree to the byte, which validates the method.

Build: `BUILD_NO_LINT=1 npm run build` → compiled in 29.0 s, TypeScript in 15.9 s, 186 static pages generated, `.next/BUILD_ID` written. No OOM, no `NODE_OPTIONS` bump needed.

| Route | JS chunks | JS raw | JS gzip | CSS files | CSS raw | CSS gzip | blocking Google-Fonts link |
|---|---|---|---|---|---|---|---|
| **`/video-editor`** | **34** | **2234.4 KB** | **657.8 KB** | 3 | 277.8 KB | 38.9 KB | yes |
| `/brands` | 30 | 1539.9 KB | 478.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/video-creator` | 28 | 1484.2 KB | 458.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/hero-script` | 29 | 1418.7 KB | 445.6 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin` | 27 | 1417.3 KB | 438.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/settings` | 29 | 1414.9 KB | 440.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/insights` | 25 | 1382.1 KB | 427.7 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/dashboard` | 27 | 1375.2 KB | 430.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/content` | 28 | 1369.6 KB | 430.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/videos` | 25 | 1347.6 KB | 422.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/ai-studio` | 25 | 1342.0 KB | 420.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/revenue` | 25 | 1336.7 KB | 418.7 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/users` | 26 | 1336.0 KB | 420.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/style` | 27 | 1336.8 KB | 421.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/coupons` | 26 | 1327.3 KB | 417.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/updates` | 25 | 1320.4 KB | 415.1 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/admin/loanwords` | 25 | 1316.2 KB | 413.8 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/updates` | 25 | 1313.5 KB | 413.9 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/` (marketing) | 17 | 1311.5 KB | 412.5 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/pricing` | 24 | 1300.8 KB | 409.5 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/docs`, `/docs/*` (8 pages) | 18 | 1202.3 KB | 371.4 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/_not-found` | 12 | 1114.2 KB | 346.2 KB | 2 | 269.7 KB | 38.0 KB | yes |
| `/forgot-password`, `/reset-password` | 7 | **913.4 KB** | **288.9 KB** | 0 | — | — | yes |

**Largest First Load JS route: `/video-editor` — 2234.4 KB raw / 657.8 KB gzip across 34 chunks.** The floor that every route pays (framework + Clerk + shared client islands) is ~913 KB raw / ~289 KB gzip, and the dashboard shell adds ~400 KB raw on top of it before a page's own code.

### `next/dynamic` usages: **0**

```
$ grep -rn "next/dynamic" src | wc -l
0
```

`React.lazy` is also used nowhere in `src`. **There is no code splitting in this application beyond Next's automatic route-level split.** Every client component a route's module graph touches is in that route's first load. This is the single mechanical explanation for `/video-editor`'s 2.2 MB and for the ~400 KB the dashboard shell adds to `/admin` and `/dashboard`.

---

## §A3.6 Render pipeline — read-only review (findings only, nothing enters Phase B/C)

Read: `src/lib/render/run-render.ts`, `scripts/render-worker.ts`, `scripts/mcp-video-worker.ts`, and the render/stock env objects in `ecosystem.config.js`. **Nothing under `src/remotion/**`, `src/lib/render/run-render.ts` or `ecosystem.config.js` was modified.**

### Concurrency and timeouts as configured

| Setting | Value | Source |
|---|---|---|
| `ai-content` (web) PM2 instances | **1** (no `instances` key → fork, single process) | `ecosystem.config.js:140` |
| web heap | `--max-old-space-size=3072`, `max_memory_restart: 4G` | `ecosystem.config.js:152-153,167` |
| `render-worker` instances | **2** (`exec_mode: fork`) | `ecosystem.config.js:459-460` |
| render-worker heap | `--max-old-space-size=4096`, `max_memory_restart: 5G` | `ecosystem.config.js:476,464` |
| `RENDER_CONCURRENCY` (frame threads per job) | **3** → 2 × 3 = 6 threads on 8 vCPU | `renderRuntimeEnv`, `ecosystem.config.js:45` |
| `RENDER_JOB_CONCURRENCY` (slots per process) | clamped to `[1, min(4, cpus)]`, default **1** | `run-render.ts:132-137` |
| `RENDER_OFFTHREAD_CACHE_MB` / `RENDER_JPEG_QUALITY` | 128 / 90 | `ecosystem.config.js:47-48` |
| `selectComposition` timeout | 120 000 ms | `run-render.ts:336` |
| `renderMedia` timeout | 7 200 000 ms (2 h) | `run-render.ts:468` |
| worker stall watchdog | `RENDER_STALL_MS` 120 000 ms (progress-derived) | `render-worker.ts:29` |
| worker wall-clock cap | `RENDER_WALLCLOCK_MS` 45 min | `render-worker.ts:30` |
| dead-job sweep threshold | `STALL_MS + 3×WATCHDOG_MS` = 150 s | `render-worker.ts:35` |
| worker poll | `RENDER_WORKER_POLL_MS` 3000 ms | `render-worker.ts:28` |
| PM2 `kill_timeout` (graceful drain) | 30 000 ms | `ecosystem.config.js:463` |
| `mcp-video-worker` concurrency | `MCP_WORKER_CONCURRENCY` default **2**, clamped `[1,4]`, **single PM2 instance by design** | `mcp-video-worker.ts:34-39`, `ecosystem.config.js:415` |
| mcp worker poll / stall sweep / refund retry | 4000 ms / 60 000 ms / ≥15 000 ms | `mcp-video-worker.ts:12-21` |
| `STOCK_NORMALIZE_CONCURRENCY` / preset | 1 / `ultrafast` (runs in **`ai-content`**, not the worker) | `ecosystem.config.js:54-55` |

### Findings (follow-ups only — no proposals)

1. **F1 — one web process, four writer processes, one SQLite file.** `ai-content` runs a single Node process (no `instances`), and shares `prisma/dev.db` with 2 × `render-worker`, 1 × `mcp-video-worker` (2 in-process orchestrations) and `story-film-system-worker`. Every `BEGIN IMMEDIATE` from §A3.1 competes with those. This is the structural context A1b needs for the HERO-10 write-lock question; the render side is not the source of the extra transactions, the auth path is.
2. **F2 — stock normalisation runs in the web process.** `STOCK_NORMALIZE_CONCURRENCY=1` / `STOCK_NORMALIZE_PRESET=ultrafast` are deliberately pinned, and the comment states this runs "in the ai-content fetch-stock route, not render-worker". ffmpeg work therefore lands in the same single process that serves `/api/user/me`. Recorded as an observation only; touching it is out of scope under Global Constraints.
3. **F3 — `/api/admin/cleanup` blocks the web event loop with synchronous filesystem recursion.** `src/lib/media-cleanup.ts` uses `fs.readdirSync` / `fs.lstatSync` recursively (lines 177, 192, 265, 354, 521, 531, 577, 660, 670). On the single web process this is a hard block for the duration of the walk — it stalls every other request, including renders' status polls. `maxDuration = 120` is declared on the route.
4. **F4 — `/api/admin/cleanup` also runs 6 unbounded `findMany` scans.** `src/lib/media-reference-graph.ts` reads `video`, `videoJob`, `editorProject` (drafts), `renderJob`, `generatedImage`, `aiGenerationJob` with **no `take:` on any of them** — full-table reads that grow with the database.
5. **F5 — `/api/admin/storage` shells out.** `getStorageHealth` runs `df -kP` (5 s timeout) and `du -sk` per target path (15 s timeout each) via `execFile`. On a large media directory the `du` walk is the whole cost of that endpoint (its DB cost is literally 0 statements beyond the auth prefix). The 15 s timeout is the ceiling per path.
6. **F6 — `/api/admin/revenue` performs unbounded Stripe pagination per request.** `for await (const charge of stripe.charges.list(...))` and the same for refunds, plus `stripe.invoices.list()` per bundle subscription inside a `Promise.all`. Latency is proportional to Stripe history, not to local data, and there is no cache.
7. **F7 — render-worker cancellation policy is deliberate and correct-looking.** Stall / wall-clock / user cancel are terminal (no retry); only genuine render errors requeue; `requeueForShutdown` decrements `attempts` so a deploy consumes none. `makeCancelSignal` tears down Chromium. No orphan-child surface inside the worker (ffmpeg/probe children live in the route's pre-enqueue asset resolution). No finding.
8. **F8 — `mcp-video-worker` cannot be scaled to multiple PM2 instances** as written: `recoverProcessingJobsAfterWorkerRestart` requeues/fails *all* `processing` jobs at boot with no worker-id or heartbeat guard, so a second instance restarting mid-job would double-run a live sibling's job. Documented in the source; recorded here so nobody "fixes" throughput by bumping `instances`.
9. **F9 — the render queue's hot claim query does not use `@@index([status, type])`.** `claimNextRenderJob` issues `WHERE status = ? ORDER BY createdAt ASC LIMIT 1` (no `type` predicate); the only `status`-and-`type` pair in the codebase is not on a hot path. A1b should `EXPLAIN QUERY PLAN` the claim shape given in §A3.7, not a `status,type` pair.

---

## §A3.7 Exact SQL for Task A1b

Verbatim as Prisma 6.19.3 emits it against the SQLite datasource, placeholders as `?`. Paste each into `EXPLAIN QUERY PLAN <sql>` on production (`sqlite3 -readonly`).

### 1. `user` by `clerkId` — the auth hot path (`clerk-auth.ts:96`; 1 per authenticated request)

```sql
SELECT `main`.`User`.`id`, `main`.`User`.`clerkId`, `main`.`User`.`name`, `main`.`User`.`email`, `main`.`User`.`password`, `main`.`User`.`googleId`, `main`.`User`.`image`, `main`.`User`.`role`, `main`.`User`.`plan`, `main`.`User`.`usageCount`, `main`.`User`.`usageLimit`, `main`.`User`.`usagePeriodStartedAt`, `main`.`User`.`openaiKey`, `main`.`User`.`geminiKey`, `main`.`User`.`heygenKey`, `main`.`User`.`elevenlabsKey`, `main`.`User`.`pexelsKey`, `main`.`User`.`pixabayKey`, `main`.`User`.`kieKey`, `main`.`User`.`unsplashKey`, `main`.`User`.`flickrKey`, `main`.`User`.`avatar`, `main`.`User`.`heygenAvatarId`, `main`.`User`.`heygenAvatarsCache`, `main`.`User`.`heygenAvatarsCachedAt`, `main`.`User`.`elevenlabsVoiceId`, `main`.`User`.`ttsProvider`, `main`.`User`.`geminiVoiceName`, `main`.`User`.`suspended`, `main`.`User`.`planExpiresAt`, `main`.`User`.`onboardingDismissedAt`, `main`.`User`.`firstClipConvertDismissedAt`, `main`.`User`.`stripeCustomerId`, `main`.`User`.`stripeSubscriptionId`, `main`.`User`.`subStatus`, `main`.`User`.`billingPeriod`, `main`.`User`.`cancelAtPeriodEnd`, `main`.`User`.`cancelAt`, `main`.`User`.`trialStartedAt`, `main`.`User`.`trialEndsAt`, `main`.`User`.`trialEndedAt`, `main`.`User`.`bundleGrantId`, `main`.`User`.`bundleSubscriptionId`, `main`.`User`.`bundleAccessExpiresAt`, `main`.`User`.`bundleStatus`, `main`.`User`.`bundleBillingPeriod`, `main`.`User`.`bundleAmountThb`, `main`.`User`.`bundleLastEventId`, `main`.`User`.`bundleQuotaGrantId`, `main`.`User`.`bundleCreditsGrantId`, `main`.`User`.`bundlePrimary`, `main`.`User`.`minutesUsed`, `main`.`User`.`minutesLimit`, `main`.`User`.`aiAudioMinutesUsed`, `main`.`User`.`aiTextCallsUsed`, `main`.`User`.`geminiKeyMode`, `main`.`User`.`affiliateRefCode`, `main`.`User`.`resetToken`, `main`.`User`.`resetExpires`, `main`.`User`.`createdAt`, `main`.`User`.`updatedAt` FROM `main`.`User` WHERE (`main`.`User`.`clerkId` = ? AND 1=1) LIMIT ? OFFSET ?
```

> Note for A1b: this selects **all 63 columns including `heygenAvatarsCache`**, a JSON blob of the user's HeyGen avatar list. On a row whose cache is large this is the widest read on the hot path, and it happens 1–14 times per request (§A3.2).

### 2. `bundleEntitlement` by `email` (`bundle-entitlement.ts:120`; 1–2 per authenticated request)

```sql
SELECT `main`.`BundleEntitlement`.`email`, `main`.`BundleEntitlement`.`grantId`, `main`.`BundleEntitlement`.`subscriptionId`, `main`.`BundleEntitlement`.`status`, `main`.`BundleEntitlement`.`accessEndsAt`, `main`.`BundleEntitlement`.`billingPeriod`, `main`.`BundleEntitlement`.`amountThb`, `main`.`BundleEntitlement`.`lastEventId`, `main`.`BundleEntitlement`.`eventOccurredAt`, `main`.`BundleEntitlement`.`createdAt`, `main`.`BundleEntitlement`.`updatedAt` FROM `main`.`BundleEntitlement` WHERE (`main`.`BundleEntitlement`.`email` = ? AND 1=1) LIMIT ? OFFSET ?
```

### 3. revenue-cohorts user scan (`revenue-cohorts.ts:501`; `/api/admin/stats`, `/api/admin/revenue`)

```sql
SELECT `main`.`User`.`id`, `main`.`User`.`email`, `main`.`User`.`plan`, `main`.`User`.`role`, `main`.`User`.`subStatus`, `main`.`User`.`billingPeriod`, `main`.`User`.`planExpiresAt`, `main`.`User`.`trialStartedAt`, `main`.`User`.`trialEndsAt`, `main`.`User`.`stripeSubscriptionId`, `main`.`User`.`bundleAccessExpiresAt`, `main`.`User`.`bundleStatus`, `main`.`User`.`bundlePrimary`, `main`.`User`.`bundleBillingPeriod`, `main`.`User`.`bundleAmountThb` FROM `main`.`User` WHERE 1=1 LIMIT ? OFFSET ?
```

Its companion all-time payment scan (`revenue-cohorts.ts:511`):

```sql
SELECT `main`.`Payment`.`id`, `main`.`Payment`.`userId`, `main`.`Payment`.`amount`, `main`.`Payment`.`note`, `main`.`Payment`.`periodDays`, `main`.`Payment`.`createdAt` FROM `main`.`Payment` WHERE `main`.`Payment`.`status` = ? ORDER BY `main`.`Payment`.`createdAt` ASC LIMIT ? OFFSET ?
```

### 4. insights `telemetryEvent` — three distinct shapes

Current window, `createdAt` range, `take: 20_000` (`admin/insights/route.ts:842`):

```sql
SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`name`, `main`.`TelemetryEvent`.`category`, `main`.`TelemetryEvent`.`source`, `main`.`TelemetryEvent`.`sessionId`, `main`.`TelemetryEvent`.`userId`, `main`.`TelemetryEvent`.`step`, `main`.`TelemetryEvent`.`status`, `main`.`TelemetryEvent`.`durationMs`, `main`.`TelemetryEvent`.`value`, `main`.`TelemetryEvent`.`path`, `main`.`TelemetryEvent`.`properties`, `main`.`TelemetryEvent`.`createdAt` FROM `main`.`TelemetryEvent` WHERE `main`.`TelemetryEvent`.`createdAt` >= ? ORDER BY `main`.`TelemetryEvent`.`createdAt` DESC LIMIT ? OFFSET ?
```

Previous window (`admin/insights/route.ts:851`) — note the **implicit `ORDER BY id ASC`** Prisma adds when no `orderBy` is given:

```sql
SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`name`, `main`.`TelemetryEvent`.`category`, `main`.`TelemetryEvent`.`source`, `main`.`TelemetryEvent`.`sessionId`, `main`.`TelemetryEvent`.`userId`, `main`.`TelemetryEvent`.`step`, `main`.`TelemetryEvent`.`status`, `main`.`TelemetryEvent`.`durationMs`, `main`.`TelemetryEvent`.`value`, `main`.`TelemetryEvent`.`path`, `main`.`TelemetryEvent`.`properties`, `main`.`TelemetryEvent`.`createdAt` FROM `main`.`TelemetryEvent` WHERE (`main`.`TelemetryEvent`.`createdAt` >= ? AND `main`.`TelemetryEvent`.`createdAt` < ?) ORDER BY `main`.`TelemetryEvent`.`id` ASC LIMIT ? OFFSET ?
```

By `name`, all-time, `distinct: ["userId"]` (`admin/insights/route.ts:883`) — **this one has no `createdAt` bound at all, so it scans the whole table forever**:

```sql
SELECT `main`.`TelemetryEvent`.`id`, `main`.`TelemetryEvent`.`userId` FROM `main`.`TelemetryEvent` WHERE (`main`.`TelemetryEvent`.`name` = ? AND `main`.`TelemetryEvent`.`userId` IS NOT NULL) LIMIT ? OFFSET ?
```

### 5. `videoJob` `createdAt` range (`admin/insights/route.ts:887`)

```sql
SELECT `main`.`VideoJob`.`id`, `main`.`VideoJob`.`userId`, `main`.`VideoJob`.`status`, `main`.`VideoJob`.`currentStep`, `main`.`VideoJob`.`errorMessage`, `main`.`VideoJob`.`progress`, `main`.`VideoJob`.`startedAt`, `main`.`VideoJob`.`finishedAt` FROM `main`.`VideoJob` WHERE `main`.`VideoJob`.`createdAt` >= ? LIMIT ? OFFSET ?
```

### 6. `renderJob` by `status, type` — and the shape that actually runs

The `@@index([status, type])` shape (constructed; no measured endpoint issues it):

```sql
SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`userId`, `main`.`RenderJob`.`videoId`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`attempts`, `main`.`RenderJob`.`maxAttempts`, `main`.`RenderJob`.`payload`, `main`.`RenderJob`.`progress`, `main`.`RenderJob`.`phase`, `main`.`RenderJob`.`heartbeatAt`, `main`.`RenderJob`.`cancelRequested`, `main`.`RenderJob`.`reservedQuota`, `main`.`RenderJob`.`reservedMinutes`, `main`.`RenderJob`.`creditsSpent`, `main`.`RenderJob`.`creditsFromGranted`, `main`.`RenderJob`.`creditsFromPromotional`, `main`.`RenderJob`.`creditFundingJson`, `main`.`RenderJob`.`error`, `main`.`RenderJob`.`idempotencyKey`, `main`.`RenderJob`.`scopeKey`, `main`.`RenderJob`.`videoUrl`, `main`.`RenderJob`.`createdAt`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE (`main`.`RenderJob`.`status` = ? AND `main`.`RenderJob`.`type` = ?) LIMIT ? OFFSET ?
```

**The queue's real hot query** (`render/job-store.ts:235`, every 3 s per worker instance — EXPLAIN this one too, see F9):

```sql
SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`userId`, `main`.`RenderJob`.`videoId`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`attempts`, `main`.`RenderJob`.`maxAttempts`, `main`.`RenderJob`.`payload`, `main`.`RenderJob`.`progress`, `main`.`RenderJob`.`phase`, `main`.`RenderJob`.`heartbeatAt`, `main`.`RenderJob`.`cancelRequested`, `main`.`RenderJob`.`reservedQuota`, `main`.`RenderJob`.`reservedMinutes`, `main`.`RenderJob`.`creditsSpent`, `main`.`RenderJob`.`creditsFromGranted`, `main`.`RenderJob`.`creditsFromPromotional`, `main`.`RenderJob`.`creditFundingJson`, `main`.`RenderJob`.`error`, `main`.`RenderJob`.`idempotencyKey`, `main`.`RenderJob`.`scopeKey`, `main`.`RenderJob`.`videoUrl`, `main`.`RenderJob`.`createdAt`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE `main`.`RenderJob`.`status` = ? ORDER BY `main`.`RenderJob`.`createdAt` ASC LIMIT ? OFFSET ?
```

And the insights range scan (`admin/insights/route.ts:893`):

```sql
SELECT `main`.`RenderJob`.`id`, `main`.`RenderJob`.`type`, `main`.`RenderJob`.`status`, `main`.`RenderJob`.`parentJobId`, `main`.`RenderJob`.`startedAt`, `main`.`RenderJob`.`finishedAt` FROM `main`.`RenderJob` WHERE `main`.`RenderJob`.`createdAt` >= ? LIMIT ? OFFSET ?
```

### 7. `supportTicket` by status (`/api/admin/support?status=OPEN`, measured)

```sql
SELECT `main`.`SupportTicket`.`id`, `main`.`SupportTicket`.`message`, `main`.`SupportTicket`.`imageName`, `main`.`SupportTicket`.`imageMimeType`, `main`.`SupportTicket`.`status`, `main`.`SupportTicket`.`adminReply`, `main`.`SupportTicket`.`category`, `main`.`SupportTicket`.`severity`, `main`.`SupportTicket`.`recommendedAction`, `main`.`SupportTicket`.`auditNote`, `main`.`SupportTicket`.`impactNote`, `main`.`SupportTicket`.`sentryIssueId`, `main`.`SupportTicket`.`linearIssueIdentifier`, `main`.`SupportTicket`.`auditedAt`, `main`.`SupportTicket`.`repliedAt`, `main`.`SupportTicket`.`createdAt`, `main`.`SupportTicket`.`updatedAt`, `main`.`SupportTicket`.`userId` FROM `main`.`SupportTicket` WHERE `main`.`SupportTicket`.`status` = ? ORDER BY `main`.`SupportTicket`.`createdAt` DESC LIMIT ? OFFSET ?
```

### 8. `siteConfig` key `IN` (`/api/admin/settings`, measured — 32 keys)

```sql
SELECT `main`.`SiteConfig`.`key`, `main`.`SiteConfig`.`value`, `main`.`SiteConfig`.`updatedAt` FROM `main`.`SiteConfig` WHERE `main`.`SiteConfig`.`key` IN (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) LIMIT ? OFFSET ?
```

Two narrower variants of the same shape were also observed in the same runs — 15 placeholders (plan config) and 8 placeholders (`load-stripe-config`). The plan generalises across all three.

### 9. `notification` by `userId` (`/api/notifications`, measured)

The route filters on `userId` + `NOT type`, **not** on `read` — the `read` predicate only appears in the `PATCH` handler:

```sql
SELECT `main`.`Notification`.`id`, `main`.`Notification`.`userId`, `main`.`Notification`.`type`, `main`.`Notification`.`title`, `main`.`Notification`.`body`, `main`.`Notification`.`link`, `main`.`Notification`.`read`, `main`.`Notification`.`createdAt` FROM `main`.`Notification` WHERE (`main`.`Notification`.`userId` = ? AND (NOT `main`.`Notification`.`type` = ?)) ORDER BY `main`.`Notification`.`createdAt` DESC LIMIT ? OFFSET ?
```

> A1b: `Notification` has **no `@@index` at all** in `prisma/schema.prisma` beyond the primary key. Expect a full scan.

### 10. `productUpdate` summary (`/api/updates?summary=1`, measured)

```sql
SELECT `main`.`ProductUpdate`.`id`, `main`.`ProductUpdate`.`version`, `main`.`ProductUpdate`.`title`, `main`.`ProductUpdate`.`summary`, `main`.`ProductUpdate`.`body`, `main`.`ProductUpdate`.`category`, `main`.`ProductUpdate`.`importance`, `main`.`ProductUpdate`.`state`, `main`.`ProductUpdate`.`isPinned`, `main`.`ProductUpdate`.`targetPath`, `main`.`ProductUpdate`.`ctaLabel`, `main`.`ProductUpdate`.`ctaHref`, `main`.`ProductUpdate`.`imageUrl`, `main`.`ProductUpdate`.`publishedAt`, `main`.`ProductUpdate`.`createdAt`, `main`.`ProductUpdate`.`updatedAt` FROM `main`.`ProductUpdate` WHERE (`main`.`ProductUpdate`.`state` = ? AND (`main`.`ProductUpdate`.`publishedAt` IS NULL OR `main`.`ProductUpdate`.`publishedAt` <= ?)) ORDER BY `main`.`ProductUpdate`.`isPinned` DESC, `main`.`ProductUpdate`.`publishedAt` DESC, `main`.`ProductUpdate`.`createdAt` DESC LIMIT ? OFFSET ?
```

### 11. Bonus — the write that runs on every request from an affected account (§A3.1)

```sql
BEGIN IMMEDIATE;
UPDATE `main`.`User` SET `plan` = ?, `planExpiresAt` = ?, `trialEndsAt` = ?, `bundlePrimary` = ?, `usageCount` = ?, `usageLimit` = ?, `usagePeriodStartedAt` = ?, `minutesUsed` = ?, `minutesLimit` = ?, `aiAudioMinutesUsed` = ?, `aiTextCallsUsed` = ?, `updatedAt` = ? WHERE (`main`.`User`.`id` = ? AND `main`.`User`.`plan` IN (?,?) AND (`main`.`User`.`subStatus` IS NULL OR `main`.`User`.`subStatus` <> ?));
COMMIT;
```

**Do not run this on production.** It is listed so A1b can recognise it in `pm2 logs` / slow-transaction output and correlate it with the write-lock waits; `EXPLAIN QUERY PLAN` the `SELECT` form of its `WHERE` if a plan is needed.

---

## §A3.8 Ranked code-level causes, with expected saving per page

| # | Cause | Evidence | Maps to | Expected saving |
|---|---|---|---|---|
| **1** | **The entitlement chain re-reads the same `User` row and re-resolves the same evidence, many times per request.** Per `/api/user/me` (non-admin customer): **15 `User` reads of one row**, the `Payment`+`CouponRedemption`+`AdministratorGrant` evidence bundle **5×**, `syncUserEntitlement` **2×**, `getStarterAiImageAllowanceStatus` **2×**. No request-scoped cache exists anywhere in the chain. | §A3.2 measured trace + per-table tally | **B3** | Two independent levers, quantified separately so B3 can take either: **(a) pass the already-loaded `User` row down** instead of re-`SELECT`ing it inside `syncUserEntitlement` / `syncStoredBundleEntitlementForUser` / `resolvePaidEquivalentEntitlement` → auth prefix **8 → 5 statements, on every authenticated request** (`/api/notifications` 9 → 6, `/api/editor-projects` 9 → 6, `/api/videos` 10 → 7, `/api/admin/settings` 10 → 7). **(b) memoise `resolvePaidEquivalentEntitlement`, `syncUserEntitlement` and `getStarterAiImageAllowanceStatus` per request** → removes 4 of 5 evidence bundles (−16), the 2nd `syncUserEntitlement` and the 2nd allowance read. Together: **`/api/user/me` 34 → ~10 statements (−70 %)**, `/api/user/stats` 17 → ~7. Across the ~6 XHRs a dashboard load fires, roughly **40–50 fewer SQLite statements per page load**. |
| **2** | **A write transaction on the auth path of every request from a paid account with no `Payment` evidence.** `BEGIN IMMEDIATE` + `UPDATE User` (0 rows matched) + `COMMIT` in `entitlements.ts:365`; twice on `/api/user/me`; fires even on 403s. Prime suspect for HERO-10 write-lock waits. | §A3.1 no-evidence table, verified twice with a clean restart | **B3** (fix is one early-return condition, in the same function B3 already touches) | Removes **1–2 write-lock acquisitions per request** for the affected cohort — count them with the SQL in §A3.1. Also −4 statements per request for those users. |
| **3** | **Zero code splitting.** `grep -rn "next/dynamic" src \| wc -l` = **0**; no `React.lazy`. `/video-editor` ships **2234.4 KB raw / 657.8 KB gzip** across 34 chunks; the dashboard shell adds ~400 KB raw over the ~913 KB floor on every route. | §A3.5 | **out of scope: code-splitting editor — measured 2234.4 KB raw / 657.8 KB gzip on `/video-editor`** | Not claimed in this plan. Recorded with the measured size so the decision is informed. |
| **4** | **24-family render-blocking Google Fonts stylesheet on every route.** 107.1 KB of CSS, 278 `@font-face`, 240 woff2 candidates, blocking first paint on `/`, `/login`, `/dashboard`, `/admin`, `/videos`, `/docs/*` — routes that need **two** of those families. 5 families are referenced by nothing at all, 7 more only by burn-side Remotion (which loads them itself). | §A3.4 measured CSS bytes | **B4** | Non-editor routes: **107.1 KB → 11.0 KB blocking CSS (−96.1 KB, −90 %)**, and one fewer render-blocking request chain to `fonts.googleapis.com` + `fonts.gstatic.com`. Editor routes: 107.1 → 69.6 KB (−35 %). Minimum safe first step (drop only the 5 dead families, no route logic): −10.6 KB everywhere. |
| **5** | **`/api/admin/insights` runs 21 route statements, several of them unbounded.** Two 20 000-row `TelemetryEvent` window scans, two 5 000-row `Video` scans, a full `User` scan, plus an **all-time, unbounded** `TelemetryEvent WHERE name='editor_opened'` distinct scan. 30 statements total. | §A3.1, §A3.7 §4 | **B5** (with A1b's `EXPLAIN` results) | The all-time telemetry scan is the one that grows without bound; bounding it to the window is the single highest-value change on this route. Statement count is not the problem here — row volume is. |
| **6** | **`/api/admin/cleanup` blocks the single web process** with recursive `readdirSync`/`lstatSync` **and** 6 unbounded `findMany` scans (no `take:`). `/api/admin/storage` shells out to `du -sk` with a 15 s timeout. Both are on `/admin`'s initial XHR set. | §A3.6 F3/F4/F5, §A3.1 | **B6** | These are A2's "slow cold" endpoints. Any saving here is dominated by the filesystem walk, not by SQL; the DB-side win is bounding the 6 graph scans. |
| **7** | **`/api/admin/revenue` makes unbounded live Stripe calls per request** (charges + refunds pagination, one invoice list per bundle subscription). No cache. | §A3.1 note ¹, §A3.6 F6 | **B5 / B6** (ADR 0062 already confines money to `/admin/revenue`) | Latency is proportional to Stripe history and independent of any DB work. Caching or windowing it is the only lever; not quantifiable locally. |
| **8** | **Dead code in the font map.** `src/components/thumbnail/ThumbnailEditor.tsx` (24 font declarations, 25 family references) has **no importer** anywhere in `src` or `scripts`. | §A3.4 | **B4** (as a non-consumer, not a deletion task) | No runtime saving; prevents B4 from over-counting consumers. |

---

## Reproduction

Everything in this report was produced in `/Users/mewsocialmacmini/projects/AI_content_Mew_social-perf-a3-code-audit` from `origin/main` `84e4d8c2`, with a local seeded `prisma/dev.db`. The helper scripts left uncommitted in that worktree are `scripts/_a3-seed.ts` (seed), `scripts/_a3-sql.ts` (§A3.7 SQL generator), `scripts/_a3-chain.ts` (§A3.2 chain), `_a3-tx-trans.cjs` (§A3.3 AST sweep), `_a3-firstload.cjs` / `_a3-firstload2.cjs` (§A3.5). `git diff` in that worktree is empty — no tracked file was modified.
