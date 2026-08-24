# OpenRouter "Luna" / "Terra" Candidate Models — Research Report

**Date:** 2026-07-31
**Scope:** Identify what the founder meant by "5.6 luna" (free tier) and "5.6 terra" (paid tier) on OpenRouter's discounted-models collection, and gather primary-source facts for a potential switch away from direct Gemini API calls in the Hero Script feature.

## Executive summary

There is no model literally named "luna" or "terra" alone — they are tier names inside **OpenAI's own `GPT-5.6` model family**, which OpenAI launched July 9, 2026 with three tiers: **Sol** (flagship), **Terra** (balanced/mid), and **Luna** (fast/cheap). On OpenRouter these appear as `openai/gpt-5.6-luna`, `openai/gpt-5.6-luna-pro`, `openai/gpt-5.6-terra`, and `openai/gpt-5.6-terra-pro`, all listed on the [discounted-models collection](https://openrouter.ai/collections/discounted-models) at "50% off." **Neither model has a genuine free `:free` variant** — OpenRouter's own models API confirms `openai/gpt-5.6-luna:free` does not exist in the model list ([openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models)). The founder's "free tier" framing for Luna is most likely a misreading of Luna simply being the *cheapest* paid tier (currently $0.10/$0.60 per 1M tokens on OpenRouter), not an actual no-cost model. Critically, the "50% off" on OpenRouter is a discount *on top of* OpenAI's own official API price, which OpenAI itself already cut by 80% (Luna) and 20% (Terra) on **July 30, 2026** — one day before this research — per [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing). Both the OpenAI price cut and the OpenRouter discount are very recent and unexplained as to duration, which matters a great deal for a paid product's core-feature dependency (see §6).

---

## 1. What exactly are "luna" and "terra"

Both are real OpenRouter model IDs, confirmed via the live models API ([openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models)):

| Field | `openai/gpt-5.6-luna` | `openai/gpt-5.6-luna-pro` | `openai/gpt-5.6-terra` | `openai/gpt-5.6-terra-pro` |
|---|---|---|---|---|
| Vendor | OpenAI | OpenAI | OpenAI | OpenAI |
| Family / version | GPT-5.6 series | GPT-5.6 series (Luna, `reasoning.mode=pro`) | GPT-5.6 series | GPT-5.6 series (Terra, `reasoning.mode=pro`) |
| Context window | 1,050,000 tokens | 1,050,000 tokens | 1,050,000 tokens | 1,050,000 tokens |
| Max output tokens | 128,000 | 128,000 | 128,000 | 128,000 |
| Input modalities | text, image, file | text, image, file | text, image, file | text, image, file |
| Output modality | text | text | text | text |
| Knowledge cutoff | Feb 2026 | Feb 2026 | Feb 2026 | Feb 2026 |
| Release date | Jul 9, 2026 | Jul 9, 2026 | Jul 9, 2026 | Jul 9, 2026 |

