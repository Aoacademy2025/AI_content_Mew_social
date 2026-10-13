# Final hosted build: Google font URL parsing diagnosis

Date: 2026-10-14. Hosted run: `38451349387`, code `f78c7f20`. All verification steps passed; the actual build exited 1. Worker source equivalent to the reviewed maintenance candidate; no source changes in this investigation.

## Confirmed failure mechanism

The installed Next 16.3.0 Google font loader (`node_modules/next/dist/compiled/@next/font/dist/google/loader.js:122`) evaluates:

```js
const ext = /\.(woff|woff2|eot|ttf|otf)$/.exec(googleFontFileUrl)[1];
```

The captured CI error is:

```text
src/app/(dashboard)/video-editor/_v2/fonts.ts
An error occurred in next/font.
TypeError: Cannot read properties of null (reading '1')
.../next/dist/compiled/@next/font/dist/google/loader.js:122:78
```

The failing invocation is the existing `Noto_Sans_Thai` call (weights 400/500/600, thai/latin subsets). The stack establishes that a font URL extracted from CSS did not match the loader's supported extension-at-end assumption. **CI did not capture its CSS or offending URL. The exact upstream input and why it differed are unproven; this report does not declare a transient outage as fact.** Full failed-job output is `/tmp/mcp-maintenance-build-ci-failed.log`.

## Baseline and setup comparison

- `src/app/(dashboard)/video-editor/_v2/fonts.ts`, `scripts/build.js`, and `package-lock.json` are unchanged from the feature baseline `4c246180`.
- Baseline and current lockfile SHA256 are both `0d3469d7c991f4527be9d50137577e9c80c78002bd7aaf52ca2d2d0b467d161c`.
- Build remains `node scripts/build.js` → `next build --webpack`; no font rewrite or dependency change is involved.
- There is no repository Google-font mocked-response file or `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` setting. That variable was unset locally; failed CI build environment also lists no such setting. The scripts contain no `GITHUB_ENV` manipulation introducing one.
- CI uses Ubuntu/Node 22. Local execution used Mac/Node 26.7.0 and the same installed Next 16.3.0. This is not an identical-platform reproduction.

## Reproduction and control

1. Called the installed Next `fetchCSSFromGoogleFonts` with its own User-Agent and the actual generated URL `https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600&display=swap`: **exit 0**. Response has three distinct ordinary `fonts.gstatic.com` `.woff2` URLs; snapshot `/tmp/mcp-maintenance-noto-google.css`.
2. Called the **actual installed Google loader**, with the exact application options and real font fetching: **exit 0**, generated 3,123 CSS characters. This checks the loader, not just a standalone regular expression.
3. In a disposable Node process only, wrapped the CSS fetch return to append `?fixture=1` after each `.woff2` filename. The actual loader still downloads font bytes, then fails with **exit 1**, the same `TypeError` at `loader.js:122:78`. This demonstrates the parser's failure mode for a valid URL with a query suffix. **The suffix is deliberately synthetic; it is not evidence that CI received that suffix.** No installed file or repository file was patched.
4. Ran the actual unmocked production build:

```sh
DATABASE_URL=file:/tmp/mcp-maintenance-font-build.db CI=true NEXT_DISABLE_ESLINT=1 npm run build
```

**Exit 0**. Webpack compilation succeeded in 32.5 seconds, TypeScript in 16.1 seconds, and all 193 static pages/routes completed. Log: `/tmp/mcp-maintenance-font-build.log`. No font mocks, fabricated font assets, paid provider calls, or production database access. The worktree's copied environment files had already been removed before any imports.

## Decision

No bounded mock-fixture bug was found. No font design, dependency, installed loader or production source change is justified from the available evidence. Coordinator will retry the failed hosted job once on unchanged code to test the upstream-response hypothesis. If it repeats, capture the actual CSS/font URL from that environment before considering any correction. A successful retry would establish recovery, not retrospectively reveal the missing offending URL.
