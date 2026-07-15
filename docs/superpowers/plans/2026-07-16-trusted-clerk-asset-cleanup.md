# Trusted Clerk Asset Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Clerk account-deletion asset cleanup crash-durable, bounded, retryable, and safe when an internal user id becomes live again, without a database migration or native filesystem addon.

**Architecture:** Treat `BRAND_ASSET_ROOT` as a private server-owned trust boundary and move receipt/quarantine filesystem mechanics into a focused server-only module. A versioned receipt state machine is durably written before database deletion; the deleted user's directory is atomically isolated in a receipt-specific quarantine before removal. The Clerk orchestration keeps the existing admin boolean helper unchanged while returning a retryable webhook failure until receipt, quarantine, and cleanup reach a durable terminal state.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Prisma/SQLite, Next.js route handlers, existing dependency-free verifier scripts.

## Global Constraints

- `BRAND_ASSET_ROOT` and the reserved receipt/quarantine directories are owned by the service account, are not symlinks, and deny group/world write access.
- Processes already running as the same OS user or root are outside the filesystem attacker threat model; do not add a native addon or Linux-only `/proc` dependency.
- No Prisma schema change, database writer token, background cleanup service, or client-controlled path/storage key.
- Receipt keys and logs contain only a SHA-256 identifier; raw Clerk ids, emails, user ids, paths, and storage keys are not logged.
- Reads allocate at most `MAX_RECEIPT_BYTES + 1` and reject unstable metadata, growth, replacement, malformed JSON, and non-canonical receipts.
- Database deletion remains before user-directory removal. Cleanup never recursively removes the original path after a live target is observed.
- Existing admin deletion boolean behavior and the Clerk signature/other-event contracts remain unchanged.
- All tests use disposable `/tmp` databases and asset roots and remove their artifacts.

---

### Task 1: Build durable trusted-root receipt and quarantine primitives

**Files:**

- Create: `src/lib/clerk-asset-cleanup-receipt.server.ts`
- Modify: `src/lib/account-hard-delete.server.ts`
- Modify: `src/lib/brand-assets.server.ts`
- Modify: `scripts/verify-brand-assets.ts`
- Modify: `scripts/verify-brand-asset-api.ts`

**Interfaces:**

```ts
export type ClerkAssetCleanupPhase =
  | "prepared"
  | "quarantined"
  | "directory-cleaned";

export type ClerkAssetCleanupReceipt = Readonly<{
  version: 2;
  clerkIdHash: string;
  userId: string;
  bindingHash: string;
  phase: ClerkAssetCleanupPhase;
}>;

export type ClerkAssetCleanupStore = {
  identifier(clerkId: string): string;
  read(clerkId: string): Promise<ClerkAssetCleanupReceipt | null>;
  write(clerkId: string, userId: string, phase: ClerkAssetCleanupPhase): Promise<void>;
  remove(clerkId: string): Promise<void>;
  quarantineUserDirectory(input: {
    clerkId: string;
    userId: string;
  }): Promise<"moved" | "already-quarantined" | "absent">;
  quarantineExists(clerkId: string): Promise<boolean>;
  removeQuarantine(clerkId: string): Promise<void>;
};

export function createClerkAssetCleanupStore(options?: {
  assetRoot?: string;
  observeDurabilityStep?: (step: string) => void;
}): ClerkAssetCleanupStore;
```

- [ ] **Step 1: Add RED durability and trust-boundary cases**

In `scripts/verify-brand-asset-api.ts`, create a new disposable root whose immediate
parent already exists. Record `observeDurabilityStep` events and require this order
before an injected database-delete marker:

```ts
assert.deepEqual(steps.slice(0, 6), [
  "asset-root-created",
  "asset-root-parent-synced",
  "receipt-directory-created",
  "asset-root-synced",
  "receipt-file-synced",
  "receipt-directory-synced",
]);
```

Reject a root or reserved directory that is a symlink, owned by another uid when the
platform exposes uid, or has `mode & 0o022 !== 0`. Preserve outside/root/sibling
sentinels in every rejection case. On macOS `/tmp` may itself resolve through a
platform symlink; validate the configured root inode, not every operating-system
ancestor.

- [ ] **Step 2: Run the new durability verifier RED**

Run:

```bash
rm -f /tmp/heroai-clerk-cleanup-plan.db
rm -rf /tmp/heroai-clerk-cleanup-plan-assets
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-asset-api.ts
```

Expected: exit 1 because the current implementation does not fsync the newly created
asset-root/receipt-directory parent entries and has no quarantine primitive.

