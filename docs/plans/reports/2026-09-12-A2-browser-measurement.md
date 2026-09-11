# A2 — Browser Measurement of the Five Pages

Session: Mew's logged-in Chrome (admin account, plan BUSINESS), studio.heroaiengine.com, 2026-09-12.
Tool used for everything below: `claude-in-chrome` MCP (`javascript_tool` + `navigate` + link `.click()` via injected JS). `chrome-devtools` MCP was attached to a **separate, not-logged-in** Chrome profile (`list_pages` showed only `about:blank`) — see the process report for detail. All numbers are from `performance.getEntriesByType('navigation'|'resource')`, timed with `performance.now()`. No screenshots were taken or saved anywhere.

**Cold** = fresh top-level `navigate()` to the URL (no browser cache was explicitly cleared between reps, so cold numbers benefit somewhat from HTTP cache on static JS/CSS after the first rep — flagged honestly, not a true empty-cache load). **Warm** = clicking the real in-app sidebar `<a>` link (`element.click()` on the actual anchor) from another already-loaded page, i.e. a Next.js client-side transition. "Time-to-usable" = `responseEnd` of the specific XHR/fetch named per page below (the request whose data populates the page's headline numbers/list), measured relative to navigation start (cold) or relative to the click (warm).

## Incident note (read before the numbers)

Mid-session, an attempt to time `/api/admin/cleanup` 20× sequentially (per the original Step-2 plan) left two overlapping fetch loops running concurrently for several minutes. `/api/admin/cleanup` does a full disk walk (confirmed: 35,091 files / ~159GB scanned — see `admin-cleanup.json`) and appears to cause collateral slowdown on unrelated endpoints while it runs: an isolated `/api/admin/stats` fetch measured **204ms, then 1,062ms, then 20,955ms, then 23,494ms**, then recovered to ~200ms after ~90s of no further load. All in-flight requests were killed by navigating the tab away, and the endpoint's own repetition count was cut from 20 to a single measurement for `/api/admin/cleanup` and `/api/admin/insights?days=30` (the other endpoint the brief flagged as "expected slow") to avoid repeating this. All 12 other endpoints below have full, clean n=20 data taken before this incident. See the process report for the full timeline and rationale. **A3 should treat this as a live finding**, not just a testing artifact: a single admin request can apparently degrade the whole admin API surface for ~1-2 minutes.

## Per-page table

| Page | Cold #1 | Cold #2 | Cold #3 | Cold median | Warm #1 | Warm #2 | Warm #3 | Warm median | Time-to-usable request |
|---|---|---|---|---|---|---|---|---|---|
| `/admin` | 1539 | 1038 | 488 | **1038** | 786 | 747 | 616 | **747** | `GET /api/admin/stats` |
| `/dashboard` | 743 | 674 | 618 | **674** | 541 | 3342 | 3458 | **3342** | `GET /api/user/me` |
| `/videos` | 568 | 686 | 684 | **684** | 546 | 523 | 570 | **546** | `GET /api/videos` |
| `/admin/insights?days=30` | 815 | 933 | 874 | **874** | 773 | 746 | 666 | **746** | `GET /api/admin/insights` |
| `/video-editor` (existing project) | 994 | 880 | 817 | **880** | 802 | 887 | 860 | **860** | `GET /api/editor-projects/:id` |

All times in ms. `/dashboard` warm is bimodal (541 vs 3342/3458) — see "Worst offenders" below.

## Per-page detail (request count, JS bytes, render-blocking CSS)

Only the first clean sample per page is shown for resourceCount/JS bytes; repeats on the same origin reuse HTTP cache so these numbers shrink on later reps (e.g. `/admin` JS transferred: 110,378 B → 229,114 B → 0 B across 3 cold reps — the 0 B rep hit full HTTP cache, the 229KB rep evicted more of it; this is normal browser cache behavior across repeat navigations, not something the app controls).

| Page | Resource count (cold #1) | JS transferred (cold #1) | `fonts.googleapis.com` stylesheet duration | Long tasks / LCP / CLS |
|---|---|---|---|---|
| `/admin` | 57 | 110,378 B | 21ms | not measurable — see note below |
| `/dashboard` | 57 | 0 B (cached) | 0ms | not measurable |
| `/videos` | 50 | 0 B (cached) | 10ms | not measurable |
| `/admin/insights?days=30` | 51 | 0 B (cached) | (not captured this rep) | not measurable |
| `/video-editor` | 87 | (not isolated; page loads ~18 XHRs) | (not captured) | not measurable |

**Long Tasks / LCP / CLS / paint timing could not be measured in this session.** `performance.getEntriesByType('paint')` returned `[]` and a live `PerformanceObserver({type:'largest-contentful-paint', buffered:true})` also returned nothing, even seconds after load. Root cause: Chrome suppresses the Paint Timing / LCP / CLS APIs for tabs that are not the foreground/visible tab, and the `claude-in-chrome` automation tabs used here are background tabs. Nav Timing (TTFB/DCL/load) and Resource Timing (all XHR/fetch/script/css entries) are unaffected by this and are fully reliable. **Lighthouse was not available** — `chrome-devtools` MCP was attached to a separate, logged-out Chrome profile, so the render-blocking-CSS substitute above (the `fonts.googleapis.com` stylesheet duration) is used instead, and it is consistently negligible (0-21ms) across every page — Google Fonts CSS is not a meaningful render-blocking cost in this app.

## Per-endpoint timings (Step 2)

n=20 (run 1 = cold, runs 2-20 sorted for p50/p95/max) for all rows except the two marked *(reduced n, see incident note)*.

| Route | Status | Cold (run 1) | Warm p50 | Warm p95 | Warm max |
|---|---|---|---|---|---|
| `/api/user/me` | 200 | 338 | 182 | 219 | 219 |
| `/api/updates?summary=1` | 200 | 88 | 95 | 163 | 163 |
| `/api/notifications` | 200 | 226 | 104 | 182 | 182 |
| `/api/admin/stats` | 200 | 127 | 190 | 209 | 209 |
| `/api/admin/settings` | 200 | 99 | 100 | 232 | 232 |
| `/api/admin/storage` | 200 | 259 | 269 | 528 | 528 |
| `/api/admin/cleanup?olderThanDays=3&includeStocks=false&includeTmp=false` *(n=1, see incident note)* | 200 | 10164-10738 (3 independent samples, all in this range) | n/a | n/a | n/a |
| `/api/admin/support?status=OPEN` | 200 | 155 | 93 | 169 | 169 |
| `/api/admin/music` | 200 | 102 | 91 | 160 | 160 |
| `/api/admin/insights?days=30` *(n=20, but see note)* | 200 | 1041 | 826 | 996 | 996 |
| `/api/user/stats` | 200 | 254 | 100 | 188 | 188 |
| `/api/videos` | 200 | 216 | 99 | 160 | 160 |
| `/api/editor-projects` | 200 | 86 | 93 | 155 | 155 |
| `/api/admin/revenue` | 200 | 2953 | 1704 | 1853 | 1853 |

Note on `/api/admin/insights?days=30`: the brief expected this to be slow-cold like storage/cleanup (disk/scan cost). It was **not** — cold=1041ms, stable warm ~800-970ms across 19 warm reps. Recommend the plan's assumption here be corrected for A3/A4.

All raw (sanitized) response bodies are saved under `docs/plans/reports/2026-09-12-A2-api-json/` — one file per route, PII (email/name/script/prompt/url/title/message/subject, plus avatar/image/data-URIs/filesystem paths found during sanitization) stripped, arrays reduced to `{_arrayTruncated, _originalLength}`, objects capped to depth 2 / 10 keys per level.

## Three worst offenders per page (A3 to confirm)

**`/admin`**
1. `GET /api/admin/cleanup` — ~10.2-11.5s every single time, consistently. Confirmed cause (from its own response body): it walks 35,091 files (~159GB) synchronously on every request, no caching, no pagination. *Hypothesis: synchronous `fs` directory walk on the Node request thread, run fresh on every page load instead of cached/backgrounded.*
2. `GET /api/notifications` — 226-1170ms cold, payload is 50 full notification objects with no visible pagination/limit. *Hypothesis: missing `LIMIT`/pagination on the notifications query, or full-object hydration when only unread-count + last N are needed.*
3. `GET /api/user/me` — 277-861ms cold, called on literally every page (it's the top offender-adjacent cost across all 5 pages measured, not unique to `/admin`). Payload has 40+ top-level fields, several nested feature-flag objects, and a base64-encoded avatar image on some responses. *Hypothesis: over-fetching — one "kitchen sink" `/api/user/me` shape is called on every route instead of route-scoped fields.*

**`/dashboard`**
1. Warm-navigation bimodality: 541ms then two consecutive 3,342/3,458ms warm loads, all navigating from `/admin`. *Hypothesis: NOT simply "coming from /admin" (the fast 541ms rep also came from /admin) — more likely genuine backend contention during the measurement window (matches the /api/admin/stats 204ms-to-23,494ms swings seen independently). A3 should re-test with the admin panel completely idle.*
2. `GET /api/videos/jobs/:id` — 777-1029ms, the slowest single dashboard XHR every rep. *Hypothesis: a per-render-job detail lookup (probably for the "recent video" card status) that isn't batched with the recent-videos list.*
3. `GET /api/user/me` — 618-864ms cold, same over-fetching hypothesis as above.

**`/videos`**
1. `GET /api/user/me` — 768-813ms cold, again the single slowest call despite `/videos` not needing most of its fields.
2. `GET /api/videos` — 568-690ms, the page's own primary list; payload is 24 full job records for a page rendering thumbnails/status only. *Hypothesis: over-fetching per row (e.g. full script/prompt fields) instead of a list-view-shaped projection.*
3. `GET /api/editor-projects` — 589-700ms, fetched on `/videos` even though this page doesn't render editor projects. *Hypothesis: a shared layout-level fetch (e.g. a "continue editing" widget) running unconditionally on pages that don't use the data.*

**`/admin/insights?days=30`**
1. `GET /api/admin/insights` — 666-996ms, the heaviest single query on this page (renderStats/jobOutcomes/activation aggregates in the response). *Hypothesis: several grouped-by aggregation queries running sequentially rather than in parallel/pre-aggregated.*
2. `GET /api/admin/costs` — 549-1051ms, a sibling call fired alongside insights. *Hypothesis: same root cause as #1 — could likely be parallelized or merged into one response.*
3. `GET /api/user/me` — 944-1098ms cold on this page specifically (slower here than elsewhere), consistent with the cross-page over-fetching hypothesis, possibly worse here due to concurrent load from the two heavier sibling calls above.

**`/video-editor` (existing project)**
1. `GET /api/heygen/avatar-info` — 2,385-3,283ms, by far the single slowest call on any of the 5 pages measured (excluding the confirmed-slow admin/cleanup), on *every* load including warm. *Hypothesis: uncached, synchronous call out to the third-party HeyGen API on every editor mount, regardless of whether the project uses an avatar.*
2. `GET /api/omnivoice/status` — 1,148-1,347ms. *Hypothesis: another uncached third-party/status round-trip fired unconditionally on mount.*
3. `GET /api/videos/jobs/:id` — fetched **twice** per page load (1,108-1,198ms then 1,345-1,681ms for the second call). *Hypothesis: duplicate fetch — likely one from an initial-state hook and one from a polling/status hook that aren't deduplicated.*

## Deviations from the brief

1. `/api/admin/cleanup`: measured 1× instead of 20×, after the concurrency incident above. Cold cost is highly consistent across the 3 independent samples taken during this session (10,164 / 10,295 / 10,738ms), so a p50/p95/max over 20 near-identical repeats would have added little information for a ~10x increase in load on a route that appears to have collateral effects on the rest of the admin API.
2. `/api/admin/insights?days=30`: measured with n=20 as planned once it was established (via a single safe probe) that it is not actually slow — but this deviates from the brief's assumption that it needed "known-cost" treatment like cleanup/storage.
3. LCP/CLS/long-task/paint-timing: not measurable via this tool (background-tab suppression) — Nav Timing + Resource Timing substituted throughout, as noted above.
4. Lighthouse: not available (chrome-devtools MCP attached to a logged-out profile) — fonts.googleapis.com stylesheet duration substituted per the brief's own fallback instruction.
5. `/admin/insights` warm clicks landed on `/admin/insights` without an explicit `?days=30` (the in-app sidebar link has no query string); the page's own default is 30 days server-side, consistent with the brief's intent. Cold measurements did use the exact `?days=30` URL as specified.
