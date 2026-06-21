# CLAUDE.md — Project Guide for AI Agents

> Read this first. It reflects the **actual** state of the project. `PRD.md` describes an older vision and is partly outdated — when they conflict, trust this file + `STATUS.md`.

## What this is
**HERO AI Creator Studio** (studio.heroaiengine.com) — a Next.js SaaS that turns **one script into a finished short-form video, automatically**: AI avatar (full / bookend / none), auto **Thai subtitles** (long or viral-keyword style), auto **B-roll** (changes every 3–5s), voice cloning, music. Built for Faceless creators & content makers. Core flow: **Style → Content → Video**.

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
- Deploy (on the VPS): `bash deploy/deploy.sh` → `git pull main` + **`prisma db push`** (additive — syncs new columns/tables BEFORE restart, so column-adding features don't 500) + build (OOM-retry) + `pm2 restart ai-content`. Current safe low-heap deploy env used on prod: `BUILD_HEAP_MB=4096 BUILD_WORKER_HEAP_MB=512 BUILD_HEAP_MB_LOW=3072 BUILD_WORKER_HEAP_MB_LOW=512 BUILD_NO_LINT=1`.
- **Crons** are separate PM2 apps in `ecosystem.config.js` (`trial-expiry`, `founding-sweep`, `renewal-reminders`, `cleanup-videos`). deploy.sh does NOT start them. Start: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"` then `pm2 start ecosystem.config.js --only <name> --update-env && pm2 save` (the cron 401s without CRON_SECRET in its env).
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
- **Two devs; Mew = MAIN DEPLOYER (rule set 06-16):** wao works on feature branches; **Mew rebases + merges to `main` + deploys herself** — don't gate merges on wao. Vertical origin: Mew = Payment/pricing (Stripe, coupons, pricing+schema); wao = video/AI render backend. Coordinate on INTENT for shared files (`prisma/schema.prisma`, `package.json`, `next.config.js`, `ecosystem.config.js`, `deploy.sh`) + build-verify render-backend changes before merging — but Mew makes the final merge/deploy call.
- **Config shadowing (cost hours — beware):** `next.config.js` SHADOWS `next.config.ts` (Next 15 resolves .js first, on EVERY machine incl. local) → everything in `next.config.ts` (serverExternalPackages, OOM `cpus:1`, webpack externals, `/renders` rewrite, `ignoreBuildErrors`) is **INACTIVE**; effective config lives in `next.config.js`. Likewise `ecosystem.config.js` `env:` block shadows `.env` for `RENDER_*`/cache, and a plain `pm2 restart` keeps the OLD env → use `pm2 restart <app> --update-env`.
- **Video editor current flow (06-08):** `/video-editor` Render creates an editable preview with voice/avatar+BGM and live subtitle overlay; it must NOT auto burn. `Burn & Download` is the final export step.
- **Subtitle timing (06-12, PRs #35-#39):** ซับของเสียง TTS (Gemini/ElevenLabs) มาจาก `timing` ใน TTS response — exact-by-arithmetic, **ข้าม transcribe** (`src/lib/tts-timing.ts` + `_components/tts-timing-captions.ts`); การ์ด viral มาจาก `/api/videos/split-script` (text-only LLM, server validate ห้ามแก้ข้อความ). transcribe = fallback สำหรับ avatar/อัปโหลด เท่านั้น. ทุกชั้นมี fail-open → ห้าม "ซ่อม" โดยเอา transcribe กลับมาเป็น path หลัก.
- **Render has NO global queue**, but clip caps are enforced via `reserveClipUsage` (FREE 2 / PRO 100 / BUSINESS 300 per 30 days) — see `STATUS.md`.
- **Pricing tiers are admin-editable, NOT hardcoded:** `src/lib/plan-config.ts` is the single source (name/badge/tagline/features/price per tier), read from DB `SiteConfig` keys `plan_<tier>_<field>` (features pipe-delimited) → used by BOTH `/api/plans` (in-app `/pricing`) AND the marketing sale page (`PricingToggle` takes a `plans` prop). Edit at `/admin` → Plan Config. Don't re-hardcode tier features. **Plan LIMITS** (clips/duration/storage) stay in `plan-limits.ts` — backend-ENFORCED, not just display, so they're code not DB.
- **Pricing display rule:** show effective **monthly price, NO annual total** on both pricing surfaces (full annual amount appears only at Stripe checkout). In-app `/pricing` is a LEAN convert page (personalized trial/usage band) — NOT a second sale page.
- **Clerk middleware matcher must whitelist static media** (`mp4|webm|mov` in `src/middleware.ts`) or those files get redirected to /login (symptom: poster `.jpg` loads but `<video>` won't play). Any new static media type needs the same.
- **BYOK:** paid features need the user's own API keys → onboarding must guide key setup.
- Windows-aware (MAX_PATH, ffmpeg installer); render tuned for low-RAM hosts.

## Working conventions
- Work on feature branches (`mew/...`), open a PR into `main` — avoid committing straight to main. **Mew rebases + merges + deploys** (including wao's branches).
- Follow existing code style. Build-verify render-backend changes before merging.
