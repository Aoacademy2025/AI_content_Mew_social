# Hostinger Hero Voice production readback

**Decision:** **NO-GO for claiming that production is clone-ready or for opening cloning broadly.** A narrow Story Film path is pointed at the clone-capable RunPod endpoint, but the web application and MCP video worker still point at the legacy endpoint. Production is therefore split-brain. Public users remain server-denied and teaser-only; an allowlisted administrator could see cloning, but only Story Film has a clone-capable execution path. There is no production-use evidence yet: `UserVoice` has zero rows and no voice job targets the clone endpoint.

## Scope and observation time

- Read-only observation: **2026-09-03 19:00:14 UTC / 2026-09-04 02:00:14 ICT**.
- Host: existing documented Hostinger SSH target; application root `/var/www/ai-content`.
- No process, file, database, endpoint, queue, or configuration was changed. No inference was submitted. Secret values and user identifiers were neither emitted nor retained.
- Primary evidence: server-side Git/PM2/filesystem/SQLite state, deployed source, and the companion [RunPod live-state audit](./2026-09-04-runpod-hero-voice-live-audit.md).

## Deployed Git state

| Item | Observed value |
| --- | --- |
| Repository | `/var/www/ai-content` |
| Branch | `main` |
| HEAD | [`bb407f79c92cb788fb22ef00617ec2ac867df870`](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/bb407f79c92cb788fb22ef00617ec2ac867df870) |
| HEAD timestamp/subject | 2026-09-03 16:47:26 ICT; merge PR #435 |
| v2 worker | [`24fc72d99576da94bd93bf8827f7d5e351609c0d`](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/24fc72d99576da94bd93bf8827f7d5e351609c0d), present and ancestor of HEAD |
| dependency alignment | [`25916594ea3c05edc361a8f96d36eb1a11622d9d`](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/25916594ea3c05edc361a8f96d36eb1a11622d9d), present and ancestor |
| cloning integration | [`e212c92d32c33c6cb5b4fc1651255bfcf0c6afd3`](https://github.com/Aoacademy2025/AI_content_Mew_social/commit/e212c92d32c33c6cb5b4fc1651255bfcf0c6afd3), present and ancestor |

This proves the clone-capable application code is deployed. It does **not** prove that every live process uses the clone-capable endpoint or that its build-time browser flag is enabled.

## PM2 live state

At the observation instant the online applications were:

| Process | Status | PM2 restart counter | Started UTC | Observed uptime |
| --- | --- | ---: | --- | ---: |
| `pm2-logrotate` | online | 0 | 2026-07-03 19:07:03 | 61d 23h 53m |
| `ai-content` | online | 280 | 2026-09-03 10:06:31 | 8h 53m 42s |
| `mcp-video-worker` | online | 336 | 2026-09-03 10:06:36 | 8h 53m 37s |
| `render-worker` PM2 id 12 | online | 247 | 2026-09-03 10:06:40 | 8h 53m 33s |
| `render-worker` PM2 id 13 | online | 246 | 2026-09-03 10:06:41 | 8h 53m 33s |
| `story-film-system-worker` | online | 42 | 2026-09-03 10:06:40 | 8h 53m 34s |

Stopped scheduled processes, all with PM2 restart counter zero: `trial-expiry`, `founding-sweep`, `renewal-reminders`, `cleanup-videos`, `reconcile-processing`, `mine-loanwords`, `disk-watch`, `db-backup`, `media-cleanup`, `runpod-image-cost-sync`, `reconcile-ai-images`, `north-star-snapshot`, and `trial-reminders`. A restart counter is cumulative; this single readback cannot attribute the high counters of the long-running applications to current instability.

### Every voice-consuming process: sanitized effective configuration

`dotenv` below means the allowlisted key was read in memory from the application environment file only because it was absent from the PM2 record. No environment file or raw PM2 record was printed.

| Allowlisted field | `ai-content` | `mcp-video-worker` | `story-film-system-worker` |
| --- | --- | --- | --- |
| `OMNIVOICE_BACKEND` | `runpod` (PM2) | `runpod` (PM2) | `runpod` (PM2) |
| `RUNPOD_OMNIVOICE_ENDPOINT_ID` | `0t5ta1alo5nzqo` (PM2) | `0t5ta1alo5nzqo` (PM2) | `tkwkf5utqwt9ni` (PM2) |
| `OMNIVOICE_ENABLED` | `1` (PM2) | `1` (PM2) | `1` (PM2) |
| `HERO_VOICE_CLONING_ENABLED` | `1` (dotenv) | `1` (dotenv) | `1` (PM2) |
| `OMNIVOICE_ALLOWED_USER_IDS` | present; 17 entries (PM2) | present; 17 entries (PM2) | present; 17 entries (PM2) |
| `RUNPOD_API_KEY` | present (PM2) | present (PM2) | present (PM2) |
| `USER_VOICE_STORAGE_DIR` | absent; code default applies | absent; code default applies | absent; code default applies |
| `NEXT_PUBLIC_OMNIVOICE_ENABLED` | `1` in runtime PM2 env | `1` in runtime PM2 env | `1` in runtime PM2 env |

RunPod evidence identifies `0t5ta1alo5nzqo` as the legacy v11 endpoint and `tkwkf5utqwt9ni` as the v13 contract-v2/clone-capable endpoint. The former handles the direct web/API routes and MCP video orchestration; the latter handles Story Film narration. The v13 image also bundles the 48 stock voices, so this is **not a clone-only image or endpoint**.

The `.next` build exists. Its metadata does not record a value for `NEXT_PUBLIC_OMNIVOICE_ENABLED`; the exact variable name occurs in 16 compiled files, which is not proof of the inlined browser value. The compiled client value is therefore **unknown**. Runtime PM2 value `1` must not be misreported as build-time proof.

## Database, schema, and drain state

- SQLite was opened with URI `mode=ro` and `PRAGMA query_only=ON`.
- `UserVoice` exists with the deployed expected fields (`id`, `userId`, `name`, reference metadata, consent metadata, timestamps) and **0 rows**.
- The deployed Prisma schema contains `model UserVoice`; migration file `20260824180000_hero_voice_clone_references/migration.sql` exists and names `UserVoice`.
- `_prisma_migrations` does not exist, so the database cannot prove migration provenance. Runtime table shape is compatible, but migration-ledger compatibility is an open operational gap.
- Hero Voice jobs: legacy `0t5ta1alo5nzqo` = 9 completed / 3 failed; older `txvrmtzfc8au3b` = 7 completed / 2 failed. Attempts: 16/3 and 10/2 respectively. **No queued, processing, or in-progress voice jobs; no job or attempt for `tkwkf5utqwt9ni`.**
- The deployment was **not fully drained**: aggregate state showed one active `AiGenerationJob`, one `VideoJob` in `processing`, and one `RenderJob` in `RUNNING`. These aggregates may describe the same workflow, but identifiers/payloads were deliberately not inspected.

## Private voice-reference storage

The effective code default resolves to `/var/www/ai-content/uploads/user-voices`. It exists, is absolute, resolves outside `/var/www/ai-content/public`, is owned by `root:root`, has mode `0700`, and contains 0 regular files / 0 bytes / 0 symlinks. This is safely non-public, but the path is implicit rather than explicitly pinned in process configuration.

## Exposure verdict

The deployed server policy is fail-closed: [`src/lib/omnivoice-policy.ts`](../../src/lib/omnivoice-policy.ts) requires the server flag, the fixed Hero beta cohort, and the ID allowlist. Cloning additionally requires its separate flag, and clone catalog/upload/delete routes require `ADMIN` ([AI Studio catalog](../../src/app/api/ai-studio/catalog/route.ts), [user voice route](../../src/app/api/omnivoice/user-voices/route.ts)). Public users therefore cannot call Hero Voice or clone APIs. The editor deliberately shows a “coming soon” teaser by default ([brand constants](../../src/lib/hero-voice-brand.ts)).

- **Public:** server-denied; teaser-only. The unknown compiled browser flag affects presentation, not server authorization.
- **Allowlisted non-admin team tester:** stock Hero Voice can be authorized; cloning cannot.
- **Allowlisted admin:** cloning UI/storage can be authorized. Story Film narration is pointed at the clone-capable endpoint; direct AI Studio/video-editor/MCP execution is still pinned to legacy v11 and cannot be certified for contract-v2 clone input.
- **Actual clone use:** unproven. Zero references and zero v13 jobs mean there is no live production success evidence.

## Reproducible read-only method

Run only with the documented key and placeholders; keep sanitization server-side:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 -i <DOCUMENTED_KEY> <USER>@<HOST> 'python3 -' < sanitized-readback.py
```

The sanitizer executed only:

```text
git -C /var/www/ai-content rev-parse --show-toplevel|--abbrev-ref HEAD|HEAD
git -C /var/www/ai-content cat-file -e <COMMIT>^{commit}
git -C /var/www/ai-content merge-base --is-ancestor <COMMIT> HEAD
pm2 jlist -> parse in memory -> emit process metadata and allowlisted/derived fields only
sqlite3 URI file:/var/www/ai-content/prisma/dev.db?mode=ro + PRAGMA query_only=ON
SELECT status, COALESCE(providerEndpoint,'<none>'), COUNT(*) ... GROUP BY status, providerEndpoint
stat/lstat/os.walk on the resolved user-voice directory -> counts and aggregate bytes only
```

Do not substitute raw `pm2 env`, raw `.env`, raw `pm2 jlist`, or unaggregated database queries.

## Blockers and next safe action

**Blockers:** endpoint split-brain; v13 is not clone-only and exposes unfinished stock assets to authorized internal surfaces; compiled public UI value is not independently proven; no successful v13 job; no stored clone; no migration ledger; one active workflow means the host is not drained.

**Next safe action:** prepare (do not execute during active work) a reviewed canary cutover that (1) waits for all three active aggregates to reach zero, (2) pins the same clone-capable endpoint/digest across web, MCP, and Story Film, (3) explicitly pins private storage, (4) hides stock catalog/API choices if clone-only is the accepted slice, and (5) validates one consented allowlisted-admin clone through each intended surface with a rollback that restores the three captured process mappings. A clone-only rollout remains **NO-GO** until the shared v13 image’s 48 stock voices are hidden or removed and the direct web/MCP mappings are corrected.
