# (auth) — follow the root CLAUDE.md

This directory has **no special rules** beyond the project-root `CLAUDE.md` (the authoritative guide). Respond in Thai; guide the non-technical user.

⚠️ A previous version of this file was a generic boilerplate template (Neon/Vercel Blob/RLS/Prisma **migrations**/`test@test.com` seed) that does **NOT** match this project — ignore that guidance. Real stack: **Clerk** auth, **SQLite** via Prisma (`prisma db push`, not migrate), **Hostinger VPS** (not Vercel), no Vercel Blob, no data seeding. Trust root `CLAUDE.md` + `STATUS.md`.

Auth pages `/login` + `/register` share `src/components/marketing/auth-shell.tsx` (server component, single-accent violet CI, renders Clerk `<SignIn>/<SignUp>` themed via the exported `CLERK_APPEARANCE`; shows live founding seats).
