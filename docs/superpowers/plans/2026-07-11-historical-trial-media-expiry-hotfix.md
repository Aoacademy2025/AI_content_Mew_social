# Historical Trial Media Expiry Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the legacy expiry backfill from shortening media created during the proven seven-day PRO trial after an owner reverts to FREE.

**Architecture:** Pass `trialStartedAt` into the pure planner and resolve a PRO retention floor only inside the public-trial window. Keep current-plan fallback, report hashing, hash-gated apply, and null-only updates unchanged.

**Tech Stack:** TypeScript, Prisma 6, SQLite, `tsx`, Node assertions.

## Global Constraints

- Trial evidence is a retention floor: FREE becomes PRO inside the window, while PRO and BUSINESS are never shortened.
- The public-trial window is `[trialStartedAt, trialStartedAt + 7 days)`.
- Payment/coupon reconstruction, schema changes, production apply, merge, and deploy are out of scope.
- The CLI remains dry-run by default and apply still requires an exact reviewed report SHA-256.

---

### Task 1: Use historical trial evidence in media expiry planning

**Files:**
- Modify: `src/lib/media-expiry-backfill.ts`
- Modify: `scripts/verify-media-expiry-backfill.ts`
- Create: `docs/superpowers/specs/2026-07-11-historical-trial-media-expiry-hotfix-design.md`
- Create: `docs/superpowers/plans/2026-07-11-historical-trial-media-expiry-hotfix.md`

**Interfaces:**
- Consumes: `User.trialStartedAt`, current `User.plan`, and the existing candidate base timestamp.
- Produces: deterministic `MediaExpiryBackfillRow` values whose `ownerPlan`, expiry, reason, and hash reflect the PRO trial floor when proven.

- [ ] **Step 1: Add failing pure and integration assertions**

Add a currently-FREE candidate whose `finishedAt` is inside its trial window and assert:

```ts
assert.equal(row.ownerPlan, "PRO");
assert.equal(row.calculatedExpiresAt, "2026-07-12T00:00:00.000Z");
assert.equal(row.alreadyExpired, false);
assert.match(row.reason, /historical PRO trial/);
```

Also assert exact trial-end fallback to FREE and current BUSINESS preservation.

- [ ] **Step 2: Run the focused verifier and confirm RED**

Run:

```bash
rm -f /tmp/heroai-trial-hotfix-red.db*
DATABASE_URL=file:/tmp/heroai-trial-hotfix-red.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-trial-hotfix-red.db npx tsx scripts/verify-media-expiry-backfill.ts
```

Expected: assertion failure because discovery/planning still uses current FREE and computes three days.

- [ ] **Step 3: Implement the minimal trial-floor resolver**

Extend candidates with `trialStartedAt: Date | null`, select it in discovery, and resolve the calculation plan before calling `videoExpiryFor`:

```ts
const calculationPlan = historicalTrialApplies(candidate, baseAt)
  ? longerRetentionPlan(candidate.ownerPlan, "PRO")
  : candidate.ownerPlan;
```

Validate non-null trial timestamps, use a start-inclusive/end-exclusive seven-day window, set `row.ownerPlan` to the calculation plan, and identify historical trial evidence in `reason`.

- [ ] **Step 4: Run focused GREEN and regression verification**

Run:

```bash
rm -f /tmp/heroai-trial-hotfix-green.db*
DATABASE_URL=file:/tmp/heroai-trial-hotfix-green.db npx prisma db push --skip-generate
DATABASE_URL=file:/tmp/heroai-trial-hotfix-green.db npx tsx scripts/verify-media-expiry-backfill.ts
npx tsx scripts/verify-media-retention.ts
npx tsx scripts/verify-media-rollout-safety.ts
npx tsc --noEmit
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 5: Commit and open a PR without merging or deploying**

```bash
git add src/lib/media-expiry-backfill.ts scripts/verify-media-expiry-backfill.ts docs/superpowers/specs/2026-07-11-historical-trial-media-expiry-hotfix-design.md docs/superpowers/plans/2026-07-11-historical-trial-media-expiry-hotfix.md
git commit -m "fix(media): preserve historical trial retention"
git push -u origin mew/media-expiry-trial-hotfix
gh pr create --base main --head mew/media-expiry-trial-hotfix
```
