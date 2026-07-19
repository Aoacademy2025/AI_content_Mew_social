# Production Containment and Cron Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every cleanup path that can delete customer media outside `Video.expiresAt`, preserve forensic evidence, and leave only the authoritative Gallery cleanup active while the replacement cleanup is built.

**Architecture:** This is an operations-first change with one small repository guard. Capture secret-free state, install a filtered root crontab without the two obsolete entries, remove the PM2 apply-mode cleanup from the live process list, and change the checked-in PM2 definition to dry-run. Every mutation is preceded by a private rollback artifact and followed by read-only verification.

**Tech Stack:** Bash, root cron, PM2, TypeScript/tsx, SQLite, existing `/api/health` endpoint.

## Global Constraints

- Production mutation requires an explicit execution approval for this plan; writing or reviewing this document is not approval to run it.
- Do not rotate, replace, print, diff, or copy the Discord webhook into the repository or an audit report. Preserve its current value and endpoint exactly.
- Retention remains FREE 3 days, PRO 7 days, BUSINESS 14 days. Active projects do not make generated media permanent.
- Do not delete, move, rename, or repair customer media during containment.
- Keep `cleanup-videos`, database backup, disk-watch, watchdog, founding, reconciliation, trial, and renewal jobs enabled.
- Work on a feature branch; production deploys continue from reviewed `main` only.

---

### Task 1: Add a repository-level dry-run guard

**Files:**

- Modify: `ecosystem.config.js:91-100`
- Create: `scripts/verify-media-cleanup-mode.ts`

- [ ] Write `scripts/verify-media-cleanup-mode.ts` so it loads `ecosystem.config.js`, finds exactly one app named `media-cleanup`, and fails if its args contain `--apply` or if its schedule is missing.

```ts
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ecosystem = require("../ecosystem.config.js") as { apps?: Array<{ name?: string; args?: string; cron_restart?: string }> };

const jobs = (ecosystem.apps ?? []).filter((app) => app.name === "media-cleanup");
assert.equal(jobs.length, 1, "expected exactly one media-cleanup PM2 app");
assert.ok(jobs[0].cron_restart, "media-cleanup must keep an explicit schedule");
assert.doesNotMatch(jobs[0].args ?? "", /(?:^|\s)--apply(?:\s|$)/, "media-cleanup must stay dry-run during containment");
console.log("PASS media-cleanup is scheduled in dry-run mode");
```

- [ ] Run the new check and confirm the expected failure.

Run: `npx tsx scripts/verify-media-cleanup-mode.ts`

Expected: assertion failure containing `media-cleanup must stay dry-run during containment`.

- [ ] Remove only `--apply` from the `media-cleanup` `args` string and update the comment to state that apply remains disabled until the retention/reference-graph rollout is approved.

```js
args: "scripts/media-cleanup.ts --olderThanDays=3 --includeStocks",
```

- [ ] Run the focused verification and type check.

Run: `npx tsx scripts/verify-media-cleanup-mode.ts && npx tsc --noEmit`

Expected: `PASS media-cleanup is scheduled in dry-run mode`, then exit 0.

- [ ] Commit.

```bash
git add ecosystem.config.js scripts/verify-media-cleanup-mode.ts
git commit -m "fix(ops): force media cleanup to dry-run during containment"
```

### Task 2: Capture a secret-free production baseline

**Files:**

- Create outside repository: `/root/heroai-containment-2026-07-10/`
- Create outside repository: `/var/backups/heroai/manifests/media-2026-07-10.tsv`

- [ ] On production, create a root-only rollback directory without displaying crontab contents.

```bash
sudo install -d -m 700 /root/heroai-containment-2026-07-10
sudo sh -c 'umask 077; crontab -l > /root/heroai-containment-2026-07-10/root.crontab.before'
sudo pm2 ls --no-color > /root/heroai-containment-2026-07-10/pm2-list.before.txt
```

Expected: commands produce no credential output; both files are mode 600 or under a mode-700 directory.

- [ ] Record only counts for the two unsafe root-cron patterns. Do not display matching lines.

```bash
sudo sh -c 'printf "render_delete_count="; grep -Ec "public/renders.*-mtime.*-delete" /root/heroai-containment-2026-07-10/root.crontab.before || true; printf "obsolete_cleanup_count="; grep -Ec "/api/cron/cleanup-videos" /root/heroai-containment-2026-07-10/root.crontab.before || true'
```

Expected: each count is `1`. Stop and review privately if either count differs; do not install a filtered crontab.

- [ ] Capture a read-only media manifest containing relative path, bytes, and modification epoch. It must not contain environment variables or PM2 environments.

```bash
sudo install -d -m 750 /var/backups/heroai/manifests
cd /var/www/ai-content
find public/renders stocks -xdev -type f -printf '%p\t%s\t%T@\n' | LC_ALL=C sort > /var/backups/heroai/manifests/media-2026-07-10.tsv
sha256sum /var/backups/heroai/manifests/media-2026-07-10.tsv > /var/backups/heroai/manifests/media-2026-07-10.tsv.sha256
```

Expected: the manifest is non-empty and `sha256sum -c` returns `OK`.

- [ ] Capture non-secret database counts for later comparison.

