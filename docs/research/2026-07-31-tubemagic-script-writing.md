# TubeMagic — script writing feature research (primary sources only) — 2026-07-31

## Purpose

TubeMagic (https://tubemagic.com/) is being evaluated by the founder as a reference product for a possible "viral script writing" feature. This document captures only what TubeMagic states about itself, on its own domain (`tubemagic.com`). No third-party reviews, video summaries, or forum threads were used. Every claim below is cited to the exact URL it came from; anything that could not be confirmed on a primary source is marked "Not stated in primary sources found."

Company/product identity note: TubeMagic began as "Morise.AI" (founded by Priyam Raj, 2023), was acquired and rebranded by Matt Par in January 2024, and by mid-2025 the team says it narrowed focus specifically onto the Script Writer as its flagship tool (Source: https://tubemagic.com/about).

---

## 1. Full feature list — script writing / ideation / titles / hooks / descriptions

### AI YouTube Script Writer (flagship tool)

Per the homepage and `/features`, the workflow ("How TubeMagic Works") is described in four steps (Source: https://tubemagic.com/, https://tubemagic.com/features):

1. **Match your style** — "Paste your channel link and we'll automatically match your brand voice and tone." (Source: https://tubemagic.com/)
2. **Choose LLM Models** — pick between "Claude 4.0, GPT-4o and more (coming soon)"; copy states "Claude gives the most natural, human-like flow." (Source: https://tubemagic.com/, https://tubemagic.com/features)
3. **Select Script Length** — "TubeMagic will match your video time to the ideal word count, starting from 20 minutes down to 1 [minute]." The `/features` page gives an explicit table: 100 words ≈ 1 min, 800 words ≈ 5 min, 1,500 words ≈ 10 min, 3,000 words ≈ 20 min. (Source: https://tubemagic.com/, https://tubemagic.com/features)
4. **Add Inspiration Videos** — "Input top-performing videos. We extract the best info and merge it with your training data." (Source: https://tubemagic.com/, https://tubemagic.com/features)

Additional attributes of the script writer, per `/features`:
- **Fully Editable** — "Regenerate, edit, or chat with your script for fine-tuning." (Source: https://tubemagic.com/features)
- **Trained on the Best** — "Default training uses top advice from elite YouTube scriptwriters for hooks, retention, and pacing." (Source: https://tubemagic.com/features)
- Marketing framing: "Generate world-class YouTube scripts that sound like they were written by someone you paid thousands for." (Source: https://tubemagic.com/features)
- The homepage banner states "200K+ Scripts Generated." (Source: https://tubemagic.com/)

**Output**: a complete YouTube script. The tool does not appear to separately label "hooks" as a standalone output — hooks are described as something the model is trained to produce well within the script ("Trained on the Best" bullet above), not a discrete generated artifact.

A blog post (dated content, first-party) adds that the script writer "models its scripts on viral winning videos, using machine learning to help replicate success," and claims it cuts scripting time "from 30-60 minutes down to approximately 5 minutes with minor edits." (Source: https://tubemagic.com/blog/how-to-make-money-on-youtube-without-ads-monetization-program-ai-hack, https://tubemagic.com/blog/get-your-first-1-000-subscribers-on-youtube-with-this-ai-tool)

### Video ideation / research tools (per `/features` and homepage, grouped under "Video Ideas & Research")
- **Video Idea Generator** — "Add your channel link to get endless ideas that match your niche."
- **Keyword Research** — "See search volume, competition & our 'Magic Score' to pick the right topics."
- **Niche Explorer** — "Discover high-RPM niches and viral trends."
- **Top Video Finder** — "Find most-viewed videos on any keyword instantly."
- **Ideas Manager** — "Track, save & organize your content pipeline."
(Source: https://tubemagic.com/features, https://tubemagic.com/)

### Content creation tools
- **AI Thumbnail Generator** — "Instantly create scroll-stopping thumbnails with high CTR."
- **YouTube to Transcript** — "Paste a video link and get a clean transcript with formatting."
- **Article to Script** — "Input any article URL and we'll turn it into a YouTube-ready script."
- **Video to Script** — "Convert any video into a brand-new original script."
(Source: https://tubemagic.com/features)

### Upload & optimization tools
- **Warp Upload Optimizer** — "Input your unlisted video and get: Optimized titles, tags, and descriptions instantly."
- **Title Generator** — "Get 3 viral titles for any video or keyword."
- **Description Generator** — "Auto-generate YouTube descriptions with timestamps."
- **Tag Generator & Organizer** — "Create high-SEO tags and organize/delete them easily."
(Source: https://tubemagic.com/features)

### Bonus tools
- **Channel Name Generator** — "Get creative YouTube name ideas based on your niche or keywords."
- **Chrome Extension** — "Optimize your videos directly on YouTube with our browser extension."
(Source: https://tubemagic.com/features)

### Community posts
Community post creation is listed on the homepage feature summary and mentioned in a blog post as a "Community Posts Writer" that "optimizes posts for maximum engagement." It does not appear as its own tile on the current `/features` page grid, so it may be folded into another tool or deprecated in the current UI. (Source: https://tubemagic.com/, https://tubemagic.com/blog/get-more-views-on-youtube-in-less-time-with-ai)

### Plagiarism / SEO
"We use a combination of AI and human curation to ensure that the content we generate is not only unique, but also high quality. We also have a plagiarism checker built in." (Source: https://tubemagic.com/pricing FAQ, mirrored on https://tubemagic.com/features and https://tubemagic.com/)

---

## 2. Personalization

TubeMagic's stated personalization mechanism is channel-link analysis, not a longer onboarding/training flow:

- **Channel Writing Style**: "Input your YouTube channel to match tone and structure for consistency." (Source: https://tubemagic.com/features)
- Homepage step 1 says the same thing more casually: "Paste your channel link and we'll automatically match your brand voice and tone." (Source: https://tubemagic.com/)
- `/about` describes the current (mid-2025-onward) Script Writer as supporting: "Multiple video inputs for deeper context," "Your choice of the latest LLMs like Claude 4.0 and GPT-4o," and "Personalized tone and structure inspired by top-performing channels." (Source: https://tubemagic.com/about)
- A second personalization input is **Inspiration Videos**: pasting links to top-performing videos (not necessarily the user's own channel) so the tool "extract[s] the best info and merge[s] it with your training data." (Source: https://tubemagic.com/, https://tubemagic.com/features)
- Video Idea Generator and Warp Upload Optimizer also key off a pasted channel/video link rather than an explicit persistent "style profile" object. (Source: https://tubemagic.com/features)

No primary source describes a saved, named "brand voice profile," a tone slider/settings panel, multiple selectable personas, or a distinct onboarding step to teach the AI a creator's style beyond re-pasting a channel/video URL each time. **Not stated in primary sources found**: whether the channel-link analysis is cached/reusable across sessions, or re-run fresh each time; whether style matching is a toggle or always-on.

---

## 3. Pricing & packaging

Per `/pricing` (also mirrored in the FAQ block that repeats verbatim on the homepage and `/features`):

- **Single paid tier: "Premium"** — "One price, to keep things simple." (Source: https://tubemagic.com/pricing)
  - Monthly: **$41/month**
  - Annual: **$497/year** ("billed yearly at $497 per year"), marketed as "Save (20%)" — note: $41 × 12 = $492, so the displayed $497 annual price is slightly *above* a literal 20%-off-of-monthly calculation; this is TubeMagic's own stated figure, not a calculation error introduced here. (Source: https://tubemagic.com/pricing)
- **What Premium includes**, per the plan card:
  - "All tools unlocked"
  - "Upto 100 generations/day per tool"
  - "500 premium credits/month"
  - "Premium models (Claude Opus 4.6)"
  - "Priority support"
  - "Tube AI System Course"
  (Source: https://tubemagic.com/pricing)
- **Credits model** ("How credits work"):
  - **Standard**: "Upto 100 uses/day per tool with Sonnet 4.6 & Gemini Flash — resets every 24h"
  - **Premium credits**: "Unlock Premium models like Claude Opus 4.6 with 500 premium credits across all tools — credits resets monthly"
  - **Top-ups**: "Need more? Top up anytime from the sidebar" (implies purchasable additional credits, no price given on this page)
  (Source: https://tubemagic.com/pricing)
- **Free trial**: "We have disabled free trials for now due to spam." (Source: https://tubemagic.com/pricing)
- **Refund policy**: "30-day money back guarantee" — "if you do not like something and it has not been more than 30 days since your payment, you can send an email at [support email] and get a full refund. No questions asked." (Source: https://tubemagic.com/pricing)
- **Cancellation**: "Of course, if there is any reason you'd like to cancel your subscription, you may do so [at any time]." (Source: https://tubemagic.com/pricing)
- **Payments**: processed via Paddle; "We do not even store any of your payment information." Stripe is referenced only in an FAQ answer about alternate payment methods if Stripe isn't available in the user's country, suggesting Stripe may also be used in some capacity, but Paddle is the only processor named directly as the one used for checkout. (Source: https://tubemagic.com/pricing)
- **Affiliate program**: "50% recurring commissions for life." (Source: https://tubemagic.com/pricing, https://tubemagic.com/affiliates)
- **Language support** (billed as a pricing-page FAQ item, not gated by tier since there's only one tier): "We support over 95 languages for descriptions, titles, tags, community posts and video ideas." Note this list does not explicitly name the **script** itself among the 95-language guarantee — scripts are not listed in that sentence. (Source: https://tubemagic.com/pricing)

**Discrepancy note**: A first-party blog post (undated on the page, but referencing "a free version with core features" and "a pro version offering additional advanced features") describes a two-tier free/pro structure. (Source: https://tubemagic.com/blog/get-your-first-1-000-subscribers-on-youtube-with-this-ai-tool) This does not match the current `/pricing` page, which shows a single paid "Premium" tier with free trials disabled. The blog post appears to reflect an earlier pricing structure that is no longer current; `/pricing` should be treated as the authoritative, current source.

---

## 4. Stickiness mechanics

Primary sources point to a few built-in mechanics that would tend to drive recurring, repeat visits rather than one-off use:

- **Ideas Manager**: "Track, save & organize your content pipeline" — a persistent, revisitable backlog of video ideas rather than a single-use generator. (Source: https://tubemagic.com/features)
- **Daily-reset usage allowance** ("Upto 100 uses/day per tool ... resets every 24h") structurally rewards logging in daily rather than batching all usage in one sitting. (Source: https://tubemagic.com/pricing)
- **Monthly-reset premium credits** (500/month for top-tier models) creates a monthly re-engagement cadence separate from the daily one. (Source: https://tubemagic.com/pricing)
- **Purchasable credit top-ups "from the sidebar"** imply an in-app persistent account/sidebar UI a user returns to, though the detail is thin from the marketing site alone. (Source: https://tubemagic.com/pricing)
- **Chrome Extension** — "Optimize your videos directly on YouTube with our browser extension" ties the tool into the creator's regular YouTube workflow rather than confining use to the TubeMagic web app. (Source: https://tubemagic.com/features)
- **Multi-tool suite spanning the whole publishing pipeline** (idea → script → thumbnail → title/description/tags → community post) is explicitly positioned as end-to-end: "TubeMagic isn't just a Script Writer... We've also got a suite of tools to help you with all aspects of your Youtube Channel," which structurally encourages using the product at multiple points per video rather than once. (Source: https://tubemagic.com/)
- **Affiliate program with 50% recurring commissions for life** is a stickiness mechanic aimed at affiliates/promoters continuing to refer users, rather than at end-user retention per se. (Source: https://tubemagic.com/pricing)

**Not stated in primary sources found**: no content calendar/scheduling feature is named (only the more limited "Ideas Manager"); no explicit "streak," gamification, or notification/reminder system; no team/multi-seat or collaboration features; no mention of a saved history/library of past generated scripts beyond what "Ideas Manager" implies for ideas specifically.

---

## 5. Target audience

- Company mission, stated directly: "We help YouTubers script high-retention videos in seconds using cutting-edge AI." (Source: https://tubemagic.com/about)
- "TubeMagic is an AI-powered script writing tool built to help YouTube creators save time, boost retention, and produce world-class content faster than ever." (Source: https://tubemagic.com/about)
- Founder quote (testimonial section): "I started TubeMagic to help YouTubers focus only on creating content and not worry about optimizing videos. And that's exactly what we do." — Priyam Raj, TubeMagic Founder. (Source: https://tubemagic.com/)
- Homepage testimonials cite a spread of channel sizes: 22,000 subscribers (Debt Busters) up to 1.2M+ subscribers (Randolph), plus Matt Par himself ("12+ Youtube Channels, 1 Billion+ Views"), an "AI Guy" producing "AI-generated historical films," and an agency CEO (Alejandro Jimenez, "CEO YouTubersFactory"). This spans hobbyist/small creators through large, established channels and at least one agency-style user. (Source: https://tubemagic.com/)
- The product is explicitly scoped to **YouTube** throughout (script length is expressed in YouTube video minutes; tools are titled "YouTube Script Writer," "Video Idea Generator," "Warp Upload Optimizer" for YouTube uploads, Chrome extension works "directly on YouTube"). There is no reference anywhere found to TikTok, Instagram Reels, or other short-form platforms. (Source: https://tubemagic.com/features, https://tubemagic.com/, https://tubemagic.com/about)
- **Long-form vs. Shorts**: the script-length options (100 words/1 min up to 3,000 words/20 min) and framing ("script your videos faster and cheaper," "script high-retention videos") are all oriented toward standard/long-form YouTube videos. Nothing in the crawled primary sources names "Shorts" as a distinct mode or output format. **Not stated in primary sources found**: any explicit statement that TubeMagic supports or targets YouTube Shorts.
- **Faceless channels**: not explicitly named as an ICP anywhere, though the "AI Guy" testimonial ("producing AI-generated historical films") and the "Video to Script" / "Article to Script" tools are consistent with faceless/re-purposed content workflows. This is an inference from testimonial content, not a direct claim by TubeMagic — flagged as such rather than stated as fact.

---

## 6. Gaps / weaknesses observable from primary sources

These are limited to what is *absent* from TubeMagic's own marketing and product pages as crawled — not speculation beyond that:

- **No video rendering or video output at all.** Every tool described (script writer, idea generator, thumbnail generator, title/description/tag generators, transcript converter, article-to-script, Warp Upload Optimizer) produces **text or a still image (thumbnail)**. There is no mention anywhere of assembling/rendering an actual video file, voiceover/TTS, avatar, B-roll, subtitles, or music. The product stops at pre-production/optimization text assets plus thumbnails. (Source: https://tubemagic.com/features, https://tubemagic.com/)
- **No stated Thai-language support specifically.** The only concrete language claim is "over 95 languages... From Spanish to Japanese, you name it," with no published list of the 95 languages, and that specific FAQ sentence covers "descriptions, titles, tags, community posts and video ideas" — it does not explicitly include the **script writer** itself in that guarantee. (Source: https://tubemagic.com/pricing) Whether Thai is supported, and whether it's supported for scripts, is not stated in primary sources found.
- **No Shorts-specific mode.** All script-length guidance and marketing language is long-form-oriented (1–20 minute videos); no "Shorts script" or short-form-specific feature was found.
- **No content calendar.** Only an "Ideas Manager" ("track, save & organize your content pipeline") was found — no calendar/scheduling UI is named.
- **No team/agency/multi-seat plan.** Pricing is a single per-user "Premium" tier; no collaboration, shared workspace, or seats feature is mentioned anywhere crawled.
- **No API** is mentioned on the marketing site.
- **No documented changelog content was retrievable.** `/changelog` exists as a route but returns a client-rendered (Next.js SPA) shell with no server-rendered entries reachable via a plain fetch — see "Sources attempted but unavailable" below.
- **No public help center / docs site was found** (`/help` and `/docs` both 404). Support is described only as email (`support@tubemagic.com`, "mostly respond in under 12 hours on weekdays") plus live chat "for paying customers." (Source: https://tubemagic.com/pricing)
- **Free trial disabled** — TubeMagic itself states this is "due to spam," which is a friction point for prospective users compared to products with self-serve trials; mitigated by the 30-day money-back guarantee. (Source: https://tubemagic.com/pricing)
- **Pricing-page vs. blog inconsistency** — an older first-party blog post describes a free tier that no longer appears to exist per the current `/pricing` page (see Section 3). This suggests the public blog content is not being kept in sync with current product/pricing reality, which is itself an observable weakness in the primary sources (documentation drift).
- **Personalization is link-based, not profile-based** — based on what's published, "personalization" amounts to pasting a channel URL and/or inspiration-video URLs per generation; no persistent, named brand-voice profile, tone slider, or multi-persona system is described anywhere in the crawled pages.

---

## Sources

Successfully fetched and cited above:
- https://tubemagic.com/
- https://tubemagic.com/features
- https://tubemagic.com/pricing
- https://tubemagic.com/about
- https://tubemagic.com/blog
- https://tubemagic.com/blog/get-your-first-1-000-subscribers-on-youtube-with-this-ai-tool
- https://tubemagic.com/blog/get-more-views-on-youtube-in-less-time-with-ai
- https://tubemagic.com/blog/how-to-make-money-on-youtube-without-ads-monetization-program-ai-hack
- https://tubemagic.com/changelog (route exists but rendered no retrievable content — see below)
- https://tubemagic.com/affiliates (used only to corroborate the "50% recurring commissions for life" claim already present in `/pricing`)

## Sources attempted but unavailable

- `https://tubemagic.com/help` — HTTP 404, does not exist as a standalone page.
- `https://tubemagic.com/docs` — HTTP 404, does not exist as a standalone page.
- `https://help.tubemagic.com` — DNS does not resolve (no subdomain help center).
- `https://tubemagic.com/changelog` — page exists (routes correctly, returns 200) but is a client-side-rendered Next.js static export (`nextExport:true`) with no server-rendered content in the HTML payload; a plain fetch retrieves only the page shell/nav ("Changelog" heading, "Go to Homepage" link) with zero visible entries. Could not verify any release-note content from this page.
- `https://tubemagic.com/app` (and `https://app.tubemagic.com/auth/login`) — the in-app product (dashboard, actual script writer UI, ideas manager, etc.) sits behind a login/auth wall (redirects with HTTP 307) and was not accessible without an account. All feature descriptions above are therefore based on marketing/pricing copy about the app, not the live in-app UI itself.
