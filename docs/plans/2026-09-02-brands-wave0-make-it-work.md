# Brands Wave 0 — Make the existing feature work as promised

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every promise the current `/brands` feature already makes is true — quoted credits equal charged credits, every plan can create a brand, the Step-2 B-roll preferences visibly change results, no English system names or retired format names reach creators, no dead code, and the brand verify scripts run in CI.

**Architecture:** No new product surface. Fix the client/server quote contract, split the brand access guard into a library guard and an AI-image guard (ADR 0059), make the existing `broll-preferences` plumbing actually alter search queries, cache keys, ranking and the per-window search (this is the pipe ADR 0057's Stock Mood reuses in wave 1), and wire the orphan verify scripts + a scoped ESLint run into CI.

**Tech Stack:** Next.js 15 App Router, Prisma 6 / SQLite, Zod, `tsx` verify scripts (`scripts/verify-*.ts`, some under `node --conditions=react-server`), GitHub Actions `.github/workflows/ci.yml`.

**Spec:** `docs/audits/2026-09-02-brands-review.md` §4–§5 (findings F1–F7, F9–F17, F19) · ADR 0059 · `CONTEXT.md` (People & Place Preference, Brand Library).

## Global Constraints

- Work in an Orca worktree on branch `mew/brands-wave0`; never edit the root checkout; PR into `main`; CI must be green.
- Customer-facing copy: Thai only; never the strings `Brand Visual`, `Hero AI Image`, `Video Editor`, `Treatment`, `Preset`, `Pin`, `Trend Pack`, `ก้างปลา` (ADR 0010, CONTEXT.md แนวภาพ).
- Schema: additive only (`prisma db push` on deploy). This wave adds **no** schema change.
- Never add a hidden image retry, engine switch or generic-treatment fallback (ADR 0023, ADR 0010).
- Never change subtitle timing code (ADR 0056).
- Prod access for agents: read-only SELECT / `pm2 logs` only; Mew deploys.
- Every task ends with `npx tsc --noEmit --pretty false` green and the named verify scripts green; commit per task.
- Run existing suites touched by a task before committing: `npm run verify:brand-visual-system`, `npm run verify:brand-treatment-v1`, `npm run verify:broll-preferences`, `npm run verify:brands-mobile` (worker picks the relevant subset per task; Task 8 runs all).

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Preview quote = charge (F1, F2) | mew-worker-heavy | subagent | — | build+test, code review, security-review (credits) |
| 2 | Preview button explains why it is disabled (F6) | mew-worker | subagent | 1 | build+test, code review |
| 3 | Library guard vs image guard; open every plan; drop first-clip redirect + owner e-mail bypass; locked copy (F3, F4, F9, F14) | mew-worker-heavy | subagent | — | build+test, code review, security-review (auth) |
| 4 | Step-2 preference plumbing: style token in query, cache key, per-window search, ranker ordering, no-op telemetry (F7) | mew-worker-heavy | subagent | — | build+test, code review |
| 5 | Dead code, retired-format copy, suggest-visual schema, shared field caps, docs status (F10–F13, F15, F16, F19) | mew-worker | subagent | 3 | build+test, code review |
| 6 | CI wiring + scoped ESLint (F17) | mew-worker | subagent | 5 | build+test, code review |
| 7 | Diagnose Content Preflight 63 % resolve / 9 % invalid (F5) — fix if platform bug, else disposition | mew-worker-heavy | subagent | — | build+test, code review, session final |
| 8 | Final gate: run every suite, update audit §5 dispositions, PR | (session model) | inline | 1–7 | criteria check |

Frontier at start: 1, 3, 4, 7 in parallel. Then 2 (after 1), 5 (after 3), 6 (after 5).

---

### Task 1: Preview quote = charge

**Files:**
- Modify: `src/app/api/brand-library/preview-quote/route.ts`
- Modify: `src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx:119-150` (quote effect) and `:600-612` (previewLook body)
- Test: `scripts/verify-brand-look-preview-quote.ts` (new, react-server)
- Modify: `package.json` scripts

**Interfaces:**
- Consumes: `brandLookPreviewGenerationCount({ userId, projectId?, preflightId?, payload?, profileId?, useDraft? })` from `src/lib/brand-look-preview.server.ts:433` (already accepts `profileId`/`useDraft`); `prepareBrandLookPreview` (`:877`) and `prepareUnsavedBrandLookPreview` (`:1204`) which return `{ generationCount }`.
- Produces: `POST /api/brand-library/preview-quote` body `{ payload, projectId?, preflightId?, profileId?, useDraft? }` → `{ generationCount, reusedCount, credits }`; the client always calls it (never hard-codes 3).

- [ ] **Step 1: Write the failing verify script**

`scripts/verify-brand-look-preview-quote.ts` — follow the temp-SQLite harness used by `scripts/verify-brand-look-preview.ts` (copy its `createTempDatabase`/seed helpers verbatim; do not import from it). Three scenarios; each asserts the quote equals what prepare would generate:

```ts
import assert from "node:assert/strict";

async function main() {
  const { brandLookPreviewGenerationCount, prepareBrandLookPreview, prepareUnsavedBrandLookPreview } =
    await import("../src/lib/brand-look-preview.server");
  const { seedUser, seedPublishedProfile, seedProfilePromotedFromClip, blankPayload } =
    await import("./_brand-preview-harness"); // extracted from verify-brand-look-preview.ts in Step 3

  const user = await seedUser();

  // A) unsaved payload, no project → 3
  const quoteA = await brandLookPreviewGenerationCount({ userId: user.id, payload: blankPayload("A") });
  const prepA = await prepareUnsavedBrandLookPreview({ userId: user.id, requestId: "req-A", payload: blankPayload("A") });
  assert.equal(quoteA, prepA.generationCount);
  assert.equal(quoteA, 3);

  // B) saved profile, draft edited, no project → quote via profileId+useDraft must equal prepare(useDraft)
  const profileB = await seedPublishedProfile(user.id, "B");
  const quoteB = await brandLookPreviewGenerationCount({ userId: user.id, profileId: profileB.id, useDraft: true });
  const prepB = await prepareBrandLookPreview({ userId: user.id, requestId: "req-B", profileId: profileB.id, useDraft: true });
  assert.equal(quoteB, prepB.generationCount);

  // C) profile promoted from a completed clip with 3 reusable Visual Beat images → quote must be < 3 and equal prepare
  const profileC = await seedProfilePromotedFromClip(user.id, "C", { reusableImages: 3 });
  const quoteC = await brandLookPreviewGenerationCount({ userId: user.id, profileId: profileC.id, useDraft: false });
  const prepC = await prepareBrandLookPreview({ userId: user.id, requestId: "req-C", profileId: profileC.id, useDraft: false });
  assert.equal(quoteC, prepC.generationCount);
  assert.ok(quoteC < 3, `promoted profile must reuse images, got ${quoteC}`);

  console.log("verify-brand-look-preview-quote: ok");
}
main().catch((error) => { console.error(error); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --conditions=react-server --import tsx scripts/verify-brand-look-preview-quote.ts`
Expected: FAIL — `./_brand-preview-harness` does not exist yet (or scenario C fails because the harness has no promoted-profile seed).

- [ ] **Step 3: Extract the harness**

Create `scripts/_brand-preview-harness.ts` by moving the temp-DB creation and seed helpers out of `scripts/verify-brand-look-preview.ts` (keep that script green by importing them back). Add `seedProfilePromotedFromClip(userId, tag, { reusableImages })` that inserts an `EditorProject` + `ContentPreflight` + 3 `ProjectVisualBeat` rows with completed `AiGenerationJob` images whose identity key matches the profile's revision (`sourcePreflightId` set on the `BrandProfileRevision`) — mirror the reuse conditions in `resolveReusableBeatImages` / `resolvePreviewSource` (`src/lib/brand-look-preview.server.ts:330-430`).

- [ ] **Step 4: Server — pass profileId/useDraft through the quote route**

`src/app/api/brand-library/preview-quote/route.ts`: after `preflightId`, add

```ts
const profileId = typeof body?.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : undefined;
const useDraft = body?.useDraft === true;
```

and call `brandLookPreviewGenerationCount({ userId: auth.user.id, projectId, preflightId, payload: payload.data, profileId, useDraft })`. When `profileId` is given, verify ownership the same way `prepareBrandLookPreview` does (it throws on a foreign profile → map to `404 { code: "PROFILE_NOT_FOUND" }`).

- [ ] **Step 5: Client — always quote, with the same inputs generate will use**

In `BrandLibraryClient.tsx` replace the `useEffect` at `:126-150`:

```ts
const previewQuoteInput = useMemo(() => JSON.stringify({
  payload,
  projectId: sourceProjectId,
  preflightId: sourcePreflightId,
  profileId: activeId ?? undefined,
  useDraft: Boolean(activeId),
}), [payload, sourceProjectId, sourcePreflightId, activeId]);

useEffect(() => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    setPreviewGenerationCount(null);
    void fetch("/api/brand-library/preview-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: previewQuoteInput,
      signal: controller.signal,
    }).then(responseJson)
      .then((quote: { generationCount: number }) => setPreviewGenerationCount(quote.generationCount))
      .catch((error) => { if (error?.name !== "AbortError") setPreviewGenerationCount(3); });
  }, 350);
  return () => { window.clearTimeout(timer); controller.abort(); };
}, [previewQuoteInput]);
```

(Keep the existing debounce/abort shape that is already there for the `sourceProjectId` branch; the only behavioural change is that the `if (!sourceProjectId) { setPreviewGenerationCount(3); return; }` short-circuit is gone and `profileId`/`useDraft` ride along.) The fallback to 3 on a network error is a *worst-case* disclosure, never a lower number.

- [ ] **Step 6: Run the verify script and the existing preview suite**

Run: `node --conditions=react-server --import tsx scripts/verify-brand-look-preview-quote.ts && node --conditions=react-server --import tsx scripts/verify-brand-look-preview.ts && npm run verify:brand-preview-route-recovery`
Expected: all PASS.

- [ ] **Step 7: Wire the script and commit**

`package.json`: add `"verify:brand-look-preview-quote": "node --conditions=react-server --import tsx scripts/verify-brand-look-preview-quote.ts"` and append `&& npm run verify:brand-look-preview-quote` to `verify:brand-visual-system`.

```bash
git add scripts/verify-brand-look-preview-quote.ts scripts/_brand-preview-harness.ts scripts/verify-brand-look-preview.ts src/app/api/brand-library/preview-quote/route.ts "src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx" package.json
git commit -m "fix(brands): quote Brand Look Preview with the same inputs generation uses (F1, F2)"
```

---

### Task 2: Preview button explains why it is disabled

**Files:**
- Modify: `src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx:43-90`
- Test: `scripts/verify-brand-library-support-features.ts` (extend; Task 6 wires it)

**Interfaces:**
- Consumes: props `disabled`, `busy`, `canPublish`, `previewGenerationCount`, `allowance` already on the panel.
- Produces: a `<p data-testid="preview-disabled-reason">` under the button whenever the button is disabled for a reason other than "busy".

- [ ] **Step 1: Failing assertion**

Append to `scripts/verify-brand-library-support-features.ts` (it reads component source as text — keep that style):

```ts
const panel = readFileSync("src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx", "utf8");
assert.match(panel, /ตั้งชื่อแบรนด์ก่อนจึงจะทดลองภาพได้/, "panel must explain the no-name disabled state");
assert.match(panel, /data-testid="preview-disabled-reason"/);
```

- [ ] **Step 2: Run to verify it fails** — `tsx scripts/verify-brand-library-support-features.ts` → FAIL on the new assertion.

- [ ] **Step 3: Implement**

Inside the component, after `fundingInsufficient`:

```ts
const disabledReason = busy !== null
  ? null
  : !canPublish
    ? "ตั้งชื่อแบรนด์ก่อนจึงจะทดลองภาพได้"
    : previewGenerationCount === null
      ? "กำลังตรวจภาพเดิมและคำนวณสิทธิ์ที่ต้องใช้…"
      : fundingInsufficient
        ? "สิทธิ์ทดลองภาพไม่พอสำหรับจำนวนภาพที่ต้องสร้าง"
        : disabled
          ? "ต้องเป็นสมาชิก PRO หรือ BUSINESS จึงจะทดลองภาพ AI ได้"
          : null;
```

Render `{disabledReason && <p data-testid="preview-disabled-reason" className="mt-2 text-xs text-muted-foreground">{disabledReason}</p>}` directly below the button; keep the existing `/pricing` link for `fundingInsufficient`.

- [ ] **Step 4: Verify** — `tsx scripts/verify-brand-library-support-features.ts && npm run verify:brands-mobile` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "fix(brands): say why the preview button is disabled (F6)"`

---

### Task 3: Library guard vs image guard (ADR 0059)

**Files:**
- Modify: `src/lib/brand-visual-rollout.server.ts:22,54-81`
- Modify: `src/lib/brand-visual-access.server.ts`
- Modify: `src/app/(dashboard)/brands/layout.tsx`
- Modify: `src/app/(dashboard)/brands/_components/BrandVisualLockedPreview.tsx:30-51,95`
- Modify: `src/app/(dashboard)/brands/_components/BrandList.tsx:52-58`
- Modify: `src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx` (locked copy on the image button)
- Modify: `src/app/api/brand-library/route.ts:118-123` and every route under `src/app/api/brand-library/**`
- Modify: `scripts/verify-brand-visual-rollout.ts`, `scripts/verify-brand-visual-ops.ts`
- Modify: `docs/ops/brand-visual-system-rollout.md`

**Interfaces:**
- Produces in `brand-visual-rollout.server.ts`:

```ts
export type BrandLibraryAccessDecision = { canUse: boolean; reason: "eligible" | "feature_off" | "suspended" };
export function decideBrandLibraryAccess(
  actor: { suspended?: boolean | null },
  flags = brandVisualRolloutFlags(),
): BrandLibraryAccessDecision;
```

- Produces in `brand-visual-access.server.ts`:

```ts
export async function requireBrandLibraryUser(): Promise<BrandVisualAuthResult>; // auth + library decision; access field still carries the image decision
export async function requireBrandVisualUser(): Promise<BrandVisualAuthResult>;  // unchanged semantics = IMAGE guard
```

- Produces in `GET /api/brand-library` response: `imageAccess: { canUse: boolean; reason: BrandVisualAccessDecision["reason"]; upgradeUrl: "/pricing" }`.

- [ ] **Step 1: Failing tests**

In `scripts/verify-brand-visual-rollout.ts` add:

```ts
const { decideBrandLibraryAccess, decideBrandVisualAccess } = await import("../src/lib/brand-visual-rollout.server");
const on = { enabled: true, percent: 0, startedAt: null, testEmails: new Set<string>() };
assert.deepEqual(decideBrandLibraryAccess({ suspended: false }, on), { canUse: true, reason: "eligible" });
assert.deepEqual(decideBrandLibraryAccess({ suspended: true }, on), { canUse: false, reason: "suspended" });
assert.deepEqual(decideBrandLibraryAccess({ suspended: false }, { ...on, enabled: false }), { canUse: false, reason: "feature_off" });
// owner e-mail is no longer a bypass; only ADMIN / test e-mails are internal
const unpaid = { canUsePaidFeatures: false, source: "none" as const };
assert.equal(decideBrandVisualAccess({ id: "u1", email: "duckyhero@gmail.com", role: "USER" }, unpaid, on).canUse, false);
assert.equal(decideBrandVisualAccess({ id: "u1", email: "t@x.com", role: "USER" }, unpaid, { ...on, testEmails: new Set(["t@x.com"]) }).canUse, true);
```

In `scripts/verify-brand-visual-ops.ts` (spawns a server with a flag matrix) add expectations: with `BRAND_VISUAL_SYSTEM_ENABLED=1` and an **unpaid, non-rollout** user, `GET /api/brand-library` → 200 with `imageAccess.canUse === false`, `POST /api/brand-library` → 201, `POST /api/brand-library/preview-quote` → 403 `PAYMENT_REQUIRED`; with `BRAND_VISUAL_SYSTEM_ENABLED` unset → `GET /api/brand-library` 403 `BRAND_VISUAL_LOCKED`.

- [ ] **Step 2: Run** — `node --conditions=react-server --import tsx scripts/verify-brand-visual-rollout.ts` → FAIL (`decideBrandLibraryAccess` undefined).

- [ ] **Step 3: Implement the decisions**

`brand-visual-rollout.server.ts`: delete `PRODUCT_OWNER_EMAIL` and the `email === PRODUCT_OWNER_EMAIL` clause; add

```ts
export function decideBrandLibraryAccess(
  actor: { suspended?: boolean | null },
  flags = brandVisualRolloutFlags(),
): BrandLibraryAccessDecision {
  if (!flags.enabled) return { canUse: false, reason: "feature_off" };
  if (actor.suspended) return { canUse: false, reason: "suspended" };
  return { canUse: true, reason: "eligible" };
}
export async function resolveBrandLibraryAccess(user: User): Promise<BrandLibraryAccessDecision> {
  return decideBrandLibraryAccess(user);
}
```

`brand-visual-access.server.ts`:

```ts
export function brandLibraryLockedResponse(decision: BrandLibraryAccessDecision): NextResponse {
  return NextResponse.json(
    decision.reason === "suspended"
      ? { code: "ACCOUNT_SUSPENDED", error: "บัญชีนี้ถูกระงับการใช้งานชั่วคราว" }
      : { code: "BRAND_VISUAL_LOCKED", error: "ระบบแบรนด์ยังไม่เปิดรับงานใหม่ในขณะนี้" },
    { status: 403 },
  );
}
export async function requireBrandLibraryUser(): Promise<BrandVisualAuthResult> {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth;
  const library = decideBrandLibraryAccess(auth.user);
  if (!library.canUse) return { ok: false, response: brandLibraryLockedResponse(library) };
  return auth; // auth.access still carries the IMAGE decision for callers that need it
}
```

Rewrite the image-gate copy in `brandVisualLockedResponse`: `rollout_wait` → `"ระบบกำลังทยอยเปิดภาพ AI ประจำแบรนด์ให้สมาชิก บัญชีนี้จะได้รับสิทธิ์ในรอบถัดไป"`, `payment_required` → `"ภาพ AI ประจำแบรนด์ใช้ได้กับสมาชิก PRO และ BUSINESS"`, default → `"ภาพ AI ประจำแบรนด์ยังไม่เปิดให้บัญชีนี้"`.

- [ ] **Step 4: Route by route**

Switch to `requireBrandLibraryUser`: `api/brand-library/route.ts` (GET, POST), `[id]/route.ts`, `[id]/draft/route.ts`, `[id]/publish/route.ts`, `availability/route.ts`, `from-project-look/route.ts`, `suggest-visual/route.ts` (text-only; managed text quota still applies inside), `editor-projects/[id]/brand-revision/route.ts`. Keep `requireBrandVisualUser` (image guard) on: `preview/route.ts`, `preview-quote/route.ts`, `[id]/preview/route.ts` (already recovery-user + `canUse` check — unchanged), `preview-items/[itemId]/reroll/route.ts`, `preview-batches/**`.

`api/brand-library/route.ts` GET: replace `canCreate`/`creationRequiresResult`:

```ts
canCreate: !Number.isFinite(cap) || profiles.length < cap,
creationRequiresResult: false,
imageAccess: { canUse: auth.access.canUse, reason: auth.access.reason, upgradeUrl: "/pricing" },
```

- [ ] **Step 5: Page + components**

`layout.tsx`: remove the `resolveFirstClipPath` import and redirect; use `resolveBrandLibraryAccess(user)`; render `BrandVisualLockedPreview` only when `!library.canUse` with `reason` `feature_off | suspended`.

`BrandVisualLockedPreview.tsx`: drop the `rollout_wait`/`payment_required` branches and the `canUpgrade` button; eyebrow `Brand Visual` → `แบรนด์ของฉัน`; description sentence `…ใน Hero AI Image และ Video Editor` → `…ในภาพ AI ประจำแบรนด์และตัวตัดต่อวิดีโอ`.

`BrandList.tsx:52-58`: delete the `creationRequiresResult` message branch.

`BrandLookPreviewPanel.tsx`: accept `imageAccess` prop from the client; when `!imageAccess.canUse` render the button disabled with `disabledReason` = the reason copy above and a `/pricing` link when `reason === "payment_required"`.

- [ ] **Step 6: Verify + docs**

Run: `node --conditions=react-server --import tsx scripts/verify-brand-visual-rollout.ts && node --conditions=react-server --import tsx scripts/verify-brand-visual-ops.ts && npm run verify:brands-mobile && npx tsc --noEmit --pretty false` → PASS.

`docs/ops/brand-visual-system-rollout.md`: replace the "accounts created before …STARTED_AT remain control" sentence with the truth (rollout bucket + `startedAt` presence only) and add: "Brand Library CRUD is open to every plan (ADR 0059); the percent/entitlement gates apply to AI-image actions only. Before deploy add Mew's e-mail to `BRAND_VISUAL_TEST_EMAILS` if she needs the internal image cohort from a non-ADMIN account."

- [ ] **Step 7: Commit** — `git commit -am "feat(brands): open Brand Library to every plan; gate only AI-image actions (ADR 0059; F3, F4, F9, F14)"`

---

### Task 4: Step-2 preference plumbing actually changes results

**Files:**
- Modify: `src/lib/broll-preferences.ts:223-250` (`augmentRelevanceSpecWithBrollPreference`), `:303-330` (`applyBrollPreferenceToSearchQuery`, `applyBrollPreferenceToSearchQueries`)
- Modify: `src/lib/managed-stock.ts:356-364` (`stockSearchCacheKey`)
- Modify: `src/app/api/videos/fetch-stock/route.ts:1902-1912` (cache params), `:3066-3072`, `:3130-3137` (primary vs fallback query application)
- Modify: `src/app/api/videos/extract-keywords/route.ts` (primary vs fallback + no-op telemetry)
- Modify: `src/app/api/videos/broll-window/search/route.ts:65-83`
- Modify: the per-window search client caller (find with `grep -rn "broll-window/search" src/app`) to send the project's `brollRegionPreference` / `brollVisualStyle`
- Test: `scripts/verify-broll-preferences.ts` (extend), `scripts/verify-managed-stock-cache-key.ts` (new)

**Interfaces:**
- Produces:

```ts
export type ApplyQueryOptions = { role: "primary" | "fallback" };
export function applyBrollPreferenceToSearchQuery(query: string, input: BrollPreferenceInput, options?: ApplyQueryOptions): string;
export function applyBrollPreferenceToSearchQueries(queries: string[], input: BrollPreferenceInput, options?: ApplyQueryOptions): string[];
export function brollPreferenceCacheVariant(input: BrollPreferenceInput): string; // "" | "r=thai" | "s=cinematic" | "r=thai;s=cinematic"
export const STYLE_QUERY_TOKENS: Record<Exclude<BrollVisualStyle, "auto">, string>;
```

```ts
// managed-stock.ts
export function stockSearchCacheKey(input: { query: string; perPage: number; minDuration: number; page?: number; variant?: string }): string;
```

- [ ] **Step 1: Failing tests**

Append to `scripts/verify-broll-preferences.ts`:

```ts
const { applyBrollPreferenceToSearchQuery, brollPreferenceCacheVariant, augmentRelevanceSpecWithBrollPreference } =
  await import("../src/lib/broll-preferences");
// style token reaches PRIMARY queries, never FALLBACK queries
assert.equal(applyBrollPreferenceToSearchQuery("growth chart", { brollVisualStyle: "cinematic" }, { role: "primary" }), "growth chart cinematic");
assert.equal(applyBrollPreferenceToSearchQuery("growth chart", { brollVisualStyle: "cinematic" }, { role: "fallback" }), "growth chart");
assert.equal(applyBrollPreferenceToSearchQuery("cinematic city", { brollVisualStyle: "cinematic" }, { role: "primary" }), "cinematic city", "no duplicate token");
// region + style compose
assert.equal(applyBrollPreferenceToSearchQuery("office workers", { brollRegionPreference: "thai", brollVisualStyle: "documentary" }, { role: "primary" }), "thai office workers documentary");
// cache variant
assert.equal(brollPreferenceCacheVariant({}), "");
assert.equal(brollPreferenceCacheVariant({ brollRegionPreference: "thai", brollVisualStyle: "cinematic" }), "r=thai;s=cinematic");
// preference avoid terms survive the ranker slice(0, 8)
const spec = augmentRelevanceSpecWithBrollPreference(
  { visualDomain: "x", positiveConcepts: Array.from({ length: 20 }, (_, i) => `p${i}`), avoidConcepts: Array.from({ length: 20 }, (_, i) => `a${i}`), safeFallbackQueries: [] },
  { brollRegionPreference: "thai" },
);
assert.ok(spec!.avoidConcepts.slice(0, 8).includes("caucasian people"), "avoid hints must come first");
assert.ok(spec!.positiveConcepts.slice(0, 12).includes("thailand"), "at least the first 4 positive hints must come first");
```

New `scripts/verify-managed-stock-cache-key.ts`:

```ts
import assert from "node:assert/strict";
const { stockSearchCacheKey } = await import("../src/lib/managed-stock");
const base = { query: "night street", perPage: 15, minDuration: 3 };
assert.notEqual(stockSearchCacheKey(base), stockSearchCacheKey({ ...base, variant: "s=cinematic" }));
assert.equal(stockSearchCacheKey(base), stockSearchCacheKey({ ...base, variant: "" }));
console.log("verify-managed-stock-cache-key: ok");
```

- [ ] **Step 2: Run** — `npm run verify:broll-preferences` → FAIL on the first new assertion.

- [ ] **Step 3: Implement in `broll-preferences.ts`**

```ts
export const STYLE_QUERY_TOKENS: Record<Exclude<BrollVisualStyle, "auto">, string> = {
  documentary: "documentary",
  cinematic: "cinematic",
  business: "business",
  lifestyle: "lifestyle",
  tech: "technology",
  minimal: "minimal",
  surreal: "surreal",
};

export type ApplyQueryOptions = { role: "primary" | "fallback" };

export function applyBrollPreferenceToSearchQuery(
  query: string,
  input: BrollPreferenceInput,
  options: ApplyQueryOptions = { role: "primary" },
): string {
  const clean = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!clean) return "";
  let out = clean;
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  if (region === "no-people") {
    const withoutPeople = clean.replace(PEOPLE_WORD_RE, "").replace(/\s+/g, " ").trim();
    const base = withoutPeople || clean;
    out = hasConstraintAlias(base, ["no people", "empty", "object", "objects", "hands", "workspace", "detail"]) ? base : `${base} no people`;
  } else if (region) {
    const constraint = REGION_SEARCH_CONSTRAINTS[region];
    if (constraint && !hasConstraintAlias(clean, constraint.aliases) && mentionsPeopleOrPlace(clean)) {
      out = `${constraint.required} ${clean}`;
    }
  }
  const style = normalizeBrollVisualStyle(input.brollVisualStyle);
  if (style && options.role === "primary") {
    const token = STYLE_QUERY_TOKENS[style];
    if (!hasConstraintAlias(out, [token])) out = `${out} ${token}`;
  }
  return out;
}

export function brollPreferenceCacheVariant(input: BrollPreferenceInput): string {
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  const style = normalizeBrollVisualStyle(input.brollVisualStyle);
  return [region ? `r=${region}` : "", style ? `s=${style}` : ""].filter(Boolean).join(";");
}
```

`applyBrollPreferenceToSearchQueries(queries, input, options)` forwards `options`. In `augmentRelevanceSpecWithBrollPreference` change the two merges to `mergeUnique(hints.positive.slice(0, 4), spec?.positiveConcepts, hints.positive)` and `mergeUnique(hints.avoid, spec?.avoidConcepts)`.

- [ ] **Step 4: Cache key + fetch-stock**

`managed-stock.ts`: add `variant?: string` to the input and append `|v=${input.variant ?? ""}` to the key. In `fetch-stock/route.ts` `managedProviderSearch`, build `cacheParams = { provider, ...params, variant: brollPreferenceCacheVariant(brollPreference) }` (the route already holds `brollPreference` from `:1068-1078`). At `:3130-3137` call `withBrollPreference(alts + keyword)` with `{ role: "primary" }` and the profile-fallback at `:3066-3072` with `{ role: "fallback" }`. Same split in `extract-keywords/route.ts`: per-scene queries (`:502-503`, `:668-669`, `:676`, `:810-811`, `:834-835`) are `primary`; heuristic/safe fallback lists (`:503` second arg, `:669`, `:760`) are `fallback`.

- [ ] **Step 5: No-op telemetry**

In `extract-keywords/route.ts` after the final query lists are built: if `normalizeBrollRegionPreference(brollRegionPreference)` is set and no primary query changed (compare before/after arrays), `console.log("[extract-keywords] preference-noop region=<r> style=<s> queries=<n>")` and `recordTelemetryEvent(authUser.id, { name: "broll_preference_noop", category: "quality", source: "server", status: region, properties: { style: style ?? null, queryCount } }).catch(() => {})`.

- [ ] **Step 6: Per-window search**

`broll-window/search/route.ts`: read `brollRegionPreference`/`brollVisualStyle` from the body (`unknown` → normalize), compute `const styled = applyBrollPreferenceToSearchQuery(keyword, prefs, { role: "primary" })`, search with `styled`; if both providers return 0 candidates and `styled !== keyword`, search again with `keyword` (plain) — this is the same degrade rule as fallback queries, not a hidden retry of a paid call. Client: the caller found by `grep -rn "broll-window/search" src/app` adds the two fields from the project draft (`useV2Project` exposes them at `:630-635`).

- [ ] **Step 7: Verify**

Run: `npm run verify:broll-preferences && tsx scripts/verify-managed-stock-cache-key.ts && npm run verify:broll-window-management && npx tsc --noEmit --pretty false` → PASS. Add `"verify:managed-stock-cache-key": "tsx scripts/verify-managed-stock-cache-key.ts"` to `package.json`.

- [ ] **Step 8: Commit** — `git commit -am "fix(broll): make Step-2 style/region preferences change queries, cache keys, ranking and per-window search (F7)"`

---

### Task 5: Dead code, retired-format copy, suggest-visual schema, shared caps, doc status

**Files:**
- Modify: `src/app/api/brand-library/route.ts:123` (drop `canRestoreAll`), `src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx:109,157-165` and its `LibraryResponse` type in `_components/types.ts`
- Modify: `src/app/api/brand-library/suggest-visual/route.ts:16-17,53` (+ prompt text) and `BrandLibraryClient.tsx:434-446`
- Modify: `src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx:527`
- Modify: `src/lib/brand-profile-library.server.ts:100-105` (import caps from `src/lib/brand-profile-limits.ts`)
- Modify: `docs/plans/2026-08-09-brand-visual-system-product-brief.md:194-196`
- Test: `scripts/verify-brand-treatment-ui-v1.ts` (copy guards), `scripts/verify-brand-profile-library.ts` (cap parity)

- [ ] **Step 1: Failing guards**

In `verify-brand-treatment-ui-v1.ts` (it already reads `BrandVisualSelector.tsx` as text) add:

```ts
assert.doesNotMatch(selectorSource, /ก้างปลา/, "retired format name must not reach creators");
for (const file of ["src/app/(dashboard)/brands/_components/BrandVisualLockedPreview.tsx", "src/lib/brand-visual-access.server.ts", "src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx"]) {
  const src = readFileSync(file, "utf8");
  assert.doesNotMatch(src, /Brand Visual|Hero AI Image|Video Editor/, `${file} leaks an English system name`);
}
```

In `verify-brand-profile-library.ts` add a publish with `analysisNotes` of 4001 chars and assert it is rejected with the same message the legacy route gives (`checkBrandProfileFieldLimits`).

- [ ] **Step 2: Run** — `tsx scripts/verify-brand-treatment-ui-v1.ts` → FAIL (`ก้างปลา` present).

- [ ] **Step 3: Implement**

- `BrandVisualSelector.tsx:527`: `คลิปนี้ยังใช้ก้างปลาเล่าเรื่องรุ่นเดิม` → `คลิปนี้ยังใช้แนวภาพรุ่นเดิม`.
- Delete `canRestoreAll` from the API response, the `LibraryResponse` type and the `if (libraryData.canRestoreAll)` block; delete `const [, setSourceVisualContext] = useState(...)` and its six setter calls.
- `suggest-visual/route.ts`: remove `peopleAndSetting` and `memorableCues` from the Zod proposal schema and from the prompt's requested JSON shape; keep `primaryVisualFormatId`, `palette`, `personality`, `visualNotes`.
- `brand-profile-library.server.ts:100-105`: replace literal caps with `BRAND_PROFILE_FIELD_LIMITS.shortFieldChars` / `.longFieldChars` / `.urlChars` / `.bannedWords` imported from `brand-profile-limits.ts` (export that constant if it is not already exported).
- Product brief status line → `interviewed: 2026-08-09 | product decisions: complete | implementation: shipped 2026-08-18 (see docs/audits/2026-08-18-brand-visual-v1-release-hardening.md) | superseded in part by ADR 0057–0059 (2026-09-02)`.

- [ ] **Step 4: Verify** — `tsx scripts/verify-brand-treatment-ui-v1.ts && node --conditions=react-server --import tsx scripts/verify-brand-profile-library.ts && npx tsc --noEmit --pretty false` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "chore(brands): remove dead restore/state code, retired-format copy, unused suggest fields; share field caps (F10-F13, F16, F19)"`

---

### Task 6: CI wiring + scoped ESLint

**Files:**
- Modify: `package.json` scripts
- Modify: `.github/workflows/ci.yml`
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Wire orphan scripts**

Add to `package.json`:

```json
"verify:brand-library-ui": "tsx scripts/verify-brand-library-support-features.ts",
"verify:brand-assets": "node --conditions=react-server --import tsx scripts/verify-brand-asset-api.ts && node --conditions=react-server --import tsx scripts/verify-brand-assets.ts",
"verify:brands-ci": "npm run verify:brands-mobile && npm run verify:brand-library-ui && npm run verify:brand-assets && npm run verify:broll-preferences && npm run verify:managed-stock-cache-key && tsx scripts/verify-brand-treatment-catalog-v1.ts && tsx scripts/verify-brand-treatment-ui-v1.ts && node --conditions=react-server --import tsx scripts/verify-brand-visual-rollout.ts && npm run verify:brand-look-preview-quote",
"lint:brands": "eslint \"src/app/(dashboard)/brands/**/*.{ts,tsx}\" \"src/lib/brand-*.ts\" \"src/lib/broll-preferences.ts\" \"src/app/api/brand-library/**/*.ts\""
```

Run each once; if `verify-brand-asset-api.ts` / `verify-brand-assets.ts` do not need `react-server`, drop the flag for that one — the rule is "the command that makes the script green".

- [ ] **Step 2: ESLint**

`eslint.config.mjs` currently has no rule set at all (only ignores). Add the standard Next 15 flat config: `import nextVitals from "eslint-config-next/core-web-vitals"; import nextTs from "eslint-config-next/typescript";` and include `...nextVitals, ...nextTs` in `defineConfig` (check `node_modules/next/dist/docs/` + `eslint-config-next` README for the exact import shape of the installed version before writing it). Run `npm run lint:brands`; fix every error in the scoped files (no `eslint-disable` without a one-line reason). Do **not** run the repo-wide `npm run lint` as a gate in this task — record its error count in the PR description for a later cleanup.

- [ ] **Step 3: CI**

In `.github/workflows/ci.yml` add two steps after the existing verify steps:

```yaml
      - name: Brand Library verify
        run: npm run verify:brands-ci
      - name: Brand Library lint
        run: npm run lint:brands
```

- [ ] **Step 4: Verify locally** — `npm run verify:brands-ci && npm run lint:brands` → PASS; measure wall time and report it in the PR (target < 4 min).

- [ ] **Step 5: Commit** — `git commit -am "ci(brands): run brand verify scripts and scoped lint on every PR (F17)"`

---

### Task 7: Diagnose Content Preflight resolve 63 % / invalid 9 %

**Files:**
- Read: `src/lib/content-preflight.server.ts:775-937`, `src/lib/video-job-content-preflight.server.ts`, `src/lib/mcp/orchestrator.ts:2270-2311`, telemetry writer for `brand_visual_preflight_invalid` (`content-preflight.server.ts:918-931`)
- Read (prod, read-only): `pm2 logs ai-content --lines 5000 | grep -i "content-preflight\|preflight_invalid"` and `SELECT status, json_extract(properties,'$.reason'), COUNT(*) FROM TelemetryEvent WHERE name='brand_visual_preflight_invalid' GROUP BY 1,2`
- Output: section `## F5 disposition` appended to `docs/audits/2026-09-02-brands-review.md`; code fix only if a platform defect is proven

- [ ] **Step 1: Classify the 83 invalid events** by reason (Zod path that failed, Thai-name leak, count mismatch, provider error, timeout, quota) using the telemetry properties and matching log lines; produce a table.
- [ ] **Step 2: Explain the silent gap** (952 step-2 vs 604+83): determine from `orchestrator.ts:2270-2311` and the editor's preflight trigger whether stock-only projects legitimately never run preflight (expected) vs projects that needed AI visuals and never got a resolution (defect). Count each class with SQL on `EditorProject`/`ContentPreflight`/`VideoJob`.
- [ ] **Step 3: If a defect is proven**, fix it in the smallest way that keeps ADR 0010 semantics (no generic fallback, no image charge before a completed pin): e.g. a schema repair prompt for the dominant Zod failure, or a missing trigger. Add a de-identified fixture to `scripts/verify-content-preflight.ts` that reproduces the failure and passes after the fix.
- [ ] **Step 4: Write the disposition** (numbers, cause, fix-or-not, follow-up ticket if any) into the audit and commit: `git commit -am "docs(audit): F5 Content Preflight disposition"` (plus the fix commit if any).

---

### Task 8: Final gate (session)

- [ ] Run: `npm run verify:brand-visual-system && npm run verify:brand-treatment-v1 && npm run verify:brands-ci && npm run lint:brands && npx tsc --noEmit --pretty false && npm run build`.
- [ ] Update `docs/audits/2026-09-02-brands-review.md` §5 with a "Disposition" column (fixed in commit X / deferred to wave N / not a bug).
- [ ] Open PR `mew/brands-wave0` → `main` with the PR body listing: findings fixed, verify evidence, `lint` repo-wide error count, env note for Mew (`BRAND_VISUAL_TEST_EMAILS`).

---

## Acceptance Criteria

- [ ] `verify-brand-look-preview-quote` proves quote === charge for unsaved, saved-draft and promoted-from-clip profiles; client never hard-codes 3 except as a network-error worst case.
- [ ] A FREE and a trial account can create, publish and pin 1 brand; `/brands` never redirects them; preview/reroll/Scene Reroll for them return `PAYMENT_REQUIRED` copy in Thai.
- [ ] `verify:broll-preferences` proves style tokens reach primary queries only, region+style compose, cache keys differ per variant, avoid hints survive the ranker slice; per-window search applies preferences.
- [ ] No creator-facing string contains `Brand Visual`, `Hero AI Image`, `Video Editor`, `ก้างปลา`; guarded by `verify-brand-treatment-ui-v1`.
- [ ] `canRestoreAll` and `setSourceVisualContext` are gone; `suggest-visual` schema has 4 fields.
- [ ] CI runs `verify:brands-ci` + `lint:brands` and is green.
- [ ] F5 has a written disposition with counts; any fix has a fixture.
- [ ] `tsc`, `npm run build`, `verify:brand-visual-system`, `verify:brand-treatment-v1` green. No schema change.

## Out of scope

- Style Packs, Stock Mood, pacing, music mood, recommendation rebalance (wave 1) — this wave only makes the existing pipe truthful.
- Removing the Step-2 style menu (wave 1 does it once Stock Mood replaces it).
- Repo-wide ESLint cleanup (count reported, not fixed).

## Status
interviewed 2026-09-02 | approved: 2026-09-02 (Mew: "approve แต่ execute จะไปทำ session หน้า") | executed: 2026-09-02 (7 tasks + final fix wave on `mew/brands-wave0`, final gate green at `7402533f`: all brand suites, `lint:brands`, `tsc`, prod-style build) | delivered: PR pending — push blocked by the auto-mode classifier, Mew pushes/opens the PR (body in `.superpowers/sdd/2026-09-02-brands-wave0-make-it-work/pr-body.md`)
