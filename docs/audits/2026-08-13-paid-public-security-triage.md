# Paid Public AI launch — dependency and security triage

Date: 2026-08-13
Branch: `mew/subscription-first-ai-launch`
Scope: local implementation and disposable-database verification only; no production deployment or flag change.

## Outcome

The dependency release blocker is closed on this branch. The production tree
started with 42 reported findings (1 critical, 28 high, 10 moderate, 3 low).
After the remediation, both `npm audit --omit=dev` and the full `npm audit`
report **0 vulnerabilities**. No Critical or High finding has been accepted or
deferred.

## Remediation

- Upgraded Next.js and its ESLint config from 15.3.9 to 16.3.0.
- Migrated the deprecated `src/middleware.ts` convention to the Next 16
  `src/proxy.ts` convention while preserving the Clerk route policy.
- Removed the unused NextAuth dependency and deleted its legacy auth adapter and
  type augmentation. Authentication continues through Clerk.
- Upgraded Nodemailer 7→9, Sharp 0.34→0.35, Puppeteer 24→25, and tsx to the
  patched line; accepted compatible transitive audit updates in the lockfile.
- Kept the production build on webpack explicitly because the app's native
  ffmpeg/Remotion asset contract still uses a webpack hook.
- Removed build-time TypeScript and ESLint bypasses. Type checking and lint are
  release gates rather than advisory output.

## Verification evidence

| Gate | Result |
|---|---|
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |
| `npm audit` | PASS — 0 vulnerabilities |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — Next 16.3.0, webpack, 171 pages |
| Proxy/auth route compilation | PASS — build reports `Proxy (Middleware)` |
| Hero Image gate and disclosure | PASS |
| Hero Image reservation/refund resilience | PASS |
| Hero Script service/access suite | PASS — 513 service checks plus Paid-Equivalent access integration |
| Brand Visual system suite | PASS |
| Paid-Equivalent matrix | PASS |
| Administrator Grant audit/revoke suite | PASS |
| Trial one-time allowance suite | PASS |
| MAPC recurring-cash/outcome/snapshot suite | PASS |

## Operational controls still required

These are launch operations, not unresolved dependency findings:

1. Back up the production SQLite database and run schema preflight before the
   normal additive `prisma db push` deployment path.
2. Set and retain `KEY_ENC_SECRET`, then migrate any existing BYOK/provider keys
   with `scripts/encrypt-existing-keys.ts`; the app must not launch public AI
   generation while keys remain reversible base64 at rest.
3. Run Administrator Grant and Conversion Trial migrations in dry-run mode,
   confirm zero unresolved reservations, then apply with the documented backup
   acknowledgement.
4. Smoke-test auth, checkout, webhook confirmation, locked previews, one Trial
   image, one paid image, Hero Script handoff, and Brand Visual on a paid canary.
5. Keep Brand Visual at the approved paid 10% canary until its reliability and
   cost gates pass; promote 10→50→100 only with a separate production approval.
6. Complete the approved 5–7 day paid soak before describing the launch as
   generally available.

## Rollback

Application rollback is a code/flag rollback. New schema objects are additive
and may remain in place. Do not delete grant, allowance, snapshot, or image-job
origin records during rollback; they are audit and settlement evidence.
