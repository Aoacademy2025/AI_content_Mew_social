# Managed stock key for trial and FREE

Date: 2026-08-26
Status: Accepted, behind `MANAGED_STOCK` (off by default)

## Context

Bring-your-own-key is the product default (CLAUDE.md). The UX/Conversion audit of
2026-08-25 measured what that costs at the front door: of 448 signups, the 329
with no stock key started a clip **2.1%** of the time, while the 119 who had one
started **65.5%** of the time. The key gate, not the product, is what most new
accounts fail at.

The gate is also narrower than the UI admits. `src/app/api/videos/jobs/route.ts`
forces `stockSource = "kie-image"` for a Conversion Trial account's *first* clip,
so that one clip renders with the 8-image Hero AI Image starter allowance and no
stock key. Every clip after it — and every clip for a coupon/grant PRO account,
and every upload-mode clip — returns `400 missing_key: broll` without a Pexels or
Pixabay key. "No setup needed" is true exactly once.

The existing key-free photo providers (Wikimedia, NASA, Met) are photo-only
fallbacks inside AutoMix. Stock *video* has always required a user key; there is
no server-side stock key in production today.

### Capacity math

Production telemetry over 1,120 `fetch-stock` jobs since launch:

| Measure | Value |
| --- | --- |
| Keywords per clip (median) | 10 |
| Search queries per clip (avg / p90) | 16 / 23 |
| Peak load, all users | 17 jobs/h → **140 stock queries/h** |
| Daily volume | ~580 queries/day (~17k/month) |

Each query has historically been one Pexels call *and* one Pixabay call in
parallel.

| Provider | Published limit | All-users peak against it |
| --- | --- | --- |
| Pexels | 200 req/h, **20,000 req/month** | 70% hourly, **85% monthly** ⚠️ |
| Pixabay | 100 req/min (~6,000/h), no monthly cap | ~2% ✅ |

The managed key would serve only trial/FREE accounts (~40–50% of jobs), i.e.
roughly 60–70 Pexels req/h at today's peak. That is comfortable, but a 3× live
spike lands on the Pexels monthly cap first, and a monthly exhaustion would break
b-roll for *paying* BYOK users too if the same quota were shared — which is
precisely why the design below spends Pixabay first and rations Pexels.

## Decision

Treat a team-operated stock key as a narrow, flag-gated managed exception to
BYOK, in the ADR 0003 shape.

**Eligibility** (`decideManagedStockEligibility`, evaluated server-side only):

1. `MANAGED_STOCK !== "1"` → nobody; the request path is the pre-#297 one.
2. The account has a Pexels **or** Pixabay key of its own → **BYOK always wins**.
   We never replace a customer's own quota and curation with ours, and never
   spend the shared key on someone who already brought one.
3. Suspended → fail closed.
4. No managed key configured on the server → nothing to offer.
5. Otherwise eligible when the account is on a live Conversion Trial, or is FREE
   and not paid-equivalent.

Paid-equivalent accounts (subscription, paid term, bundle, GRANT coupon,
administrator grant) with no stock key **keep today's `missing_key: broll` 400**.
This is deliberate. The activation problem #297 exists to solve is at signup,
before anyone pays; the capacity table above only closes because the managed key
serves the trial/FREE slice; and a paying account already has a working path (a
free key takes about a minute, and Hero AI Image is unlocked for them). Widening
the exception to every paying account without a key would put the entire customer
base on one Pexels quota. Revisit only with fresh capacity evidence.

**Spend rules on the managed key** (BYOK jobs are untouched by all of these):

- **Pixabay-first.** Pixabay is asked first; Pexels is asked only when Pixabay
  returned fewer than 3 candidates for that query. Pixabay is the abundant quota,
  Pexels the scarce one.
- **24h search cache.** `StockSearchCache` stores successful search responses,
  keyed by provider plus a normalized query + `perPage` + `minDuration` + page.
  Pixabay's terms *require* 24h caching; Pexels permits it. **Error responses are
  never cached** — one bad minute must not poison a day of searches. A cache hit
  costs neither budget nor a token, which is where the expected 30–50% call
  reduction comes from.
- **Per-job caps.** At most 2 alternative queries per keyword (3 query attempts
  total), no page-2 probe, and at most 40 provider queries per job.
- **Token buckets.** Pexels 150/h and Pixabay 80/min by default — deliberately
  below each published ceiling so we throttle ourselves before the provider does.
  Overridable via `MANAGED_STOCK_PEXELS_PER_HOUR` / `MANAGED_STOCK_PIXABAY_PER_MIN`.
  In-process is sufficient: production is a single VPS running one PM2 app.
- **AutoMix photo fallbacks stay BYOK.** `pexels-photo` / `pixabay-photo` require
  the caller's own key. The managed quota is budgeted for video search.

**Fail-closed rules.** Exhausting a token bucket or the per-job budget **skips
that provider**; it never fails the job. The job degrades to the key-free photo
providers (Wikimedia/NASA/Met) plus AI images under the existing AutoMix logic,
exactly as a job with one dead provider does today. A throwing provider call
consumes its token (the request was made) and writes nothing to the cache.
Telemetry: `managed_stock_used` and `managed_stock_throttled`, both carrying
`{ provider, queriesUsed, cacheHits }`.

**Provider terms.** One key per provider, held only in the server environment —
never in the database, the repository, a URL, the browser, or a log line. No key
rotation and no key pooling: rotating keys to dodge a rate limit is exactly what
the limits exist to prevent, and it is how a key gets revoked. Attribution
requirements for both providers are unchanged and continue to be met by the
existing UI. Pixabay's 24h result-caching requirement is satisfied by
`StockSearchCache`. Ask Pexels for a raised quota by email before relying on
headroom we do not have — they grant increases on a described use case.

**UX.** With the flag on, the day-one `KeyOnboardingWizard` no longer auto-opens
(it stays reachable from Settings and from the checklist's "ตั้งค่า" button), and
Pexels/Pixabay are labelled "ไม่บังคับ" rather than "จำเป็น" in the wizard, the
setup checklist, and the model explainer. The ask moves to **after the first
completed export**: Step 2's B-roll card then shows one line —
"คลังสต็อก: ใช้ของระบบ · ใส่ key ของคุณเองเพื่อเลือกภาพได้มากขึ้น (ฟรี, 1 นาที)" —
linking to `/settings?tab=api-keys`. That hint is server-computed from the
existing First-Clip Path decision (`has_completed_video`), so it cannot appear on
day one.

## Consequences

A trial or FREE account can now reach a second, third, and tenth export with zero
setup, which is the activation gap the audit measured. The cost is a shared
quota the team now operates and must watch: `managed_stock_throttled` firing at
all means the trial/FREE slice has outgrown the buckets, and Pexels' monthly cap
is the first ceiling that will bind. Managed jobs also get slightly narrower
search coverage than BYOK jobs by design (fewer alternates, no page 2, Pexels
only on thin results) — an intentional quality-for-availability trade that gives
customers a concrete reason to add their own key.

Rollback is `MANAGED_STOCK` off (unset the variable and
`pm2 restart ai-content --update-env`). With the flag off, eligibility resolves
to `flag_off` with no database work, both provider keys resolve to the user's
own, and every managed branch is dead code. `StockSearchCache` is additive and
survives a rollback harmlessly.