```bash
cd /var/www/ai-content
sqlite3 prisma/dev.db "select 'Video',count(*) from Video union all select 'VideoJob',count(*) from VideoJob union all select 'EditorProject',count(*) from EditorProject union all select 'RenderJob',count(*) from RenderJob;" > /root/heroai-containment-2026-07-10/db-counts.before.txt
```

### Task 3: Remove only the two unsafe root cron entries

**Files:**

- Modify outside repository: root user's crontab
- Use rollback file: `/root/heroai-containment-2026-07-10/root.crontab.before`

- [ ] Build a filtered crontab privately, without printing a diff.

```bash
sudo sh -c 'umask 077; grep -Ev "public/renders.*-mtime.*-delete|/api/cron/cleanup-videos" /root/heroai-containment-2026-07-10/root.crontab.before > /root/heroai-containment-2026-07-10/root.crontab.after'
```

- [ ] Verify the filtered file removed exactly two lines and neither forbidden pattern remains.

```bash
sudo sh -c 'before=$(wc -l < /root/heroai-containment-2026-07-10/root.crontab.before); after=$(wc -l < /root/heroai-containment-2026-07-10/root.crontab.after); test "$((before-after))" -eq 2; ! grep -Eq "public/renders.*-mtime.*-delete|/api/cron/cleanup-videos" /root/heroai-containment-2026-07-10/root.crontab.after'
```

Expected: exit 0 with no output. Any failure stops the task.

- [ ] Install and verify by counts only.

```bash
sudo crontab /root/heroai-containment-2026-07-10/root.crontab.after
sudo sh -c 'crontab -l | grep -Ec "public/renders.*-mtime.*-delete|/api/cron/cleanup-videos"' || true
```

Expected: `0`.

- [ ] Record rollback command in the private operator log. Do not run it unless verification fails.

```bash
sudo crontab /root/heroai-containment-2026-07-10/root.crontab.before
```

### Task 4: Pause the live PM2 apply-mode cleanup

**Files:**

- Modify outside repository: PM2 saved process list

- [ ] Confirm the Gallery cleanup remains registered before touching `media-cleanup`.

Run: `pm2 describe cleanup-videos`

Expected: app exists and its script is `scripts/cleanup-videos.js`.

- [ ] Remove only the current `media-cleanup` app from the live PM2 list, then save. This prevents the already-loaded `--apply` arguments from firing before the dry-run code is deployed.

```bash
pm2 delete media-cleanup
pm2 save
```

Expected: `media-cleanup` is absent; `cleanup-videos` remains present.

- [ ] Verify core services and retained crons without dumping PM2 environment variables.

```bash
pm2 ls --no-color
curl -fsS http://127.0.0.1:3000/api/health
```

Expected: `ai-content`, both `render-worker` instances, and `mcp-video-worker` are online; health returns HTTP 200.

- [ ] Run the current cleanup scanner manually in dry-run mode and retain its JSON report.

```bash
cd /var/www/ai-content
npx tsx scripts/media-cleanup.ts --olderThanDays=3 --includeStocks > /root/heroai-containment-2026-07-10/media-cleanup.dry-run.json
```

Expected: JSON contains `"mode": "dry-run"`; no files are removed and the media manifest checksum still passes.

### Task 5: Verify the next cleanup window and close containment

**Files:**

- Append outside repository: `/root/heroai-containment-2026-07-10/verification.txt`

- [ ] After the next scheduled Gallery cleanup window, confirm its heartbeat is fresh and there are no 401 entries from the removed root curl job.

```bash
test -f /var/www/ai-content/.cron-heartbeat/cleanup-videos
find /var/www/ai-content/.cron-heartbeat/cleanup-videos -mmin -180 -print -quit | grep -q .
```

Expected: exit 0. Inspect scoped application logs for `/api/cron/cleanup-videos` status only; never dump environment or webhook configuration.

- [ ] Generate an after-manifest and compare only removals. Every removed render must correspond to an expired `Video` handled by the authoritative cleanup; any unexplained path blocks all later apply-mode work.

```bash
cd /var/www/ai-content
find public/renders stocks -xdev -type f -printf '%p\t%s\t%T@\n' | LC_ALL=C sort > /root/heroai-containment-2026-07-10/media.after.tsv
comm -23 <(cut -f1 /var/backups/heroai/manifests/media-2026-07-10.tsv | sort) <(cut -f1 /root/heroai-containment-2026-07-10/media.after.tsv | sort) > /root/heroai-containment-2026-07-10/removed-paths.txt
```

- [ ] Acceptance gate: core health is green, no project/VideoJob media was deleted by an age-only rule, the checked-in PM2 job is dry-run, and the dry-run candidate report is retained. If the gate fails, restore the private crontab backup only after identifying which retained entry is required; do not re-enable the filesystem-wide delete.

## Final Verification

- [ ] Run repository checks: `npx tsx scripts/verify-media-cleanup-mode.ts && npx tsc --noEmit && git diff --check`.
- [ ] Confirm `git grep -n -- '--apply' ecosystem.config.js` has no `media-cleanup` match.
- [ ] Confirm no command output or committed artifact contains a webhook URL.
- [ ] Record containment time, manifest hash, PM2 status, health result, and removed-path review in a secret-free operator report.
