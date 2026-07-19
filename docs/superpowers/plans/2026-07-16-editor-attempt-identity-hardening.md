# Editor Attempt Identity Hardening Implementation Plan

> **For Codex:** Execute this plan inline in the current approved worktree. Preserve browser Back/history behavior, do not merge/push/deploy, and do not run production DB/schema mutations.

**Goal:** Make billable editor submissions replay-safe across mutable gates and unrelated resume state, fence archive completion after unmount, and reclaim only provably owned early-crash fence temporaries without starvation.

**Architecture:** A shared canonical request serializer defines the logical operation identity. The API hashes that identity with SHA-256, persists it beside the existing user-scoped idempotency key, and performs a fail-closed replay preflight before mutable business gates. The editor computes the same expected fingerprint before posting and retains an attempt descriptor until an authenticated response or polled job proves both key and fingerprint. Archive and filesystem cleanup paths use explicit ownership generations and conservative, bounded state machines.

**Tech stack:** Next.js route handlers, React hooks, TypeScript, Prisma/PostgreSQL schema contract, Node crypto/Web Crypto, existing `tsx` runtime harnesses.

---

## Task 1: Add exact logical-request identity and replay coverage

**Files:**

- Create: `src/lib/video-job-idempotency.ts`
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/mcp/video-job.ts`
- Modify: `src/app/api/videos/jobs/route.ts`
- Modify: `src/app/api/videos/jobs/[id]/route.ts`
- Test: `scripts/editor-project-job-runtime-harness.ts`
- Test: `scripts/verify-mcp-videojob.ts`

### Step 1: Write deterministic RED route and helper tests

Extend `scripts/editor-project-job-runtime-harness.ts` with table-driven route cases that exercise the actual route module and mocked Prisma/service boundaries:

- an existing same-user key with an exact non-null fingerprint returns the existing job for every persisted status;
- the replay happens immediately after auth/body parsing and before source lookup, quota, concurrency, render-cap, trusted-logo staging, or billing-input work, including saturated and plan/quota-changed states;
- a body, operation kind, project, source, render, or billing-input mismatch returns `409`;
- a legacy row whose fingerprint is `null` returns `409`;
- another user's identical key is not replayed;
- both ordinary preflight and the `P2002` race use the same exact comparator, with exact `P2002` returning the row and mismatched `P2002` returning `409`.

Add pure canonicalization vectors proving recursive object-key sorting, array-order/type preservation, key exclusion, operation-kind separation, and stable SHA-256 output. Add a persistence assertion to `scripts/verify-mcp-videojob.ts` that a supplied fingerprint is stored while existing callers remain nullable-compatible.

Run the focused harnesses and record the expected failures before production changes:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
npx tsx scripts/verify-mcp-videojob.ts
```

### Step 2: Add the additive schema contract

Add nullable `idempotencyFingerprint String?` to `VideoJob`. Do not add a uniqueness rule or modify existing rows. Document the rollout ordering in the remediation report: apply the additive schema change before restarting application processes; legacy `null` rows fail closed for keyed web-route replay.

Generate the local client only:

```bash
npx prisma generate
```

Do not run `prisma db push`, `prisma migrate dev`, deploy commands, or production DB operations.

### Step 3: Implement canonicalization and hashing

In `src/lib/video-job-idempotency.ts`, expose a versioned logical-request envelope and deterministic recursive serializer. The envelope contains the explicit operation (`preview`, `export`, or `broll-rerender`) and every parsed JSON body property except transport-only `idempotencyKey`. Preserve JSON scalar types and array order; sort object keys recursively.

Expose server SHA-256 and browser Web Crypto SHA-256 helpers over identical UTF-8 canonical bytes. Reject invalid or missing idempotency keys at the web route boundary rather than silently creating an unowned billable attempt.

### Step 4: Persist and return the fingerprint

Extend `createVideoJob` options with an optional nullable `idempotencyFingerprint` and write it atomically with the key and input. Keep non-editor callers source-compatible.

Select and return `idempotencyKey` and `idempotencyFingerprint` from authenticated job POST/GET responses so the client can verify ownership evidence.

