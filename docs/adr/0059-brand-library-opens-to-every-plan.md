---
status: accepted
---

# Brand Library opens to every plan; only AI-image actions keep paid gates

Date: 2026-09-02

`/brands` was gated three times over: a paid-equivalent entitlement, a percentage rollout bucket (`BRAND_VISUAL_ROLLOUT_PERCENT`), and a rule that a Conversion-Trial account with an unused starter image allowance cannot create a profile at all (`canCreate = !starterAllowance.eligible && …`), plus a layout redirect that bounces anyone still on the First-Clip Path back to the editor. Those gates were designed when a Brand Profile's only value was AI-image styling. With ADR 0057 a profile now styles free stock B-roll, subtitles, voice, logo and pacing at zero marginal cost, and on production only 6.4 % of customers ever created one while `plan-limits.ts` already grants FREE one profile.

**Decision.** Creating, editing, publishing and pinning a Brand Profile requires only an authenticated, non-suspended account and the master switch `BRAND_VISUAL_SYSTEM_ENABLED`; plan limits (FREE 1 / PRO 5 / BUSINESS ∞) are the only cap. The paid-equivalent check and the rollout bucket move to the **AI-image actions**: Brand Look Preview, preview reroll, Scene Reroll and Hero AI Image generation keep exactly the gates, credits and starter-allowance rules they have today. The first-clip redirect and the starter-allowance creation block are removed. The hard-coded owner e-mail bypass is replaced by the existing `BRAND_VISUAL_TEST_EMAILS` list.

**Consequences.** `requireBrandVisualUser` splits into a library guard (auth + suspension + master switch) and an image guard (library guard + entitlement + rollout). The locked-preview page is shown only for `feature_off` and `suspended`; `payment_required` and `rollout_wait` appear only on the image buttons, as inline upgrade copy. FREE and trial creators see Locked Feature Preview copy on image actions, never on the page. Rollout-health measurement (`brand-visual-rollout-health.server.ts`) keeps reading the image cohort, not page access.

## Amendment 2026-09-02

Attaching a Brand Profile to a project stays on the image guard for now. A persisted
project pin (`EditorProject.brandProfileRevisionId`, or the equivalent Project Look
fields) is an unconditional grandfather clause in `resolveBrandVisualRenderAccess`
(synthetic cohort `existing-pin`), which exists so a downgrade or a rollout rollback
cannot break rerenders of work that was already admitted. Opening the pin writes —
`PUT /api/editor-projects/<id>/brand-revision` and `POST /api/brand-library/from-project-look`
— would therefore have turned that clause into a self-service admission ticket: a FREE,
trial-expired or rollout-waiting account could create a profile, pin it to a fresh
project and be admitted to managed AI-image generation, bypassing the Hero AI Image plan
gate and both downstream re-checks. Those two routes keep `requireBrandVisualUser`;
creating, editing, publishing and deleting a Brand Profile is open to every plan exactly
as decided above. Wave 1 must anchor the grandfather clause to the access decision
recorded when the pin was written (an additive column), and honour `hasPersistedProjectPin`
only when that decision was `canUse: true` — after which pinning can open to every plan too.
