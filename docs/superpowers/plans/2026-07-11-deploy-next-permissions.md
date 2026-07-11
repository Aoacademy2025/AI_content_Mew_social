# Deploy `.next` Permission Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every staged Next.js build is readable by Nginx before it replaces the live `.next` directory, and update PR #178 onto the current `main` without deploying or applying data changes.

**Architecture:** A repository verifier enforces both the exact normalization command and its ordering in `deploy/deploy.sh`. The deploy script normalizes only `.next-staging`, after build validation and before the atomic swap; PR #178 receives `main` through a non-force merge and changes its base to `main`.

**Tech Stack:** Bash, Node.js/TypeScript (`tsx`), Git worktrees, GitHub CLI

## Global Constraints

- Do not run `deploy/deploy.sh`.
- Do not deploy, restart PM2, push schema, run backfill apply, or enable cleanup apply.
- Do not force-push PR #178.
- Preserve unrelated work in the primary checkout.

---

### Task 1: Guard and normalize staged Next.js permissions

**Files:**
- Create: `scripts/verify-deploy-static-permissions.ts`
- Modify: `deploy/deploy.sh`
- Test: `scripts/verify-deploy-static-permissions.ts`

**Interfaces:**
- Consumes: `STAGING_DIR` and the existing final `BUILD_ID` gate in `deploy/deploy.sh`
- Produces: a staging tree with other-user read bits on files and read/traverse bits on directories before `mv "$STAGING_DIR" "$APP_DIR/.next"`

- [ ] **Step 1: Write the failing verifier**

Create a verifier that reads `deploy/deploy.sh`, requires exactly one
`chmod -R a+rX "$STAGING_DIR"`, checks it is between the final `BUILD_ID` gate and
the staging swap, and proves the command converts a temporary `0700/0600` tree to
Nginx-readable modes without making the sample CSS executable.

- [ ] **Step 2: Run the verifier and confirm RED**

Run: `npx tsx scripts/verify-deploy-static-permissions.ts`

Expected: exit `1` with `deploy must normalize staging permissions exactly once`.

- [ ] **Step 3: Add the minimal deploy fix**

Insert this block immediately before the atomic swap heading:

```bash
echo "=== [5a/6] Normalize staged build permissions ==="
# Build output inherits the caller's umask. Nginx runs as a different user and
# must be able to traverse directories and read static assets before the swap.
chmod -R a+rX "$STAGING_DIR"
```

- [ ] **Step 4: Run focused and repository verification**

Run:

```bash
npx tsx scripts/verify-deploy-static-permissions.ts
bash -n deploy/deploy.sh
npx tsc --noEmit
git diff --check
```

Expected: verifier prints `PASS`, Bash syntax exits `0`, TypeScript exits `0`,
and `git diff --check` emits no output.

- [ ] **Step 5: Commit and push the hardening branch**

```bash
git add deploy/deploy.sh scripts/verify-deploy-static-permissions.ts \
  docs/superpowers/specs/2026-07-11-deploy-next-permissions-design.md \
  docs/superpowers/plans/2026-07-11-deploy-next-permissions.md
git commit -m "fix(deploy): normalize staged Next build permissions"
git push -u origin mew/deploy-next-permission-hardening
```

Expected: one commit based on current `origin/main`; no production command runs.

### Task 2: Sync and verify PR #178 against `main`

**Files:**
- Modify through merge resolution only if required by Git: files changed by both PR #179 and PR #178
- Test: existing media-retention verification scripts

**Interfaces:**
- Consumes: `origin/main` at or after PR #179 and `origin/mew/media-retention-pr2`
- Produces: PR #178 based on `main`, containing Tasks 4–7 plus the reviewed merge resolution

- [ ] **Step 1: Run the focused PR #178 baseline**

```bash
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-quarantine.ts
npx tsx scripts/verify-media-purge-disabled.ts
npx tsx scripts/verify-project-media-state.ts
npx tsx scripts/verify-expired-preview-ui.ts
```

Expected: every verifier prints `PASS` and exits `0`.

- [ ] **Step 2: Merge current main without rewriting history**

```bash
git fetch origin --prune
git merge --no-ff origin/main
```

Expected: a merge commit; no force push. Resolve conflicts by preserving PR #179's
historical-trial rules and PR #178's reference graph/quarantine/UI behavior.

- [ ] **Step 3: Run the full PR #178 verification gate**

```bash
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-quarantine.ts
npx tsx scripts/verify-media-purge-disabled.ts
npx tsx scripts/verify-project-media-state.ts
npx tsx scripts/verify-expired-preview-ui.ts
npx tsx scripts/verify-media-retention.ts
npx tsx scripts/verify-media-rollout-safety.ts
npx tsc --noEmit
npm run build
git diff --check
```

Expected: all commands exit `0`; no deploy or apply command is invoked.

- [ ] **Step 4: Push and retarget PR #178**

```bash
git push origin HEAD:mew/media-retention-pr2
gh pr edit 178 --base main
```

Expected: normal push succeeds and PR #178 reports base `main` and a mergeable state.