### Step 5: Move exact replay before mutable gates

Immediately after authentication and successful body parsing in `POST /api/videos/jobs`, derive operation kind, canonical fingerprint, and normalized key. Query `{ userId, idempotencyKey }` selecting the persisted fingerprint and response fields:

- exact non-null fingerprint: return the existing job with `idempotentReplay: true`, regardless of status or current limits;
- different or legacy-null fingerprint: return `409`;
- no same-user row: continue existing validations and creation.

Pass the fingerprint into every create branch. Replace all branch-specific `P2002` handlers with the same comparator so a concurrent exact creator replays and any mismatch fails closed. Do not reorder validation for brand-new keys beyond the replay preflight.

### Step 6: Turn Task 1 GREEN

Run:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
npx tsx scripts/verify-mcp-videojob.ts
```

Inspect assertions to confirm the route, not a parallel model, is under test.

## Task 2: Preserve ambiguous attempts across unrelated resume state

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Job.ts`
- Modify: `scripts/editor-project-job-runtime-harness.ts`

### Step 1: Write RED hook-runtime cases

Use the actual hook runtime harness to cover preview and export independently:

- start a POST, let the server commit while the response is lost, then expose an older active or local-storage job ID;
- verify unrelated resume/poll does not clear or replace the attempt descriptor;
- retry the exact logical request and prove the same key/fingerprint is used and only one server job is created;
- replace the project and prove the old attempt is neither released nor submitted as the new project's request;
- resume a job whose key or fingerprint differs and prove it cannot release the attempt;
- resume/poll the exact job with matching key and fingerprint and prove release;
- return mutable `429`/quota/limit failures and prove the descriptor remains reusable;
- return definitive `409` identity conflict and prove fail-closed release/error behavior.

Run and capture RED:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
```

### Step 2: Bind the attempt descriptor to immutable evidence

Extend `OwnedSubmitAttempt` with operation kind, project ID, canonical expected fingerprint, baseline active preview/export job IDs, and baseline local-storage job ID. Build the complete request body synchronously, install one owned promise immediately for same-tick deduplication, and compute the browser fingerprint before issuing `fetch`.

Reuse an attempt only when operation and project match. A project/kind mismatch must not mutate or abandon the ambiguous attempt and must not reuse it for a different request.

### Step 3: Release only on matching evidence

Centralize a predicate requiring exact `idempotencyKey` and `idempotencyFingerprint`, plus project/operation compatibility. Use it for POST success and polled GET responses. Do not clear the descriptor merely because a server project field, active job, or local-storage job ID appears; baseline IDs explicitly identify pre-attempt resume candidates.

Keep the descriptor after transport ambiguity and mutable capacity/quota/limit responses. Treat authenticated identity conflicts as definitive failures. Ensure reset/adoption/resume paths cannot silently erase an unresolved descriptor without matching evidence.

### Step 4: Turn Task 2 GREEN

Run:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
```

## Task 3: Fence archive completion across unmount and replacement

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
- Modify: `scripts/editor-project-job-runtime-harness.ts`

### Step 1: Write the RED actual-shell test

Extend the harness lifecycle runner with `unmount()` that executes effect cleanups. Mount the actual shell, hold `DELETE /api/editor-projects/:id` pending, unmount, then resolve success. Assert zero post-unmount recent-project invalidation, zero archive completion callback, zero router navigation, and zero state updates attributable to the stale attempt.

Retain and run mounted success, project replacement, stale response, and retry tests. Capture RED:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
```

### Step 2: Add mount/generation/project ownership

Track mounted state and an archive generation. On cleanup, mark unmounted, advance generation, and invalidate the current archive token. Each attempt captures token, generation, and project ID.

After every await, require mounted state plus current token/generation/project ownership before fetching follow-up data, completing archive state, navigating, or mutating React state. Apply the same guard in `finally`.

### Step 3: Turn Task 3 GREEN

Run:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
```

## Task 4: Reclaim safe early-crash fence temporaries without starvation

**Files:**

