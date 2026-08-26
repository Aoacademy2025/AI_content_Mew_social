# Managed stock key for any account without its own stock key

Date: 2026-08-26
Status: Accepted, behind `MANAGED_STOCK` (LIVE on production)
Amended: 2026-08-26 — see [Amendment](#amendment-2026-08-26-any-account-without-its-own-stock-key)
at the end of this document. The original title was "Managed stock key for trial
and FREE"; the Context and Decision below are kept verbatim as the record of what
was decided first, and the amendment states what supersedes it.

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
   > **SUPERSEDED 2026-08-26** — rule 5 is now "otherwise eligible", full stop.
   > See the Amendment at the end of this document.

Paid-equivalent accounts (subscription, paid term, bundle, GRANT coupon,
administrator grant) with no stock key **keep today's `missing_key: broll` 400**.
This is deliberate. The activation problem #297 exists to solve is at signup,
before anyone pays; the capacity table above only closes because the managed key
serves the trial/FREE slice; and a paying account already has a working path (a
free key takes about a minute, and Hero AI Image is unlocked for them). Widening
the exception to every paying account without a key would put the entire customer
base on one Pexels quota. Revisit only with fresh capacity evidence.

> **SUPERSEDED 2026-08-26** — the fresh capacity evidence arrived (698 accounts
> already eligible; widening adds ~97, of which 4 are payers, against ~3,289
> queries/week) and this paragraph no longer describes production. Paid-equivalent
> keyless accounts are served. See the Amendment at the end of this document.

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
  > **AMENDED 2026-08-26** — in-process is sufficient for the *hourly* limit only.
  > Pexels' 20,000/month ceiling is now counted in the database
  > (`ManagedStockUsage`, `MANAGED_STOCK_PEXELS_PER_MONTH`, default 18,000).
  > See the Amendment at the end of this document.
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

---

## Amendment (2026-08-26): any account without its own stock key

Status: Accepted. Supersedes rule 5 of the Decision above and the
"Paid-equivalent accounts … keep today's `missing_key: broll` 400" paragraph.
Everything else in this ADR — BYOK wins, suspended fails closed, Pixabay-first,
the 24h cache, the per-job caps, the token buckets, the provider terms — stands
unchanged.

### What changes

The managed stock library stops being trial/FREE-only. One rule now:

> **Nobody needs their own Pexels/Pixabay key to make a clip.**

`decideManagedStockEligibility` keeps `flag_off`, `own_key`, `suspended` and
`no_managed_key` as its denial reasons and drops the plan test entirely. Plan is
no longer an input. FREE, live trial, PRO, BUSINESS, coupon/grant, administrator
grant and bundle accounts all get the same answer: if you did not bring a stock
key, the system searches on its own.

`not_trial_or_free` stays in the `ManagedStockEligibilityReason` union, unused
and never returned, so stored telemetry and any caller that still switches on it
keep type-checking. It must not be reintroduced.

### Why

The original argument was a cost/capacity argument, and both halves were wrong
for this particular dependency.

**Cost.** BYOK exists because Gemini, HeyGen and ElevenLabs bill per call — a
managed key there is a real, uncapped bill (which is why ADR 0003 makes those
exceptions narrow and product-funded). Pexels and Pixabay are **free**. There is
no bill to shift onto the team, so BYOK's cost rationale never applied to stock
search at all. The only constraint is rate limits.

**Capacity.** Measured on 2026-08-26:

| Measure | Value |
| --- | --- |
| FREE accounts already eligible before this change | 698 |
| Accounts the widening adds | ~97 |
| …of which are real payers | 4 |
| Whole-system stock volume | ~3,289 search queries/week |

The paid keyless slice is ~14% more accounts and 4 paying customers — noise
against the existing eligible population, not a second customer base. Against
~3,289 queries/week system-wide, the Pixabay-first rule, the 24h cache, the
per-job caps and the token buckets already absorb it.

Against that, the cost of keeping the gate was a customer who **pays us** hitting
a `missing_key: broll` wall that a FREE account walks straight through. That is
not defensible, and it is not a trade worth 97 accounts of quota headroom.

### The monthly ceiling

Pexels publishes 200 req/h **and 20,000 req/month**. The hourly limit is held by
an in-process token bucket, which refills to full on every `pm2 restart` — it
cannot hold a month-long line. With every keyless account served, the monthly cap
is the ceiling that actually binds, so it is now counted in the database.

- New additive model `ManagedStockUsage { provider, periodKey, count }`, unique
  on `[provider, periodKey]`, where `periodKey` is `YYYY-MM` in **Asia/Bangkok**
  (UTC+7, no DST — the same calendar month the team reads a bill in). Additive
  only, so `prisma db push` is safe; no column is removed or renamed.
- Incremented atomically (`count = count + 1`) once per managed provider call —
  for both providers, because Pixabay's volume is what makes the Pexels number
  readable in `/admin/insights`. A cache hit increments nothing.
- New env `MANAGED_STOCK_PEXELS_PER_MONTH`, default **18,000** — deliberately
  under 20,000 so a restart storm cannot walk us into a hard provider block. The
  upper bound is generous rather than 20,000 so a quota raise granted by Pexels
  is a config change, not a deploy.

**Fail-closed order.** When the month's Pexels budget is spent, we stop calling
Pexels and the job degrades, in this order, to:

1. **Pixabay** (abundant quota, no monthly cap),
2. the existing **key-free photo providers** (Wikimedia / NASA / Met),
3. **AI images** under the existing AutoMix logic.

The job never fails. Telemetry: `managed_stock_throttled` now carries
`{ provider, scope, queriesUsed, cacheHits }` where `scope` is `"rate"` (token
bucket) or `"month"` (this ceiling); events written before this amendment have no
`scope` and are read as `"rate"`.

**Fail-open on the counter.** A counter that cannot be read or written is
*unknown*, not exhausted, and the call is allowed. A database hiccup must never
be able to switch Pexels off for a month, and a failed counter write must never
fail a render. Only a count we actually read that has reached the ceiling stops
the provider.

### BYOK is unchanged for the paid providers

This amendment is about **free** stock APIs only. BYOK stays the product default
for Gemini, HeyGen and ElevenLabs, and the approved managed exceptions there
(OmniVoice audio per ADR 0003, Hero AI Image via the qualified RunPod Z-Image
route) keep their own funding, caps and fail-closed flags. Bringing your own
stock key still wins over the managed one, still gets wider search coverage
(more alternates, page 2, Pexels on every query), and is still what the Step-2
hint asks for after the first completed export — now on every plan, not just
trial/FREE.

### Consequences

Every account can reach every export with zero setup, and the `missing_key:
broll` 400 is gone for keyless accounts on every plan. `KeySetupChecklist`
renders nothing at all for an account that needs no key (managed Gemini plus the
managed library).

What the team must now watch, in `/admin/insights` → Managed Stock:

- **`scope: "month"` throttles are a real incident**, not a warning. They mean
  Pexels is off for the rest of the calendar month and every managed job is
  running on Pixabay plus AI images. React by asking Pexels for a raised quota
  (they grant increases on a described use case) and raising
  `MANAGED_STOCK_PEXELS_PER_MONTH` to match — not by rotating keys.
- **`scope: "rate"` throttles** mean the buckets are too small for current load.
- **Pexels month-to-date %** is the leading indicator; the panel shows it against
  the configured ceiling with the reset date.

`resolveManagedStockAccess` also stopped resolving paid-equivalent entitlement,
which removes a whole entitlement lookup from every `/api/user/me` request — the
decision is now a pure function of the flag, the server env and two booleans.

Rollback is unchanged: `MANAGED_STOCK` off plus
`pm2 restart ai-content --update-env`. `ManagedStockUsage` is additive and
survives a rollback harmlessly, exactly like `StockSearchCache`.