- [ ] **Step 3: Add RED capped and stable receipt reads**

Use the store's real file handle with test barriers to append after the first metadata
read. Require the implementation to read into one preallocated buffer only:

```ts
const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
if (bytesRead > MAX_RECEIPT_BYTES) throw invalidReceipt();
```

After the capped read, compare pre/post handle metadata (`dev`, `ino`, regular-file
type, owner, private mode and exact byte size) and compare the final pathname's
`lstat` identity to the open handle. Concurrent append, truncate, rename/replacement,
direct symlink, oversized-at-open, and malformed/canonical-mismatch cases must all
reject without allocating more than 1,025 bytes or touching sentinels.

- [ ] **Step 4: Implement durable private directory creation and receipt IO**

Create missing directories one component at a time below the nearest existing parent.
For every created directory, fsync its parent before continuing. Validate the final
configured asset root and both reserved directories with `lstat`: directory, not
symlink, current owner where uid is available, and `mode & 0o022 === 0`.

Write receipts as mode `0600` temporary files whose names begin with the receipt hash,
then `FileHandle.sync()`, atomic `rename`, and fsync the receipt directory. Receipt
directories use `0700`. Scavenge at most 32 stale temporary entries per call and only
names matching:

```ts
new RegExp(`^\\.${receiptId}\\.[0-9a-f-]{36}\\.tmp$`, "u")
```

Do not follow symlinks and do not remove a non-matching file.

- [ ] **Step 5: Implement receipt-specific quarantine primitives**

Reserve `.account-delete-quarantine-v1` in `isSafeBrandAssetUserId`. The quarantine
path is exactly `<root>/.account-delete-quarantine-v1/<receiptHash>`. Rename only the
validated direct child `<root>/<userId>` to that path. Treat `ENOENT` as `"absent"`
and an existing quarantine as `"already-quarantined"`; any other collision fails
closed. `removeQuarantine` recursively removes only that hash path after the caller's
database recheck.

- [ ] **Step 6: Prove mutation sensitivity and GREEN**

Run controlled source mutations and restore each one:

- omit parent fsync after first receipt-directory creation;
- replace the capped read with `readFile()`;
- accept a group/world-writable configured root;
- allow a non-hash quarantine path;
- scavenge a temporary file belonging to another receipt.

Each mutation must fail a deterministic assertion. Then run:

```bash
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-asset-api.ts
npx tsc --noEmit --pretty false
```

Expected: focused suites pass; TypeScript reports only the documented unrelated
checkout metadata baseline.

- [ ] **Step 7: Commit**

```bash
git add src/lib/clerk-asset-cleanup-receipt.server.ts src/lib/account-hard-delete.server.ts src/lib/brand-assets.server.ts scripts/verify-brand-assets.ts scripts/verify-brand-asset-api.ts
git commit -m "fix: harden clerk cleanup receipts"
```

---

### Task 2: Orchestrate live-ID-safe quarantine and Clerk retries

**Files:**

- Modify: `src/lib/account-hard-delete.server.ts`
- Modify: `src/app/api/clerk-webhook/route.ts`
- Modify: `scripts/verify-brand-asset-api.ts`

**Interfaces:**

```ts
export type ClerkBrandAssetDeleteDependencies = {
  findUserByClerkId(clerkId: string): Promise<{ id: string; clerkId: string | null } | null>;
  findUserById(userId: string): Promise<{ id: string; clerkId: string | null } | null>;
  store: ClerkAssetCleanupStore;
  deleteUser(userId: string, clerkId: string): Promise<boolean>;
};

export async function deleteClerkUserAndBrandAssetDirectory(
  clerkId: string,
  dependencies: ClerkBrandAssetDeleteDependencies,
): Promise<boolean>;
```

- [ ] **Step 1: Add RED live-ID race and phase-recovery cases**

Use barriers around `quarantineUserDirectory`, the post-rename `findUserById`,
`removeQuarantine`, and receipt removal. Cover:

1. a live different user appears before rename: no rename/removal; receipt retained;
2. a live different user appears after rename but before post-check: quarantine and
   receipt retained; original live path/sentinel untouched;
3. a user appears after the post-check: it writes only the original path while the
   isolated quarantine is removed;
4. crash/retry with receipt phase `"quarantined"` and existing quarantine;
5. crash after quarantine removal but before phase `"directory-cleaned"`;
6. receipt-unlink failure after `"directory-cleaned"`, followed by a live reused id;
7. two concurrent missing-row redeliveries; and
8. late failed upload recreation of the original directory with no surviving file.

