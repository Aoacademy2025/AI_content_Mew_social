# ADR 0002: AI generation (image + video) is managed via kie.ai and metered in credits — not BYOK, not self-hosted

Date: 2026-07-03
Status: Accepted

## Context

HERO AI's b-roll differentiator needs AI image generation (already wired, admin-only BYOK)
and AI video generation (not yet built). Three ways to run generation:

1. **BYOK** — users bring their own kie.ai key (today's admin-beta shape). Zero COGS for us,
   but the user must sign up at kie.ai, prepay, and paste a key. The Gemini prepaid-key wall
   already proved this kills activation (309 signups → 32 first-video ≈ 10%), which is why
   the platform pivoted to managed Gemini.
2. **Managed via kie.ai** — we hold one server key; users pay in credits (1 credit = ฿1).
   The credit spend path per image already exists in code (`fetch-stock`, gated on
   `CREDITS_LIVE`). Generation runs on kie's infrastructure — zero VPS CPU cost, high
   concurrency, and access to closed models.
3. **Self-host GPUs** — cheapest raw cost at high volume, but the 2026-06-27 backend survey
   concluded: our volume is low/spiky (zero idle-GPU economics), and the flagship video
   models (Veo/Kling/Seedance/Sora) are closed API-only — they cannot be self-hosted at any
   price. Only open-weight models could ever move in-house.

The business decision (this session) is that AI gen exists to drive subscription conversion
and retention, not to be a second profit engine — so friction matters more than margin.

## Decision

Managed generation through kie.ai's unified API, metered in integer credits, priced at
roughly ×2–3 over COGS:

- **Images** (launch): budget open-source-class model = 1 credit · `gpt-image-2` = 3 credits
  (default — ranked best quality in real use) · `nano-banana-pro` = 4 credits.
- **Video** (own phase, after benchmark): Seedance 1.5 pro only, 5-second clips only
  (b-roll windows are 3–5 s, so 10/15 s variants have nowhere to live), 10 credits/clip.
- BYOK remains a possible later escape hatch for power users, not the default path.
- Every render shows a **Render Receipt** before starting: minutes used vs plan quota,
  incremental credits for AI gen, avatar billed via the user's HeyGen key — nothing is
  silently charged.

## Consequences

- We carry real COGS per generation (≈฿0.35–1.4/image, ≈฿3/video-clip) against credit
  revenue; abuse guardrails must mirror the managed-Gemini pattern (provider-side spend cap,
  per-user rate limits, per-job input caps) before the gate opens.
- Server sizing is unaffected by generation: kie runs it. The KVM8 upgrade exists for
  Remotion render concurrency, and the launch order is: KVM8 → raise render concurrency →
  flip Editor v2 + cutaway → open managed image gen → benchmark video gen → open video gen.
- Fractional credit prices (e.g. 0.5) are rejected: the ledger, packs, and refunds are
  integer-based, and a ฿0.50 difference changes no purchasing decision.
- If volume becomes high and steady, the pre-agreed next step is RunPod Serverless for
  open-weight models only (per the 2026-06-27 survey), leaving closed models on kie.
