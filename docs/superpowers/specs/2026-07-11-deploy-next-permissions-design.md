# Deploy `.next` Permission Hardening Design

## Context

The 2026-07-11 production deploy produced `.next` directories with mode `0700`
and files with mode `0600`. The build inherited a restrictive caller umask, so
the Nginx worker could not traverse `.next/static` or read CSS, JavaScript, and
font assets. The application HTML and health endpoint stayed online while every
same-origin Next.js asset returned `403`.

The immediate production containment was `chmod -R a+rX /var/www/ai-content/.next`.
This design makes that normalization part of every future deploy without changing
production in this PR.

## Decision

Normalize the completed staging build with `chmod -R a+rX "$STAGING_DIR"` after
the final `BUILD_ID` gate and before the atomic `.next-staging -> .next` swap.

This placement guarantees that:

- a restrictive caller umask cannot make the published build unreadable;
- directories are traversable and files are readable by the Nginx worker;
- ordinary non-executable files do not become executable;
- `.env`, the database, logs, and files outside the staging build are untouched;
- a failed permission normalization aborts before the live `.next` is replaced.

## Alternatives Considered

1. Set `umask 022` at the start of the entire deploy. Rejected because it changes
   permissions for dependency installation, generated clients, logs, and other
   deploy outputs outside the web build.
2. Normalize the live `.next` after the swap. Rejected because it creates a window
   where Nginx can return `403`, and a failure would leave the bad build live.
3. Normalize only `.next/static`. Rejected because Next.js may serve other build
   artifacts through the application process and future asset paths could be added.

## Regression Protection

Add `scripts/verify-deploy-static-permissions.ts`. It must fail unless the exact
normalization command exists after the final `BUILD_ID` gate and before the staging
swap. It also exercises `chmod -R a+rX` against a temporary tree created with
`0700` directories and `0600` files, proving the intended read/traverse bits and
preservation of the non-executable file state.

## Rollout Constraints

- This work creates and updates GitHub branches and pull requests only.
- Do not run `deploy/deploy.sh`.
- Do not deploy, restart PM2, push schema, run backfill apply, or enable cleanup apply.
