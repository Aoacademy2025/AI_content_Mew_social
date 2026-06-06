# CLAUDE.md — Project Guide for AI Agents

> Read this first. It reflects the **actual** state of the project. `PRD.md` describes an older vision and is partly outdated — when they conflict, trust this file + `STATUS.md`.

## What this is
**HERO AI** (studio.heroaiengine.com) — a Next.js SaaS that turns **one script into a finished short-form video, automatically**: AI avatar (full / bookend / none), auto **Thai subtitles** (long or viral-keyword style), auto **B-roll** (changes every 3–5s), voice cloning, music. Built for Faceless creators & content makers. Core flow: **Style → Content → Video**.

## Actual tech stack (differs from PRD.md!)
| Area | Reality |
|---|---|
| Framework | Next.js 15 (App Router) + React 19, TypeScript |
| Styling | Tailwind v4 + shadcn/ui |
| Auth | **Clerk** — `src/lib/auth.ts` (NextAuth) is legacy/leftover, NOT the live auth |
| DB | **SQLite** via Prisma 6 — `prisma/dev.db` (NOT PostgreSQL) |
| Hosting | **Hostinger VPS** (Ubuntu, 4 vCPU/15GB) + PM2 + Nginx + Let's Encrypt (NOT Vercel) |
| Render | **Remotion + headless Chromium + ffmpeg**, runs locally on the VPS (software, no GPU) |
| AI (all **BYOK** — users supply their own keys; no server AI keys) | Gemini (content/transcribe/keywords/TTS), HeyGen (avatar), ElevenLabs (TTS), Pexels/Pixabay (stock) |
| Payments | Stripe — **subscription (auto-renew) + one-time/PromptPay LIVE 06-05**; **Founding-100 (50%/forever, first 100, coupon `FOUNDING100`) + Free trial (7-day PRO) LIVE 06-07**. Config in DB `SiteConfig` (NOT `.env`), loaded by `src/lib/load-stripe-config.ts` |
| Plans | FREE / PRO / BUSINESS — limits in `src/lib/plan-limits.ts` |

## Run / build / deploy
- Dev: `npm run dev` · Build: `npm run build`
- DB: `npm run db:migrate` · seed: `npm run db:seed`
- Deploy (on the VPS): `bash deploy/deploy.sh` → `git pull main` + **`prisma db push`** (additive — syncs new columns/tables BEFORE restart, so column-adding features don't 500) + build (12GB heap, OOM-retry) + `pm2 restart ai-content`.
- **Crons** are separate PM2 apps in `ecosystem.config.js` (`trial-expiry`, `founding-sweep`, `renewal-reminders`; `cleanup-videos` off). deploy.sh does NOT start them. Start: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` then `pm2 start ecosystem.config.js --only <name> --update-env && pm2 save` (the cron 401s without CRON_SECRET in its env).
- VPS prod `.env` `DATABASE_URL` is **absolute** (`file:/var/www/ai-content/prisma/dev.db`); `prisma/*.db` is gitignored (prod data safe from `git pull`).

## Key directories
- `src/app/page.tsx` — public homepage = **evergreen sale page** (logged-in users → redirected to `/dashboard` by middleware). `src/components/marketing/` — sale-page client islands (`pricing-toggle.tsx`)
- `src/app/(dashboard)/` — pages: pricing (redesigned + founding), settings, video-creator, video-editor, content, style, admin
- `src/app/api/` — ~87 routes (`videos/*`, `payments/*`, `coupons/*`, `founding/*`, `cron/*`, `heygen/*`, `elevenlabs/*`, …)
- `src/remotion/` + `src/components/remotion/` — render compositions
- `src/lib/` — `clerk-auth.ts` (live auth + lazy-create that grants the 7-day trial), `stripe.ts`, `load-stripe-config.ts`, `gemini.ts`, `plan-limits.ts`, `prisma.ts`, `founding.ts` (atomic seat counter), `trial.ts` (grant/revert), `pricing-display.ts` (coupon/founding price rule)
- `scripts/` — cron scripts + `verify-*.ts` (the team's test pattern: run logic against a throwaway SQLite via `tsx`)
- `prisma/schema.prisma` — data model · `deploy/` — VPS setup/deploy scripts

## Gotchas (important)
- **`main` = production.** The VPS deploys from `main`. Never push broken code to main.
- **Two devs, vertical ownership:** **Mew** owns the Payment/pricing vertical (Stripe, checkout, coupons, pricing pages + their schema). The other engineer (git author **`wao1234`**) owns the video/AI render backend. Coordinate before touching shared files: `prisma/schema.prisma`, `package.json`, `next.config.ts`.
- **Render has NO global queue**, and PRO/BUSINESS clip caps are **not enforced** (only FREE is) — see `STATUS.md`.
- **BYOK:** paid features need the user's own API keys → onboarding must guide key setup.
- Windows-aware (MAX_PATH, ffmpeg installer); render tuned for low-RAM hosts.

## Working conventions
- Work on feature branches (`mew/...`), open a PR into `main` — avoid committing straight to main.
- Follow existing code style. Coordinate deploy timing with the other dev.