Every incomplete case returns/throws so the signed Clerk route answers 500. Only the
durable terminal cleanup returns 200.

- [ ] **Step 2: Run the signed-route RED matrix**

Run:

```bash
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-asset-api.ts
```

Expected: exit 1 on the live-target barrier because the current path directly removes
the original user directory after a non-atomic database check.

- [ ] **Step 3: Implement the durable phase state machine**

Use these transitions only:

```text
no receipt -> prepared -> quarantined -> directory-cleaned -> receipt removed
```

`prepared` is durable before guarded database deletion. With `prepared`, check that no
different live target owns the internal id, then atomically rename the original path
to quarantine. Persist `quarantined` before recursive removal. Recheck the database
after rename; any live target retains quarantine+receipt and returns retryable failure.

With `quarantined`, an existing quarantine may be removed only while the target remains
absent. If quarantine is already absent after a retry/crash, persist
`directory-cleaned` without touching the original path. Once `directory-cleaned`,
never inspect, rename, or remove `<root>/<userId>` again; only remove the receipt. This
allows a safely reused id to own the original directory after old cleanup completed.

At every failure, log exactly:

```ts
console.error(
  `[account-hard-delete] clerk asset cleanup retry required receipt=${receiptId} phase=${phaseCode}`,
);
```

`phaseCode` is one of `receipt-write`, `db-delete`, `quarantine`, `live-target`,
`quarantine-remove`, `receipt-update`, or `receipt-remove`. No raw identifiers appear.

- [ ] **Step 4: Preserve route and admin compatibility**

The Clerk `user.deleted` route always calls `hardDeleteClerkUserWithBrandAssets(data.id)`
without performing its own user lookup. `ClerkBrandAssetCleanupRetryError` maps to the
existing generic 500 body. Invalid signatures remain 400 and unrelated events keep
their existing behavior. `hardDeleteUserWithBrandAssets(userId)` and
`deleteUserAndBrandAssetDirectory` keep their public boolean/reporting contract for the
admin path.

- [ ] **Step 5: Mutation and GREEN checks**

Mutate and restore:

- remove the post-quarantine live-target check;
- recursively remove the original path instead of quarantine;
- remove the `directory-cleaned` terminal guard;
- remove phase persistence before destructive work;
- return 200 while a receipt/quarantine operation failed.

Each mutation must fail. Then run:

```bash
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-asset-api.ts
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db BRAND_ASSET_ROOT=/tmp/heroai-clerk-cleanup-plan-assets npx tsx scripts/verify-logo-export.ts
DATABASE_URL=file:/tmp/heroai-clerk-cleanup-plan.db npm run build
npx tsc --noEmit --pretty false
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/account-hard-delete.server.ts src/app/api/clerk-webhook/route.ts scripts/verify-brand-asset-api.ts
git commit -m "fix: quarantine clerk account assets"
```

---

### Task 3: Repeat independent release verification and QA handoff

**Files:**

- Update ignored evidence: `.superpowers/sdd/editor-release-blocker-final-report.md`

- [ ] **Step 1: Run the complete remediation release gate**

Use a new disposable database and asset root, run all 18 verifiers from Task 7 of
`docs/superpowers/plans/2026-07-15-editor-release-blocker-remediation.md`, Prisma
generate, production build, and TypeScript. Record exact exit results and keep the
known checkout metadata baseline separate from changed files.

- [ ] **Step 2: Replay runtime blockers**

Record actual runtime evidence for two-client CAS, all timeout lineage branches,
GET-only retry, setter-before-effect latest-local conflict, bounded issued snapshots,
stale logo upload, receipt first-failure/redelivery, capped growing receipt, and all
three live-ID quarantine timing windows.

- [ ] **Step 3: Request merge-base-to-HEAD independent review**

Review the Responsive Logo Overlay, conflict-resolution, remediation, and trusted
cleanup specs together. Fix and re-review every Critical/Important finding. Do not
change the approved filesystem trust boundary without user approval.

- [ ] **Step 4: Refresh QA server from current HEAD**

After verifying process ownership, replace only the disposable worktree-owned
`0.0.0.0:3007` server. Report Tailscale URL, branch/SHA, env-var names only, fixture
scope, signed-out redirect, and exact authenticated browser/device results. Protected
desktop/mobile and preview/export remain environment-blocked without a non-production
authenticated session.

- [ ] **Step 5: Finish without integration**

Use `superpowers:verification-before-completion` and
`superpowers:finishing-a-development-branch`. Do not merge, deploy, or push without the
user's explicit final choice.