- Modify: `src/lib/clerk-asset-cleanup-receipt.server.ts`
- Modify: `scripts/verify-brand-asset-api.ts`

### Step 1: Write exhaustive RED filesystem cases

Create real filesystem fixtures for exact dead-owner, private, direct-child fence directories containing:

- no child entries;
- an empty canonical marker;
- a canonical-prefix partial marker;
- a complete canonical marker;
- malformed/non-prefix marker bytes;
- an extra child or extra marker data;
- a symlinked directory/marker;
- foreign-owner, live-owner, and non-private entries.

Assert only the first four safe shapes are removed, removal is nonrecursive, and every ambiguous/foreign/live/symlink/unexpected shape is preserved. Add more than 32 preserved entries before more than 32 removable entries, then call scavenging repeatedly: the first pass removes exactly 32 safe candidates despite preserved entries; subsequent passes make deterministic progress until all safe candidates are gone.

Run and capture RED:

```bash
npx tsx scripts/verify-brand-asset-api.ts
```

### Step 2: Implement a streaming, removal-bounded scan

Use `opendir` to stream directory entries. Preserved candidates do not consume the destructive budget; stop only after 32 successful safe removals or end-of-directory.

For an exact candidate, retain all existing containment, lstat, inode/mode, current-process identity, and dead-owner checks. Permit removal only when it remains a direct, nonsymlink, private directory and is either empty or contains exactly one private regular canonical marker whose bytes are empty or an exact prefix of the expected receipt ID. Re-stat/revalidate before unlink/rmdir. Never recurse and never follow symlinks. Concurrent disappearance remains an idempotent success; any ambiguity preserves the entry.

### Step 3: Turn Task 4 GREEN

Run:

```bash
npx tsx scripts/verify-brand-asset-api.ts
```

## Task 5: Cross-feature verification and handoff

**Files:**

- Modify: `.superpowers/sdd/final-remediation-final-review-fix-report.md`
- Audit: all files changed since `8fe9be0b8717683e9e10e4539a65e44981aeedb5`

### Step 1: Run the targeted runtime/conflict/render/billing suite

Run fresh, individually visible commands:

```bash
npx tsx scripts/editor-project-job-runtime-harness.ts
npx tsx scripts/verify-mcp-videojob.ts
npx tsx scripts/verify-brand-asset-api.ts
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-logo-project-default.ts
npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-render-receipt.ts
npx tsx scripts/verify-render-queue.ts
```

If the repository's existing fresh DB/root harness wrapper is required by these scripts, use its documented local test database setup only. Do not touch production data or schema.

### Step 2: Run generated-client and TypeScript audits

After the schema edit, run `npx prisma generate` again and then the repository TypeScript check. Separately capture all TypeScript diagnostics and audit whether any diagnostic intersects a changed file:

```bash
npx tsc --noEmit
```

Do not claim a clean global typecheck if unrelated pre-existing errors remain; report the exact changed-file result.

### Step 3: Inspect the final diff and contract

Review:

```bash
git status --short
git diff --check
git diff --stat 8fe9be0b8717683e9e10e4539a65e44981aeedb5..HEAD
git diff 8fe9be0b8717683e9e10e4539a65e44981aeedb5 -- prisma/schema.prisma src scripts
```

Confirm Task 4 never modifies browser Back/history behavior, the schema change is nullable/additive, no unrelated user changes were overwritten, and no generated secret/build artifact is staged.

### Step 4: Update the remediation report

Append a new dated section containing:

- RED commands and the expected failing assertions for A–D;
- GREEN/full verification commands and outcomes;
- schema rollout ordering and the legacy-null `409` behavior;
- TypeScript changed-file audit;
- diff/self-review findings;
- residual risks, especially that existing legacy keyed rows cannot be proven equivalent.

### Step 5: Commit cohesive implementation changes

Stage only in-scope files, inspect the staged diff, and create cohesive commit(s). Return the commit SHA(s), verification evidence, schema rollout requirement, and residual risks to the parent. Do not merge, push, deploy, or mutate production DB/schema.
