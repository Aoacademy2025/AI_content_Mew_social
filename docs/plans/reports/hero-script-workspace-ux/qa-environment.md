# Browser QA environment

## Finding

Puppeteer `25.6.0` and cached Chrome 151 launch successfully, including 390×844. Start the app with `npm run dev -- --hostname 127.0.0.1 -p 3100`; Puppeteer can drive 1366×768 and 390×844 without another dependency.

No qualifying mounted Hero Script QA path exists. `/hero-script` is stopped in the server layout by `getCurrentUser()` before client interception can mock `/api/*`. That call uses Clerk and Prisma and may create/sync a user. The repo has no Hero Script test-auth switch, fixture server, browser script, Playwright configuration, or network fixture set. A normal local Clerk session is neither mock auth nor isolated data.

Before browser acceptance, add an explicit non-production test-auth/isolated-SQLite fixture seam, then use the existing Puppeteer Chrome to intercept only Hero Script API responses and capture the two viewport screenshots. Do not record this as QA until that mounted fixture path exists.
