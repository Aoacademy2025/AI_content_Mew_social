# Brands setup implementation review

Date: 2026-09-06
Branch: `mew/brands-ux-redesign`
Scope: approved `/brands` redesign and focused `/video-editor` handoff. No production deployment or database migration has been performed.

## Delivered behavior

- New creators start with a selected style and deterministic account defaults. Name, audience and niche require no typing. Three starting choices expand to the existing seven qualified packs; custom formats remain available.
- Returning creators land in their library with create/edit/archive actions. Existing plan caps, frozen brands and legacy-format constraints remain enforced.
- A compact selected-image/voice/subtitle summary replaces the wall of tall cards. Optional subtitle appearance uses the same `renderSubtitle` implementation as the editor/export. The primary action remains reachable above mobile bottom navigation.
- New setup POST saves/publishes and creates an editor project in one SQLite transaction, with the exact revision and voice/subtitle/music/pacing/logo defaults. It does not start rendering or spend image credits. Editing publishes for new clips; older project pins remain unchanged.
- The originating-project promotion action is explicitly labeled as applying to that clip. Ordinary brand management has a return-to-original-project link and preserves that project's pin.
- Device drafts are account/surface scoped, validated and expire after seven days. Leaving dirty work uses an inline keep-draft action. Pending write requests survive reload and replay the same server operation; successful results retain a recoverable project link. A paid-preview recovery cannot overwrite newer form work.
- Unknown Gemini voices, inaccessible private Hero voices and removed/foreign logo references are rejected without partially committing the setup. Named voice pickers preserve the selected voice on provider lookup failure. ElevenLabs key/catalog reachability remains governed by the existing provider API/render validation; it is not an offline guarantee.
- Preview generation remains optional and separately quoted. The generic triptych is explicitly described as standard test scenes, and previews whose visual inputs changed are labeled stale.
- Events record setup entry, selection, saved/published revisions and the created project ID. Server success events are skipped on operation replay. Export/repeat-use/MAPC remain outcome metrics, not brand-save counts.

## Sample review

Sixteen ordinary card jobs were generated through the existing public Z-Image endpoint within this implementation/review work (7 initial, 7 scene-copy repair, 2 targeted repairs). No treatment qualification benchmark was run. Rejected intermediates remain outside `public/`.

Seven selected 720×1280 images, each below 120 KiB, are stored under `/style-packs/2026-09-06/`. Provenance includes recipe/pack versions, visual identity, seed, prompt hash, asset hash and review notes. Exact prompts are in `2026-09-06-brands-sample-provenance.json`. The runtime hides a sample if its recorded catalog identity no longer matches.

Review was by the implementation agent at thumbnail and full resolution, not a human panel. These are labeled AI **style illustrations**. Finance/health contain an additional stylized person and are accepted as illustrations only, not proof of exact scene adherence. Ghost/kitchen intermediates containing unintended figures or anatomy artifacts were rejected; the final replacements were inspected again. History now has a real temple-detail illustration instead of a silent gradient.

The earlier design brief proposed an 8–12 second multi-scene audiovisual demo. This change ships reviewed stills plus the actual static subtitle renderer, with that boundary disclosed in the UI. It does not claim a completed multi-scene/voice demo or measured media-generation quality improvement across arbitrary scripts. Multi-scene demos and human sample acceptance remain follow-up qualification work.

## Verification

- `npm run verify:brands-ci`: pass, including the new SQLite setup contract tests, real-client browser regression, sample integrity checks, mobile geometry, existing library/asset/style/treatment/pin/quote/rollout and render-preflight checks.
- `npm run build`: pass (production webpack build and TypeScript).
- `prisma migrate deploy` on a fresh isolated SQLite database: the complete migration chain, including the new operation table, applied successfully.
- `npm run lint:brands`: pass with one existing plain-image warning in AdvancedSettings.
- The narrowly changed editor selector still has two pre-existing `set-state-in-effect` lint findings when linted independently. Its text/link change introduces no new lint finding. This is not a claim that the repository-wide lint suite is clean.
- Two pre-existing type errors in ignored local `artifacts/ops-close-*` scripts came from literal-key Map inference. Their local Map key annotations were widened to `string` for the local build; those ignored scripts are not part of this branch or deployed application.
- SQLite tests cover no typing, default precedence, ownership, operation-key payload conflicts, concurrent identical requests, revision conflicts, FREE caps, unchanged old pins, no render, asset rollback, invalid voice, expired/corrupt recovery and durable receipts.
- Browser CI mounts the real React client against isolated in-memory APIs. It covers an ambiguous 503 after commit, retry to the same project, library return with one brand, edit/navigation guard, disk-draft recovery, save and reload recovery. It checks 320/390/768/1280px and that the mobile primary action clears bottom navigation. Component geometry checks additionally cover 360/500/1024px and finished/partially failed previews.
- Browser fixture APIs are not authenticated production APIs; SQLite tests separately exercise the real services. No production data or user credits are used by CI. The initial interactive Chrome fixture check also passed save/retry/library; its native confirmation hung, motivating the inline guard. Final interactions were verified in disposable CI Chromium.

Screenshots: `artifacts/brands-ux-qa/live-chooser-390.png` and `live-chooser-1280.png` (real client, fixture data and shell).

## Release and North Star

Apply additive migration `20260905000100_brand_library_operations` before serving the new setup route. Rollback can restore the prior application while retaining the unused operation table; do not delete user revisions/drafts.

Before broad rollout: authenticated environment smoke test, human sample review and representative creator testing. The proposed 4/5 unassisted completion and under-60-second median are targets, not measured results. No production conversion/retention lift is claimed.

Measure `brand_setup_started` to first successful export within a fully observed 24-hour window, joined by user/project/revision, segmented by new/returning and paid/trial/stock/AI. Track a second distinct successful project within seven days and the existing MAPC definition. Record a pre-change baseline and comparable cohorts before interpreting a causal improvement. Save/handoff failure rate, rendering reliability and cost per successful outcome remain guardrails.
