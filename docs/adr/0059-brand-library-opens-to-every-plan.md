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
only when that decision was `canUse: true` — after which pinning can open to every plan too. Two
system-initiated pin writers remain outside the image guard and pre-date this wave: the
First-Clip auto-spine (`ensureFirstClipProjectSpine` → `pinProjectBrandRevision` in
`src/lib/first-clip-path.server.ts`, called from `POST /api/videos/jobs`) and the Hero
Script send-to-editor handoff (`createEditorProject({ brandProfileRevisionId })` in
`src/lib/hero-script.server.ts`), both of which can write a persisted pin for an account
the image gate would reject. This wave did not close them, so wave 1's re-anchoring must
cover these two writers as well, not only the two creator-initiated routes above.

## Amendment 2 — 2026-09-03 (wave 1b, #430)

Attaching a Brand Profile or ชุดสไตล์ to a project now requires only the library guard
(`requireBrandLibraryUser`): `PUT /api/editor-projects/<id>/brand-revision`,
`PUT /api/editor-projects/<id>/visual-context` and `POST /api/brand-library/from-project-look`
accept every plan, FREE included (plan limits are the only cap). The grandfather clause in
`resolveBrandVisualRenderAccess` (synthetic cohort `existing-pin`) is anchored to a **Pin
admission**: every pin writer — the three creator routes, the First-Clip auto-spine, the Hero
Script send-to-editor handoff, promotion, and render-time materialization — records the
owner's image-access decision at write time in the additive columns
`EditorProject.brandVisualPinAdmittedCohort` / `brandVisualPinAdmittedAt` (null when the decision
was not `canUse`). A persisted pin is honoured for rerenders only when that stamp is present;
clearing any pin clears it, and every pin write re-stamps, so a pin can never be a self-service
admission ticket (#430 closed). Job creation snapshots the pinned visual context for every
library user — the pack's Stock Mood, subtitle default, pacing and music apply on stock renders —
but writes `brandVisualAcceptanceJson` only for admitted users; the AI-image spend path
(`fetch-stock`) still requires that envelope. Explicit AI-image actions keep their gate and
answer a non-admitted request with the same locked response as any non-entitled account; the
editor never offers them for an unadmitted pin. Legacy pins are back-filled once at deploy for
owners whose current decision is `canUse` (D3); all other legacy pins stay unadmitted.

Three consequences worth stating so nobody "fixes" them back. (1) Render-time
materialization (treatment repair, job-context pinning, scene-prompt repair) stamps the
owner's *live* decision when it is `canUse`, keeps an existing admitted stamp on the
grandfather path, and writes null otherwise — so the stamp means "admitted at the most recent
pin write by a live-admitted owner", and a stock-only render by an admitted owner does
grandfather the project (established work stays rerenderable after a downgrade). (2) The three
creator routes resolve the image decision explicitly (`resolveBrandVisualAccess(user)`) instead
of reusing the guard's attached decision — one extra entitlement read per pin write, kept so the
stamp source survives a future change to `requireBrandLibraryUser`. (3) Rollback: with
`BRAND_VISUAL_SYSTEM_ENABLED=0` an unadmitted pinned project renders **without** its pack (no
error, no notice); admitted projects keep the grandfather path. The export logo overlay stays a
PRO/BUSINESS plan feature: a pinned-but-unadmitted project does not stage the brand mark.
Content Preflight — the one managed text call that reads the script and suggests a ชุดสไตล์ —
runs for every library user, pin or no pin, behind the existing per-user AI-text cap, because
the editor needs that analysis before a first pin can be made; a refused caller
(`feature_off` / `suspended`) gets the library-shaped notice, never the AI-image upgrade copy.
