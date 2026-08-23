# CLAUDE.md — Project Guide for AI Agents

> Read this first. It reflects the **actual** state of the project. `PRD.md` describes an older vision and is partly outdated — when they conflict, trust this file + `STATUS.md`.

## What this is
**HERO AI Creator Studio** (studio.heroaiengine.com) — a Next.js SaaS that turns **one script into a finished short-form video, automatically**: AI avatar (full / bookend / none), auto **Thai subtitles** (long or viral-keyword style), auto **B-roll** (changes every 3–5s), voice cloning, music. Built for Faceless creators & content makers. Core flow: **Style → Content → Video**.

## Actual tech stack (differs from PRD.md!)
| Area | Reality |
|---|---|
| Framework | Next.js 15 (App Router) + React 19, TypeScript |
| Styling | Tailwind v4 + shadcn/ui |
| Auth | **Clerk** — `src/lib/auth.ts` (NextAuth) is legacy/leftover, NOT the live auth. Still imported by `src/lib/api-error.ts` (session lookup fallback for admin-notify), so it's not dead code — don't delete without also touching that call site. The NextAuth API routes (`register`/`forgot-password`/`reset-password`/`[...nextauth]`) had zero callers and were deleted 2026-07-07. |
| DB | **SQLite** via Prisma 6 — `prisma/dev.db` (NOT PostgreSQL) |
| Hosting | **Hostinger VPS** (Ubuntu, 4 vCPU/15GB) + PM2 + Nginx + Let's Encrypt (NOT Vercel) |
| Render | **Remotion + headless Chromium + ffmpeg**, runs locally on the VPS (software, no GPU) |
| AI | **BYOK by default:** Gemini (content/transcribe/keywords/TTS), HeyGen (avatar), ElevenLabs (TTS), Pexels/Pixabay (stock). **Managed exception:** team-operated OmniVoice audio-only worker, gated per ADR 0003. |
| Payments | Stripe — **subscription (auto-renew) + one-time/PromptPay LIVE 06-05**; **Founding-100 (50%/forever, first 100, coupon `FOUNDING100`) + Free trial (7-day PRO) LIVE 06-07**. Config in DB `SiteConfig` (NOT `.env`), loaded by `src/lib/load-stripe-config.ts` |
| Plans | FREE / PRO / BUSINESS — limits in `src/lib/plan-limits.ts` |