Sources: [openrouter.ai/openai/gpt-5.6-luna](https://openrouter.ai/openai/gpt-5.6-luna), [openrouter.ai/openai/gpt-5.6-terra](https://openrouter.ai/openai/gpt-5.6-terra), [openrouter.ai/openai/gpt-5.6-luna-pro](https://openrouter.ai/openai/gpt-5.6-luna-pro), [openrouter.ai/openai/gpt-5.6-terra-pro](https://openrouter.ai/openai/gpt-5.6-terra-pro), [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models).

Per OpenRouter's own model-page descriptions:
- Luna: "a fast, cost-efficient model in OpenAI's GPT-5.6 series...suited for high-volume, latency-sensitive tasks such as chat, classification, and lightweight agentic workflows" — [openrouter.ai/openai/gpt-5.6-luna](https://openrouter.ai/openai/gpt-5.6-luna).
- Terra: "a balanced model in OpenAI's GPT-5.6 series, positioned between the flagship Sol tier and the cost-efficient Luna tier...suited for everyday coding, reasoning, and agentic tasks" — [openrouter.ai/openai/gpt-5.6-terra](https://openrouter.ai/openai/gpt-5.6-terra).
- The `-pro` suffix variants are "the same underlying model," served with `reasoning.mode` set to `pro` for higher-quality responses — [openrouter.ai/openai/gpt-5.6-luna-pro](https://openrouter.ai/openai/gpt-5.6-luna-pro), [openrouter.ai/openai/gpt-5.6-terra-pro](https://openrouter.ai/openai/gpt-5.6-terra-pro).

**No free variant exists.** OpenRouter's live models API was checked explicitly for `openai/gpt-5.6-luna:free`; it is not present among any model IDs containing "5.6" (`openai/gpt-5.6-luna`, `-luna-pro`, `-terra`, `-terra-pro`, `-sol`, `-sol-pro` are the only six) — [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models). If the founder is picturing a $0 tier, that does not exist for this family on OpenRouter today.

---

## 2. Pricing, discount mechanics, and free-variant status

### OpenRouter prices (as fetched today, "50% off" label applied)

| Model | Input $/1M | Output $/1M | Cache read $/1M | Cache write $/1M |
|---|---|---|---|---|
| `openai/gpt-5.6-luna` | $0.10 | $0.60 | $0.01 | $0.125 |
| `openai/gpt-5.6-luna-pro` | $0.10 | $0.60 | $0.01 | $0.125 |
| `openai/gpt-5.6-terra` | $1.00 | $6.00 | $0.10 | $1.25 |
| `openai/gpt-5.6-terra-pro` | $1.00 | $6.00 | $0.10 | $1.25 |

Source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models) `pricing` object per model ID; cross-confirmed on the OpenAI provider page listing all four with the same figures and an explicit "(50% off)" tag next to Luna/Luna Pro/Terra/Terra Pro — [openrouter.ai/openai](https://openrouter.ai/openai). Sol/Sol Pro are listed at $5/$30 per 1M with **no discount tag**, i.e. equal to OpenAI's own official list price (see below) — [openrouter.ai/openai](https://openrouter.ai/openai).

### OpenAI's own (direct API) current official price — the baseline the OpenRouter discount is measured against

| Model | Input $/1M (short ctx) | Output $/1M (short ctx) | Cached input $/1M | Input/output $/1M (long ctx, >200k prompt) |
|---|---|---|---|---|
| GPT-5.6 Sol | $5.00 | $30.00 | $0.50 | $10.00 / $45.00 |
| GPT-5.6 Terra | $2.00 | $12.00 | $0.20 | $4.00 / $18.00 |
| GPT-5.6 Luna | $0.20 | $1.20 | $0.02 | $0.40 / $1.80 |

Source: [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing), cross-confirmed on the individual model docs pages [developers.openai.com/api/docs/models/gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [developers.openai.com/api/docs/models/gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) (context window 1,050,000; max output 128,000; input modalities text+image; output text-only; knowledge cutoff Feb 16, 2026).

**Key finding: OpenRouter's "50% off" Luna/Terra prices are exactly 50% of OpenAI's own current direct-API price**, not an OpenRouter-specific markdown independent of the vendor. ($0.10 vs $0.20 input, $0.60 vs $1.20 output for Luna; $1.00 vs $2.00 input, $6.00 vs $12.00 output for Terra — arithmetic from the two tables above.) Sol shows no discount and matches OpenAI's list price exactly, which supports that the "50%" figure is a genuine promotional rate specific to Terra/Luna rather than a routing/rounding artifact.

### Is the discount time-limited or an inherent stable price?

The [discounted-models collection page](https://openrouter.ai/collections/discounted-models) states only: "AI models whose cheapest available provider currently offers a promotional discount... Provider discounts and promotional pricing can change, so this collection may update as offers change." No expiration date, no "limited time" language, and no visible pre-discount/strikethrough price is shown anywhere on the collection or individual model pages as fetched today — [openrouter.ai/collections/discounted-models](https://openrouter.ai/collections/discounted-models), [openrouter.ai/openai/gpt-5.6-luna](https://openrouter.ai/openai/gpt-5.6-luna), [openrouter.ai/openai/gpt-5.6-terra](https://openrouter.ai/openai/gpt-5.6-terra). Since the discount is calculated against a very recently changed OpenAI list price and OpenRouter's own copy calls it a "promotional discount" from "the cheapest available provider," it should be treated as **not contractually stable** — see §6.

### Genuinely free `:free` variant

None exists for Luna, Luna Pro, Terra, or Terra Pro — confirmed against the live model list (§1). No rate limits or availability caveats to report for a free variant because there isn't one.

---

## 3. Thai language quality — primary evidence only

**No primary evidence found.** Checked:
- OpenRouter's Luna and Terra model pages — no Thai or language-specific benchmark section present — [openrouter.ai/openai/gpt-5.6-luna](https://openrouter.ai/openai/gpt-5.6-luna), [openrouter.ai/openai/gpt-5.6-terra](https://openrouter.ai/openai/gpt-5.6-terra).
- OpenAI's official GPT-5.6 System Card (vendor's own safety/capability document) — searched explicitly for "Thai" and for any per-language benchmark breakdown; none found. The system card was published July 9, 2026 — [deploymentsafety.openai.com/gpt-5-6](https://deploymentsafety.openai.com/gpt-5-6).
- OpenAI's model docs pages for Luna/Terra list only context window, pricing, modality, and knowledge cutoff — no language-capability claims — [developers.openai.com/api/docs/models/gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [developers.openai.com/api/docs/models/gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

Write this down plainly for the founder: **there is no primary-source claim, benchmark, or vendor statement about Thai-language performance for GPT-5.6 Luna or Terra.** Any Thai-quality assessment would require the team's own empirical testing before committing the Hero Script feature to either model.

---

## 4. Operational facts for a managed SaaS integration

### API shape
OpenRouter's request/response schema is OpenAI-Chat-Completions-compatible: "OpenRouter's request and response schemas are very similar to the OpenAI Chat API, with a few small differences," and responses "comply with the OpenAI Chat API." Endpoint: `POST https://openrouter.ai/api/v1/chat/completions` — [openrouter.ai/docs/api-reference/overview](https://openrouter.ai/docs/api-reference/overview).

### Data / privacy policy
- OpenRouter itself: filtering/data-collection settings "have no bearing on OpenRouter's own policies and what we do with your prompts" (i.e. the docs page describes controlling *provider* behavior, not OpenRouter's own internal handling) — [openrouter.ai/docs/features/privacy-and-logging](https://openrouter.ai/docs/features/privacy-and-logging).
- "Each AI provider on OpenRouter has its own data handling policies for logging and retention" — training and retention practices vary per provider, and users can restrict routing to providers with acceptable policies via account-wide settings, per-request `data_collection` restrictions, or (enterprise) EU in-region routing — [openrouter.ai/docs/features/privacy-and-logging](https://openrouter.ai/docs/features/privacy-and-logging).
- For the upstream vendor specifically (OpenAI direct API, which is what actually serves these GPT-5.6 tiers): "As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in to share data with us)." Default retention for abuse-monitoring logs is "up to 30 days" for most endpoints, with some endpoints (e.g. `/v1/conversations`) retained "until deleted" — [developers.openai.com/api/docs/guides/your-data](https://developers.openai.com/api/docs/guides/your-data).

### Provider routing behavior
"By default, requests are load balanced across the top providers to maximize uptime," meaning the actual serving provider for a given model ID **can change from request to request**; OpenRouter's routing accounts for per-provider price differences, and data-handling policy varies by which provider actually serves the request — users cannot assume consistent data handling across requests unless they explicitly restrict routing (`data_collection: deny` or similar) — [openrouter.ai/docs/features/provider-routing](https://openrouter.ai/docs/features/provider-routing). For GPT-5.6 specifically (a proprietary OpenAI-only model, not open-weight), the OpenAI provider overview page on OpenRouter lists only OpenAI-sourced pricing for Luna/Luna Pro/Terra/Terra Pro with no alternate third-party provider entries shown — [openrouter.ai/openai](https://openrouter.ai/openai) — so in practice this specific model family is less exposed to provider-routing variance than open-weight models on OpenRouter, but the individual model pages' "Providers" section did not render enough detail in this session to enumerate a definitive multi-provider list; this should be re-verified directly in-browser before committing.

### Rate limits
General OpenRouter rate limiting: enforced via two mechanisms — credit limits (account balance / per-key caps) and rate limits (request caps, DDoS protection) — [openrouter.ai/docs/api-reference/limits](https://openrouter.ai/docs/api-reference/limits). For `:free`-suffixed models specifically (not applicable to Luna/Terra since no free variant exists): 20 requests/minute always; 50 requests/day with no prior credit purchase, rising to 1000 requests/day once the account has purchased at least $10 in credits (all-time) — [openrouter.ai/docs/api-reference/limits](https://openrouter.ai/docs/api-reference/limits). No Luna/Terra-specific (non-free) rate limit numbers were surfaced on the model pages during this session.

### BYOK / credits mechanics
OpenRouter is a prepaid-credits system: "OpenRouter uses a credit system where the base currency is US dollars. All of the pricing on our site and API is denoted in dollars." Users top up manually or via auto-top-up; unused credits may be expired "after one year of purchase" per OpenRouter's terms — [openrouter.ai/docs/faq](https://openrouter.ai/docs/faq). When a request is made, OpenRouter receives the token count actually processed by the provider, computes cost, and deducts from the credit balance — [openrouter.ai/docs/faq](https://openrouter.ai/docs/faq).

BYOK (bring-your-own-key) is a separate mode: "The cost of using custom provider keys on OpenRouter is 5% of what the same model/provider would cost normally on OpenRouter and will be deducted from your OpenRouter credits," with that 5% fee "waived for the first 1M BYOK requests per-month." Under BYOK, the underlying provider (e.g. OpenAI) bills the user's own account directly for usage; BYOK spend does not count toward OpenRouter guardrail budgets by default unless "Include BYOK spend" is enabled — [openrouter.ai/docs/use-cases/byok](https://openrouter.ai/docs/use-cases/byok). This is relevant because HERO's current architecture uses a managed server-side key for Hero Script (not BYOK) — the equivalent OpenRouter setup would be prepaid credits, not BYOK.

---

## 5. Cost comparison — typical Hero Script request (~3,000 input tokens + ~1,000 output tokens)

Formula: cost = (input_tokens/1,000,000 × input_price) + (output_tokens/1,000,000 × output_price)

| Model | Input $/1M | Output $/1M | Cost @ 3k in / 1k out |
|---|---|---|---|
| **Gemini 2.5 Flash** (current, fast tier) — standard | $0.30 | $2.50 | (3000×0.30 + 1000×2.50)/1,000,000 = **$0.00340** |
| **Gemini 2.5 Pro** (current, pro tier, "gemini-pro-latest" family, ≤200k prompt band) — standard | $1.25 | $10.00 | (3000×1.25 + 1000×10.00)/1,000,000 = **$0.01375** |
| `openai/gpt-5.6-luna` — OpenRouter discounted price | $0.10 | $0.60 | (3000×0.10 + 1000×0.60)/1,000,000 = **$0.00090** |
| `openai/gpt-5.6-luna` — OpenAI standard (non-discounted) price | $0.20 | $1.20 | (3000×0.20 + 1000×1.20)/1,000,000 = **$0.00180** |
| `openai/gpt-5.6-terra` — OpenRouter discounted price | $1.00 | $6.00 | (3000×1.00 + 1000×6.00)/1,000,000 = **$0.00900** |
| `openai/gpt-5.6-terra` — OpenAI standard (non-discounted) price | $2.00 | $12.00 | (3000×2.00 + 1000×12.00)/1,000,000 = **$0.01800** |

Gemini pricing source: [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) — Gemini 2.5 Flash standard tier $0.30/1M input (text/image/video), $2.50/1M output; Gemini 2.5 Pro standard tier $1.25/1M input and $10.00/1M output for prompts ≤200k tokens (higher $2.50/$15.00 tier applies above 200k tokens, not relevant at ~3k-token Hero Script prompts). GPT-5.6 Luna/Terra pricing sources as in §2.

**Takeaway:** at the discounted OpenRouter rate, Luna is ~3.8x cheaper than Gemini 2.5 Flash and Terra is ~1.5x more expensive than Gemini 2.5 Flash but ~35% cheaper than Gemini 2.5 Pro, for this token mix. At OpenAI's non-discounted standard price, Luna is still ~1.9x cheaper than Gemini 2.5 Flash, and Terra is ~5.3x more expensive than Gemini 2.5 Flash but roughly on par with (slightly above) Gemini 2.5 Pro.

---

## 6. Risks of building on discounted/promotional OpenRouter pricing

Reasoning from the facts gathered in §2 and §4, not from outside speculation:

1. **The discount sits on top of an already-fresh price cut.** OpenAI's own list price for Luna/Terra was cut (per developers.openai.com, currently showing $0.20/$1.20 for Luna and $2.00/$12.00 for Terra) very recently relative to this research date (2026-07-31), and the OpenRouter collection describes its listing as reflecting "the cheapest available provider['s]...promotional discount" that "can change" — [openrouter.ai/collections/discounted-models](https://openrouter.ai/collections/discounted-models). Two independent, recently-set price points stacked on top of each other is a materially less stable foundation than a vendor's long-standing published rate card.
2. **No expiration date or notice-period language was found anywhere in scope.** Neither the OpenRouter collection page, the individual Luna/Terra model pages, nor OpenRouter's public docs pages fetched in this session (FAQ, pricing, privacy) state a promised minimum duration for the current discount, or a contractual notice period before OpenRouter or the upstream provider changes price. The FAQ page explicitly did not address price-change notice when searched — [openrouter.ai/docs/faq](https://openrouter.ai/docs/faq). This should be treated as **no guarantee exists**, not merely "unknown."
3. **Provider-routing variance compounds the risk.** OpenRouter documents that a single model ID can be served by different upstream providers "load balanced...to maximize uptime," each with potentially different pricing and different data-handling policy — [openrouter.ai/docs/features/provider-routing](https://openrouter.ai/docs/features/provider-routing). For a proprietary OpenAI-only model like GPT-5.6, this risk appears smaller in practice (only OpenAI's own listing was found on the provider page — [openrouter.ai/openai](https://openrouter.ai/openai)), but it was not possible to fully enumerate the "Providers" panel on the model pages in this session, so it should not be assumed there is exactly one server-side source.
4. **Free-tier absence removes a fallback.** Since no `:free` Luna/Terra variant exists (§1–2), there is no zero-cost degradation path if pricing or availability changes — unlike models that do have a `:free` tier with its own (also-fragile) rate limits.
5. **Credit-expiration and BYOK-fee mechanics add operational surface area** not present in the current direct-Gemini-API setup: prepaid credits can expire after one year unused, and BYOK usage carries a 5% OpenRouter fee (waived only for the first 1M BYOK requests/month) — [openrouter.ai/docs/faq](https://openrouter.ai/docs/faq), [openrouter.ai/docs/use-cases/byok](https://openrouter.ai/docs/use-cases/byok). Either mode adds a dependency (OpenRouter's own uptime/billing layer) on top of the upstream vendor's, which the current direct-Gemini integration does not have.
6. **Recommendation implied by the evidence, not asserted independently:** if Mew decides to route Hero Script through OpenRouter's Luna/Terra at the discounted price, the safest architecture is to treat the discounted rate as *upside*, budget/estimate at OpenAI's non-discounted standard price (§5's "standard" rows), and keep the current Gemini path as an automatic fallback if OpenRouter pricing or availability changes — since nothing in the primary sources found here promises the current discount will hold.

---

## Sources

- https://openrouter.ai/collections/discounted-models
- https://openrouter.ai/openai/gpt-5.6-luna
- https://openrouter.ai/openai/gpt-5.6-luna-pro
- https://openrouter.ai/openai/gpt-5.6-terra
- https://openrouter.ai/openai/gpt-5.6-terra-pro
- https://openrouter.ai/openai (OpenAI provider overview page on OpenRouter)
- https://openrouter.ai/api/v1/models (live model list / pricing API)
- https://openrouter.ai/docs/api-reference/overview
- https://openrouter.ai/docs/api-reference/limits
- https://openrouter.ai/docs/features/privacy-and-logging
- https://openrouter.ai/docs/features/provider-routing
- https://openrouter.ai/docs/use-cases/byok
- https://openrouter.ai/docs/faq
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/guides/your-data
- https://deploymentsafety.openai.com/gpt-5-6 (OpenAI's official GPT-5.6 System Card)
- https://ai.google.dev/gemini-api/docs/pricing (current baseline: Gemini 2.5 Flash / Gemini 2.5 Pro pricing)
