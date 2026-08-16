# Pexels/Pixabay managed server-key policy and implementation audit

Date checked: 2026-07-20 (Asia/Bangkok)  
Scope: official Pexels and Pixabay documentation/terms plus a read-only inspection of the current Hero AI repository. This is a product/engineering risk assessment, not legal advice.

## Executive decision

### Can Hero AI replace per-user Pexels/Pixabay keys with company server keys?

**Yes, probably, and it is the better user experience — but launch it only after provider confirmation and the compliance work below.** Both providers publicly invite developers to build apps, and their guidance expressly contemplates search results being shown to an app's users. Neither provider says every downstream SaaS user must bring a separate key. The safest design is therefore one company-owned credential per provider, held only on Hero AI's backend, with users receiving results/assets rather than the credential itself.

That conclusion is partly an **inference**: neither provider's public terms contain a sentence that explicitly grants one key unlimited multi-tenant use. Before production rollout, send each provider the actual workflow, expected volume, caching design, storage design, and attribution UI and obtain written confirmation.

### Can Hero AI create 3–5 accounts/keys and rotate them for more quota?

**No. Do not build quota-driven key rotation.**

- **Pexels — expressly prohibited:** its API documentation calls attempts to work around the rate limit API abuse and says this will terminate API access. Pexels also states that one account receives one unique API key. Creating several accounts to multiply the allowance would be a rate-limit workaround even though the public docs do not separately say “one person may have only one account.” Sources: [Pexels API guidelines](https://www.pexels.com/api/documentation/), [getting a Pexels API key](https://help.pexels.com/hc/en-us/articles/900004904026-How-do-I-get-an-API-key), [Pexels Terms §§8–9](https://www.pexels.com/terms-of-service/).
- **Pixabay — not stated in those exact words, but high-confidence prohibited inference:** Pixabay says quotas are associated with the API key, offers an official increase path, and its Terms prohibit bypassing measures that enforce limitations on use. A pool whose purpose is to turn 100 requests/60 seconds into 300–500 is functionally a bypass. Sources: [Pixabay API rate-limit documentation](https://pixabay.com/api/docs/), [Pixabay Terms §§8–9](https://pixabay.com/service/terms/).
- Multiple credentials are acceptable only if the provider approves them in writing for a non-quota purpose such as separate production/staging applications or replacing a compromised key. Pexels says key replacement/cancellation must be requested from `info@pexels.com`; this is operational rotation, not throughput pooling. Source: [changing a Pexels API key](https://help.pexels.com/hc/en-us/articles/47739416247833-How-do-I-change-my-API-key).

### Recommendation

Proceed toward managed keys, but as a gated rollout:

1. do **not** create a rotating multi-account pool;
2. add provider-response caching, centralized quota control, and complete attribution metadata/UI;
3. update the deprecated Pexels video endpoint;
4. request Pexels unlimited access and Pixabay production approval/higher limits in writing;
5. retain BYOK only as an optional fallback until the managed path is approved and stable.

## Policy matrix

| Question | Pexels | Pixabay | Product conclusion |
|---|---|---|---|
| One backend key for a multi-user app | App/website integrations and user selection flows are explicitly supported; no per-end-user-key rule is published | “Create your own app” and show users the source of search results; no per-end-user-key rule is published | Reasonably supported, but confirm the exact multi-tenant SaaS workflow in writing |
| 3–5 keys rotated to multiply quota | Explicitly an abusive rate-limit workaround; API access may be terminated | No exact “key rotation” sentence found; anti-bypass clause and official increase path make it high risk and contrary to the documented model | Do not implement |
| Default quota | 200/hour and 20,000/month | 100/60 seconds, associated with key rather than IP | One shared key means one shared provider bucket for all Hero AI users |
| Higher quota | Eligible apps may receive unlimited requests free after review | Pixabay may increase the limit after proper implementation; no public guaranteed tier | Apply through official channels, not extra accounts |
| API response cache | About 24 hours recommended | 24 hours required | A shared normalized-query cache is a launch requirement |
| Attribution in API UX | Prominent Pexels link; photographer credit when possible; both required for unlimited review | Show users where displayed API search results came from | Provider badge alone is insufficient for Pexels unlimited review |
| Selected asset storage | General license permits download/use/adaptation; avoid systematic mirroring | Used images must be downloaded; videos may be embedded but server storage is recommended | Download only selected assets; do not mirror either catalog |

## Official findings: Pexels

### App integration, account, and credential expectations

- Pexels says the API integrates media into an app or website. Its user-selection guidance permits an app whose primary purpose is different to let users choose a background/header/wallpaper. Public documentation does not require a separate key for every downstream app user. Sources: [Pexels API introduction](https://www.pexels.com/api/documentation/), [permitted app feature example](https://help.pexels.com/hc/en-us/articles/4405588861721-Can-I-use-the-API-as-a-wallpaper-app).
- Each Pexels user account is assigned one API key, described as unique to that account/user. All requests send it directly in the `Authorization` header. Sources: [getting a key](https://help.pexels.com/hc/en-us/articles/900004904026-How-do-I-get-an-API-key), [API authorization](https://www.pexels.com/api/documentation/).
- The Terms make the account owner responsible for activity and prohibit allowing another party to access the Service with the account's username, password, or other security code. Pexels does not publicly classify the API key as a secret in those exact words. **Conservative inference:** the platform may use its key on users' behalf, but must never disclose it to users, browsers, mobile clients, logs, analytics, or error payloads. Source: [Pexels Terms §8](https://www.pexels.com/terms-of-service/).

### Limits, increases, and enforcement

- Default limits are `200 requests/hour` and `20,000 requests/month`. Successful responses include `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, and `X-Ratelimit-Reset`; a `429` means the allocation was exceeded. Source: [Pexels API guidelines and request statistics](https://www.pexels.com/api/documentation/).
- Pexels explicitly says abuse includes attempting to work around the rate limit and that this leads to API-access termination. Its general Terms separately prohibit bypassing measures that enforce use/access limitations. Sources: [Pexels API guidelines](https://www.pexels.com/api/documentation/), [Pexels Terms §8](https://www.pexels.com/terms-of-service/).
- Eligible applications can have limits removed for free. Pexels asks for (1) a platform/use summary, (2) proof/demo/screenshots of Pexels and contributor attribution, and (3) the API key or registered email, sent to `api@pexels.com`. The product must add value instead of reproducing a free-stock/wallpaper service. Source: [Pexels unlimited-request requirements](https://help.pexels.com/hc/en-us/articles/900005852323-How-do-I-get-unlimited-requests).
- Pexels keys cannot be changed by the account owner through self-service; replacement/cancellation is requested through `info@pexels.com`. Source: [Pexels key-change process](https://help.pexels.com/hc/en-us/articles/47739416247833-How-do-I-change-my-API-key).
- Terms violations can lead to suspension, account deletion, permanent ban, and immediate loss of access. Source: [Pexels Terms §9](https://www.pexels.com/terms-of-service/).

### Attribution, caching, storage, and use

- The general content license does not require credit for an ordinary creative use, but the **API guidelines** say to show a prominent link to Pexels whenever making an API-powered experience and credit the photographer when possible. Attribution to Pexels and contributors is mandatory for unlimited-request approval. Sources: [Pexels API guidelines](https://www.pexels.com/api/documentation/), [API attribution guide](https://help.pexels.com/hc/en-us/articles/900005851903-How-should-I-give-credit-Can-I-use-your-logo), [unlimited-request requirements](https://help.pexels.com/hc/en-us/articles/900005852323-How-do-I-get-unlimited-requests).
- When users select their own media, attribution can be in the search flow instead of the final output. Automatically served, unaltered media needs attribution in the display. Source: [Pexels app/attribution example](https://help.pexels.com/hc/en-us/articles/4405588861721-Can-I-use-the-API-as-a-wallpaper-app).
- Pexels recommends normalizing equivalent searches, requesting as many needed results as possible (maximum 80 per page), and caching API responses for about 24 hours. Pexels itself caches a response for 24 hours, but a repeated request still consumes quota. Sources: [rate-limit optimization](https://help.pexels.com/hc/en-us/articles/900006470063-What-steps-can-I-take-to-avoid-hitting-the-rate-limit), [provider cache behavior](https://help.pexels.com/hc/en-us/articles/900005538826-Why-do-I-get-the-same-content-from-multiple-requests).
- Pexels content may be downloaded, used, copied, modified, and adapted for commercial or non-commercial purposes. Standalone distribution, stock-service replication, and bulk/systematic copying are prohibited. Combining media with audio, text, other footage, backgrounds, and editing into a new creative work is expressly distinguished from Standalone use. A finished Hero AI video likely fits this “new creative work” example; this is an inference dependent on the actual output. Source: [Pexels Terms §§5 and 8](https://www.pexels.com/terms-of-service/).
- Pexels does not publish a permanent-hotlink SLA. It says returned content URLs should remain stable “over the short term” while recommending response caching. Store assets selected into real projects; do not prefetch or mirror the library. Source: [Pexels cache guidance](https://help.pexels.com/hc/en-us/articles/900006470063-What-steps-can-I-take-to-avoid-hitting-the-rate-limit).
- Current API documentation says video endpoints under `https://api.pexels.com/videos/` will be deprecated and clients should use `https://api.pexels.com/v1/videos/`. Source: [Pexels API introduction](https://www.pexels.com/api/documentation/).

## Official findings: Pixabay

### App integration, account, and credential expectations

- Pixabay markets the API as a way to “create your own app,” and its API docs require apps to show their users where displayed search results came from. This supports a multi-user app integration; the docs do not require one key per downstream user. Sources: [Pixabay Developer API](https://pixabay.com/service/about/api/), [Pixabay API documentation](https://pixabay.com/api/docs/).
- Authentication is a required `key` query parameter. The account owner is responsible for account activity and may not allow another party to use the Service with the account's username, password, or other security code. **Conservative inference:** call Pixabay only from the backend and ensure query-string credentials never appear in client-visible URLs, logs, traces, analytics, exceptions, or cache identifiers. Sources: [Pixabay API documentation](https://pixabay.com/api/docs/), [Pixabay Terms §8](https://pixabay.com/service/terms/).

### Limits, increases, and enforcement

- The default rate limit is `100 requests per 60 seconds`, associated with the **API key rather than IP address**. Headers expose the limit, remaining calls, and seconds until reset; excess returns `429`. No default monthly cap is stated in the API documentation. Source: [Pixabay API rate-limit documentation](https://pixabay.com/api/docs/).
- Pixabay's marketing page says “Unlimited requests,” while the operational API documentation says the default is 100/60 seconds. Treat the specific API documentation as the enforceable operating limit unless Pixabay approves otherwise in writing. Sources: [Pixabay Developer API marketing page](https://pixabay.com/service/about/api/), [Pixabay API rate-limit documentation](https://pixabay.com/api/docs/).
- Pixabay says it can increase the limit after the API has been implemented properly and invites developers to contact it; no public guaranteed tier, approval SLA, or fixed higher limit is stated. Sources: [Pixabay API documentation](https://pixabay.com/api/docs/), [Pixabay Developer API](https://pixabay.com/service/about/api/), [Pixabay contact page](https://pixabay.com/service/about/).
- The Terms prohibit bypassing measures that enforce limitations. They allow suspension, termination/deletion, and permanent bans when Pixabay determines the Terms were violated. Sources: [Pixabay Terms §§8–9](https://pixabay.com/service/terms/).
- No official public page reviewed on 2026-07-20 expressly says “one person/company may have only one Pixabay account” or “key rotation is prohibited.” The recommendation not to rotate is therefore an inference from the anti-bypass clause, key-based quota, and official increase process — not a fabricated direct quotation.

### Attribution, caching, storage, and use

- Pixabay says API requests/responses **must be cached for 24 hours**. It also says the API is for real human requests, not large volumes of automated queries, and prohibits systematic mass downloads. A user clicking “generate” is human-initiated, but Hero AI's fan-out into many scene searches is automated; production approval should describe this behavior explicitly. Source: [Pixabay API rate-limit documentation](https://pixabay.com/api/docs/).
- Image URLs may be hotlinked temporarily to display search results. Images actually used must be downloaded to the application's server; permanent image hotlinking is not allowed. Videos may be embedded, though server storage is recommended. Full-resolution/original image URLs require full API approval. Source: [Pixabay API hotlinking and image-response documentation](https://pixabay.com/api/docs/).
- API search-result displays should show users where the images/videos came from. Separately, the content license says credit in the final creative use is not required, though appreciated. Sources: [Pixabay API documentation](https://pixabay.com/api/docs/), [Pixabay Terms §6](https://pixabay.com/service/terms/).
- Commercial use is licensed, subject to restrictions. Standalone distribution, systematic copying, competing stock services, control bypass, and unauthorized automatic extraction are prohibited. Combining stock with other images/video/audio/text/backgrounds/editing into a new work is expressly distinguished from Standalone use. A narrated, subtitled, edited Hero AI video likely fits the new-work example; this is an inference. Source: [Pixabay Terms §§5 and 8](https://pixabay.com/service/terms/).

## Commercial SaaS caveats for both providers

- Neither provider promises that every asset is cleared of all third-party trademark, privacy, publicity, design, property, or other rights. Both place responsibility on the user to decide whether additional consent/license is needed, especially for commercial use. Sources: [Pexels Terms §5](https://www.pexels.com/terms-of-service/), [Pixabay Terms §5](https://pixabay.com/service/terms/).
- Do not imply endorsement by a recognizable person, brand, or organization. Do not permit prohibited, misleading, defamatory, immoral/illegal, or other restricted contextual uses. Product terms and the editor should make the customer responsible for reviewing the selected B-roll before publishing.
- The stock providers' free API availability is not an SLA. Managed stock should be a degradable feature: cache safely, fail over between independent providers within each provider's rules, and allow upload/AI alternatives rather than letting provider revocation stop the whole video workflow.

## Current Hero AI repository audit

Snapshot inspected: working tree on 2026-07-20. No application code was changed for this report.

### What is already good

- The current design is BYOK: `prisma/schema.prisma:27-28` stores per-user Pexels/Pixabay keys, and `src/app/api/videos/fetch-stock/route.ts:1010-1065` resolves the signed-in user's keys server-side.
- Provider search calls occur on the server. Pexels uses the `Authorization` header; Pixabay's key remains in the outbound server query string (`src/lib/broll-asset-lib.ts:155-170,236-248`).
- Selected assets are downloaded to Hero AI storage and normalized before rendering (`src/lib/broll-asset-lib.ts:191-230`; `src/app/api/videos/fetch-stock/route.ts:2322-2384`). This aligns with Pixabay's selected-image rule and video-storage recommendation.
- Downloaded stock clips have an asset-level file cache (`src/app/api/videos/fetch-stock/route.ts:2335-2355`; `src/app/api/videos/broll-window/select/route.ts:110-133`). Photo fallbacks preserve source/creator metadata (`src/app/api/videos/fetch-stock/route.ts:509-564`).
- BYOK values support AES-256-GCM at rest when `KEY_ENC_SECRET` is configured (`src/lib/key-crypto.ts`). A managed credential should use a deployment secret rather than a user database field.

### Launch blockers/gaps for managed keys

1. **P0 — Pixabay's mandatory 24-hour API response cache is absent.** `searchPexels` and `searchPixabay` call the providers directly on every search. The existing file cache prevents re-downloading a selected clip but does not cache API request/response results, so it does not satisfy Pixabay's rule. Hero AI also makes key-preflight searches with a random nonce and `cache: "no-store"` (`src/lib/key-preflight.ts:118-145`); the Pixabay preflight is directly at odds with 24-hour response caching when run repeatedly.
2. **P0 — Do not add a key pool/rotation selector.** It would be an explicit Pexels violation and a high-confidence Pixabay anti-bypass violation.
3. **P1 — Pexels video calls use the deprecated path.** `src/lib/broll-asset-lib.ts:168` and `src/lib/key-preflight.ts:124` call `https://api.pexels.com/videos/search`; current Pexels docs direct clients to `/v1/videos/`.
4. **P1 — Attribution is incomplete for Pexels approval.** Search cards and B-roll previews show a provider name/badge (`BrollWindowInspector.tsx:350-366`; `OrderPanel.tsx:432-444`) but do not provide a prominent Pexels link or contributor link. Pexels requires both Pexels and contributor attribution for unlimited access.
5. **P1 — Video attribution metadata is dropped.** The `PexelsVideo` type retains the asset page URL but not contributor details; the normalized `PixabayVideo` type drops the API's `pageURL`, `user`, and profile data (`src/lib/broll-asset-lib.ts:136-172,233-268`). The final result generally carries `provider` but not the contributor/source page. The UI cannot render complete credits until this metadata is preserved end-to-end.
6. **P0 — Authenticated stock-search volume is not hard-capped at the provider boundary.** `fetch-stock` checks that `keywords` is non-empty but does not cap the number of keywords or alternatives supplied to the route (`src/app/api/videos/fetch-stock/route.ts:960-1008`); the per-window search route likewise has no search-rate limiter (`src/app/api/videos/broll-window/search/route.ts:56-83`). The separate select/download route has a per-user limiter, but that activates only after search. Under a managed key, one signed-in client could therefore consume the shared quota directly unless the provider gateway enforces per-request and per-user budgets.
7. **P1 — No shared-key quota coordinator is visible.** Stock search concurrency defaults to eight, keyword alternatives are tried independently, and both providers can be queried concurrently (`src/app/api/videos/fetch-stock/route.ts:92,1628-1653,1771-1849`). There is bounded retry behavior, but no global token bucket, request coalescing, or collection/persistence of provider quota headers. The existing `searchQueries` telemetry counts a logical query once even when both providers are called and does not include retry attempts, so it is not an authoritative provider-call counter. A shared key can therefore be exhausted by simultaneous tenants without reliable remaining/reset visibility.
8. **P2 — Per-job key preflight is unnecessary for stable managed keys.** It costs quota and deliberately bypasses cache. Validate a managed key in an admin/health workflow, not before every user job; use provider 401/403 handling and circuit-breaker health at runtime.

## Capacity implication

Let `P` and `X` be the numbers of uncached Pexels and Pixabay API calls made per generated video after caching/coalescing.

- Pexels default ceiling is approximately `min(200 / P videos/hour, 20,000 / P videos/month)`. At 10 Pexels calls per video, that is only about **20 videos/hour and 2,000 videos/month**, before editor searches, preflight, retries, and photo fallback.
- Pixabay's default burst ceiling is approximately `100 / X videos per 60 seconds`. At 10 calls per video, that is about **10 videos/minute**. There is no documented monthly default, but anti-automation and mass-download clauses still apply.
- Current code may try several query alternatives per keyword and a Pexels page-2 fallback. A video with many B-roll windows can therefore consume materially more than one request per video. Exact production capacity must be based on recorded `provider + endpoint + cache-hit/miss + status + remaining/reset` metrics, not only generated-video counts.
- A single search can return up to 80 Pexels results or 200 Pixabay results. Reuse a candidate pool across related scenes instead of issuing one search per candidate. Sources: [Pexels pagination](https://www.pexels.com/api/documentation/), [Pixabay pagination](https://pixabay.com/api/docs/).

## Recommended production architecture

### Credential model

1. One company-owned production account/key per provider, backend-only.
2. Store managed keys in deployment secrets (`PEXELS_SERVER_KEY`, `PIXABAY_SERVER_KEY` or equivalent), never in client JavaScript, public environment variables, DB responses, outbound error bodies, URLs returned to clients, logs, traces, analytics, or cache keys.
3. Never select a key because another key is low on quota. Provider-approved security replacement is the only rotation path.
4. Keep a feature-flagged BYOK fallback during migration, but do not silently mix user and server quota. Make the chosen credential mode observable internally.

### Provider gateway

Put all stock API calls behind one server module that provides:

- normalized canonical cache keys over provider, endpoint, locale/query, filters, page, and page size;
- shared 24-hour successful-response cache and single-flight request coalescing across tenants;
- centralized token buckets aligned with each provider's documented limits;
- quota-header capture, 429 handling, bounded retry/backoff, circuit breaking, and alerting;
- per-user/per-plan fair-use budgets so one tenant cannot consume the shared allowance;
- a hard maximum of stock searches per generation and reuse of up to 80/200 returned candidates;
- selected-asset download/storage without bulk prefetch or catalog mirroring.

For Pixabay, remove nonce/no-store job preflight. For Pexels, update both search and health checks to `/v1/videos/`. Do not cache raw credentials or include them in cache identifiers; if BYOK remains, segregate cache authorization safely using a non-reversible key fingerprint or an explicitly reviewed shared-public-result cache design.

### Attribution and records

Preserve for every candidate and selected asset:

- provider and provider asset ID;
- asset/source page URL;
- contributor name and contributor profile URL;
- original download URL and selected rendition;
- license name/version or terms snapshot date;
- search query and selection timestamp.

Add a visible linked “Media sources / Credits” surface in the search results/editor/project details. For Pexels, link to Pexels prominently and credit/link the contributor when possible; make the attribution demo good enough to submit with the unlimited-request application. For Pixabay, visibly identify Pixabay on every API search-results surface. Final rendered credits are optional under the general licenses but may be a useful product choice.

## Provider-approval checklist

### Pexels (`api@pexels.com`)

Send:

- a short Hero AI product summary and confirmation that Pexels is a B-roll feature, not the main stock-library experience;
- screenshots/video of linked Pexels and contributor credits;
- the company API key or registered email;
- expected daily/monthly users, generations, searches per generation, and peak request rate;
- 24-hour cache, selected-asset storage, rate limiting, and no-key-rotation design;
- a direct request for confirmation that one server-held production key may serve authenticated Hero AI tenants and for unlimited access.

### Pixabay (official API contact / `info@pixabay.com`)

Send the same traffic/workflow details, plus:

- explain that searches are human-initiated by “generate/edit” actions but fan out across B-roll scenes;
- show the 24-hour API response cache and temporary-only thumbnail hotlinking;
- state that selected images/videos are downloaded to Hero AI storage;
- request written confirmation for one server-held multi-tenant key and the needed production rate limit/full API access.

## Final go/no-go

- **One managed server key per provider:** **GO after remediation and written provider confirmation.**
- **Three to five accounts/keys rotated to expand quota:** **NO-GO.**
- **Immediate switch on current code:** **NO-GO** because Pixabay response caching, Pexels endpoint migration, attribution, and shared-quota coordination are not yet production-ready.
- **Lowest-risk rollout:** implement/cache/credit first, obtain approvals, enable managed mode for a small cohort with strict per-user budgets, then expand while retaining BYOK or upload/AI fallback.