## Run / build / deploy
- Dev: `npm run dev` · Build: `npm run build`
- DB: `npm run db:migrate` · seed: `npm run db:seed`
- Deploy (on the VPS): `bash deploy/deploy.sh` → `git pull main` + **`prisma db push`** (additive — syncs new columns/tables BEFORE restart, so column-adding features don't 500) + build (OOM-retry) + `pm2 restart ai-content`. Current safe low-heap deploy env used on prod: `BUILD_HEAP_MB=4096 BUILD_WORKER_HEAP_MB=512 BUILD_HEAP_MB_LOW=3072 BUILD_WORKER_HEAP_MB_LOW=512 BUILD_NO_LINT=1`.
- **Deploy has a CI gate (step `[1b/6]`).** After pulling, `deploy.sh` reads the HEAD commit's
  GitHub check-runs (public repo → no token needed) and **aborts unless every check is green**.
  It also aborts when CI is still running, when the commit has no checks at all, or when GitHub
  is unreachable — fail-closed in every case. This is what actually protects paying customers:
  a red commit can land on `main` and still never reach production. Emergency override:
  `DEPLOY_SKIP_CI_CHECK=1 bash deploy/deploy.sh` — use it only for a real incident, and say so.
- **Crons** are separate PM2 apps in `ecosystem.config.js` (`trial-expiry`, `founding-sweep`, `renewal-reminders`, `cleanup-videos`). deploy.sh does NOT start them. Start: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` then `pm2 start ecosystem.config.js --only <name> --update-env && pm2 save` (the cron 401s without CRON_SECRET in its env). **`pm2 status` showing a cron app as `stopped` between scheduled runs is BY DESIGN** (`autorestart: false` + `cron_restart` — it runs once then exits until the next cron fire), not a crash — check `pm2 logs <name>` for actual health, don't judge by process status alone.
- VPS prod `.env` `DATABASE_URL` is **absolute** (`file:/var/www/ai-content/prisma/dev.db`); `prisma/*.db` is gitignored (prod data safe from `git pull`).

## Key directories
- `src/app/page.tsx` — public homepage = **evergreen sale page** (logged-in users → redirected to `/dashboard` by middleware). `src/components/marketing/` — sale-page + auth client islands: `pricing-toggle.tsx`, `motion-fx.tsx` (Reveal/ContainerScroll/SpotlightCard, dep `motion`), `marketing-fx.tsx` (animated bg), `showcase-clip.tsx`, `auth-shell.tsx` (shared /login+/register shell). **Design system = single-accent VIOLET** (`#8b5cf6`), Bai Jamjuree headings. Logo `public/logo.svg` + favicon `src/app/icon.svg`/`favicon.ico`. Real-output showcase clips self-hosted in `public/showcase/` (gitignored `*.jpg` → `git add -f`).
- `src/app/(dashboard)/` — pages: pricing (redesigned + founding), settings, video-creator, video-editor, content, style, admin
- `src/app/api/` — ~87 routes (`videos/*`, `payments/*`, `coupons/*`, `founding/*`, `cron/*`, `heygen/*`, `elevenlabs/*`, …)
- `src/remotion/` + `src/components/remotion/` — render compositions
- `src/lib/` — `clerk-auth.ts` (live auth + lazy-create that grants the 7-day trial), `stripe.ts`, `load-stripe-config.ts`, `gemini.ts`, `plan-limits.ts`, `prisma.ts`, `founding.ts` (atomic seat counter), `trial.ts` (grant/revert), `pricing-display.ts` (coupon/founding price rule)
- `scripts/` — cron scripts + `verify-*.ts` (the team's test pattern: run logic against a throwaway SQLite via `tsx`)
- `prisma/schema.prisma` — data model · `deploy/` — VPS setup/deploy scripts

## Gotchas (important)
- **`main` = production.** The VPS deploys from `main`. Never push broken code to main.
- **Mew owns the entire project (updated 07-02):** Mew controls every vertical solo — **no coordination with wao on anything** (shared files, render backend, schema, deploy included). She rebases + merges to `main` + deploys herself. Still build-verify render-backend changes before merging (hygiene, not a coordination gate).
- **Config shadowing (HISTORICAL — fixed 06-16, commit `5fb76cb`):** `next.config.js` used to SHADOW `next.config.ts` (Next 15 resolves .js first) → everything in `next.config.ts` was inactive. `next.config.js` was deleted; `next.config.ts` is now the sole active config (serverExternalPackages, OOM `cpus:1`, webpack externals, `/renders` rewrite, `ignoreBuildErrors` all live). If a `next.config.js` ever reappears, it will shadow `.ts` again — treat that as a bug. Likewise `ecosystem.config.js` `env:` block shadows `.env` for `RENDER_*`/cache, and a plain `pm2 restart` keeps the OLD env → use `pm2 restart <app> --update-env`.
- **Video editor current flow (06-08):** `/video-editor` Render creates an editable preview with voice/avatar+BGM and live subtitle overlay; it must NOT auto burn. `Burn & Download` is the final export step.
- **Subtitle timing (06-12, PRs #35-#39):** ซับของเสียง TTS (Gemini/ElevenLabs) มาจาก `timing` ใน TTS response — exact-by-arithmetic, **ข้าม transcribe** (`src/lib/tts-timing.ts` + `_components/tts-timing-captions.ts`); การ์ด viral มาจาก `/api/videos/split-script` (text-only LLM, server validate ห้ามแก้ข้อความ). transcribe = fallback สำหรับ avatar/อัปโหลด เท่านั้น. ทุกชั้นมี fail-open → ห้าม "ซ่อม" โดยเอา transcribe กลับมาเป็น path หลัก.
- **Render has NO global queue**, but clip caps are enforced via `reserveClipUsage` (FREE 2 / PRO 100 / BUSINESS 300 per 30 days) — see `STATUS.md`.
- **Pricing tiers are admin-editable, NOT hardcoded:** `src/lib/plan-config.ts` is the single source (name/badge/tagline/features/price per tier), read from DB `SiteConfig` keys `plan_<tier>_<field>` (features pipe-delimited) → used by BOTH `/api/plans` (in-app `/pricing`) AND the marketing sale page (`PricingToggle` takes a `plans` prop). Edit at `/admin` → Plan Config. Don't re-hardcode tier features. **Plan LIMITS** (clips/duration/storage) stay in `plan-limits.ts` — backend-ENFORCED, not just display, so they're code not DB.
- **Pricing display rule:** show effective **monthly price, NO annual total** on both pricing surfaces (full annual amount appears only at Stripe checkout). In-app `/pricing` is a LEAN convert page (personalized trial/usage band) — NOT a second sale page.
- **Clerk middleware matcher must whitelist static media** (`mp4|webm|mov` in `src/middleware.ts`) or those files get redirected to /login (symptom: poster `.jpg` loads but `<video>` won't play). Any new static media type needs the same.
- **BYOK by default:** paid external-provider features need the user's own API keys → onboarding must guide key setup. Approved managed exceptions are narrow and product-funded: OmniVoice audio (server credential, HTTPS/IP restriction, fail-closed flags + allowlist, backend AI-audio/minute limits; ADR 0003) and Hero AI Image/Brand Visual generation through the qualified RunPod Z-Image route (shared-credit or Starter AI Image Allowance settlement, fixed per-image price, fail-closed rollout and cost guard). Neither exception may silently fall back to another AI Engine.
- Windows-aware (MAX_PATH, ffmpeg installer); render tuned for low-RAM hosts.

## Working conventions
- Work on feature branches (`mew/...`), open a PR into `main` — avoid committing straight to main. **Mew rebases + merges + deploys** (including wao's branches).
- Follow existing code style. Build-verify render-backend changes before merging.

## Workspace rules — READ BEFORE TOUCHING ANY FILE

This is a **live production SaaS with paying customers**. `origin/main` deploys to the
Hostinger VPS via `deploy/deploy.sh`. Anything that reaches `main` reaches customers.

### 1. The repo root is a read-only baseline
`/Users/mewsocialmacmini/projects/AI_content_Mew_social` stays checked out on `main`
and is **never edited**. It exists so agents can read current-truth code.

- Do NOT edit, commit, or switch branches in the root checkout.
- If you were started in the root and have work to do, create a worktree first.

### 2. One task = one worktree = one branch = one PR
Create worktrees **only** through Orca:

```bash
orca worktree create --repo name:AI_content_Mew_social --name <slug> --agent <claude|codex>
orca worktree create --repo name:AI_content_Mew_social --issue <n>   # when a GitHub issue exists
```

Hard rules:
- **NEVER** run `git worktree add` yourself.
- **NEVER** create a worktree under `/private/tmp` — macOS deletes it and the work is gone.
- **NEVER** create a worktree under `.worktrees/`, `.claude/worktrees/`, or as a sibling
  folder in `~/projects/`. Orca owns `AI_content_Mew_social.worktrees/`.
- Always branch from the latest `origin/main` (`git fetch origin main` first).
- Branch naming: `mew/<slug>` (Mew), `codex/<slug>` (Codex), `agent/<slug>` (other agents).

### 3. Never share a working directory with another agent
Before starting, confirm no other agent session is running in the same directory.
Two agents in one checkout will overwrite each other's half-finished edits. If a
directory is already occupied, create your own worktree instead.

### 4. Shipping to production
- Land via PR into `main`. CI (`.github/workflows/ci.yml`) must be **green** — a red
  CI run is a stop sign, not a warning.
- Never push directly to `main`. Never force-push `main`.
- Schema changes: deploy runs `prisma db push` (additive). Column *removals* and
  renames are NOT safe through that path — flag them to Mew instead of shipping.
- After merging, prod deploy is a **human decision**. Do not run `deploy/deploy.sh`
  or SSH to the VPS unless Mew explicitly asks in that message.

### 5. Housekeeping
- A worktree older than 7 days must be rebased onto `origin/main` or deleted.
- Delete the worktree when its PR merges (`orca worktree rm`).
- Never commit `.orca/`, `.playwright-mcp/`, `__pycache__/`, `artifacts/`, or `*.cpuprofile`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
