# Brands UX redesign — เลือกแล้วสร้างคลิปได้ โดยไม่ต้องกรอกฟอร์ม

Date: 2026-09-05
Status: Approved by Mew; core UI/API implementation completed on `mew/brands-ux-redesign`. See `docs/audits/2026-09-06-brands-implementation-review.md` for verification, sample boundaries and remaining release qualification. Not deployed.
Input: Mew requests a new `/brands` UI/UX that minimizes typing and abandonment, remains usable, reliable and high quality, and advances North Star. Evidence: `docs/audits/2026-09-05-brands-product-ux-audit.md`.

## 1. Scope

| Surface | Change |
|---|---|
| `/brands` (the actual route; called `/brand` in conversation) | Primary redesign: library, new-brand setup, editing, sample presentation, draft recovery, save-and-create handoff |
| `/video-editor` (called `/editor` in conversation) | Focused integration: accept selected revision, show one brand summary, allow per-clip override, return from brand management with project context preserved |
| `/hero-script` | Preserve brand/revision and writing defaults through existing send-to-editor path; repair inconsistent integration only, no page redesign |
| Brand API, sample pipeline, telemetry | Defaults, full-recipe samples, sample availability, preview identity, resumable/idempotent save/handoff and authoritative events |

No new duplicate `/brand` or `/editor` routes required. A whole-editor redesign, new treatment catalog, payment redesign and model migration are outside this scope.

## 2. Outcome and principles

Main journey: **ดูตัวอย่าง → ใช้สไตล์นี้ → สร้างคลิป → export → ทำคลิปถัดไปด้วยแบรนด์เดิม**.

- Zero mandatory typed fields for brand setup. Name and other required payload fields are supplied by deterministic validated defaults. This does not promise a content-free video: the clip's subject/script is collected later in the creation flow.
- One main action per screen. No required niche/audience questionnaire, brand analysis call, image generation or upload before saving.
- Show the resulting look and resolved settings, not internal terms such as provider ID, treatment, pin or recipe.
- Prefer existing approved account/project choices, then qualified catalog defaults. Do not silently infer a niche from a brand name or claim personalized recommendations without evidence.
- Previewing options does not publish, bill, render or alter existing clips.
- Brand creation is optional before the first clip. Users can start a clip and save its successful look as a brand afterward.
- Mew clarification: frontend-design is advisory, not an aesthetic gate. Existing HERO design tokens, familiar controls and measured usability outrank a skill's stylistic preferences. Cards, grids or the current accent color may be retained when they help selection; do not add novelty at the expense of clarity or consistency.

## 3. Page states and layout

### A. No brands yet — open the chooser directly

Header: **เลือกสไตล์ แล้วเริ่มคลิปแรก**
Support: **เราเตรียมเสียงและซับให้แล้ว ปรับทีหลังได้** — show this only when voice/subtitle defaults are resolved and valid; otherwise show the specific loading/error state.

Desktop uses a selection area and a single adjacent result area. Mobile stacks the selected example and concise summary before the compact options. Use the existing application typography/theme tokens; keep clear Thai body text, large touch targets and one accent for the primary action. Avoid the current wall of tall pictures with tiny captions.

Selection:

- Show up to three qualified starting choices and “ดูสไตล์ทั้งหมด” for the existing seven. With no preference history call them “สไตล์เริ่มต้น”, not “เหมาะกับคุณ”. Do not treat these first three as proven optimal until usability/cohort evidence exists.
- Select a safe catalog default in advance, clearly show “เลือกอยู่”, and let the user proceed without interacting with options.
- Each choice has a comprehensible name, one sentence about the result and a real reviewed sample. A missing sample uses an explicit unavailable state; never a gradient masquerading as an output.
- Provide “ปรับสไตล์เอง” as a secondary path with accessible existing formats such as comic. Do not launch an unqualified new “Comic pack” merely to give it a card. Selecting a custom format clears pack identity under the existing contract.

Result area:

- One reviewed 9:16 demo (roughly 8–12 seconds is the proposed content brief) representing multiple scenes, subtitle presentation and pacing. Its source is stated as stock or AI where necessary to understand achievable results. Demo playback is free and user-initiated; never autoplay sound.
- Resolved summary: ภาพ, เสียง, ซับ; an expandable line for เพลง/จังหวะ. Custom overrides are reflected accurately.
- Editable display name, initially “แบรนด์ของฉัน” with a non-conflicting suffix if needed. Editing is optional and is not a full-width required form above the examples.
- Optional inline “ปรับรายละเอียด” for voice, subtitles, palette, logo and writing; not a second mandatory screen.
- Primary action **ใช้แบรนด์นี้สร้างคลิป**; secondary **บันทึกไว้ก่อน**; quiet route **ไปสร้างคลิปก่อน** for users who do not want a brand.
- “ตั้งค่าแบรนด์ไม่ใช้เครดิต” may be shown only for the non-billable setup action. Paid generation keeps its own price and explicit action; never label the entire video journey free.

### B. Existing brands — start with the library

Show saved brands as concise rows with name, small representative sample, readable style/voice summary and **สร้างคลิป**. Put **แก้ไข** beside the row and archive under a secondary menu. Show **สร้างแบรนด์ใหม่** once in the header. Respect the existing plan cap; display the cap reason and existing usable brands when full.

Do not open a long editor automatically on every return. No fabricated “brand score”, percentages or success badges. Latest successful clip may serve as the thumbnail only when its brand revision/source mapping is verified.

### C. Edit existing brand — clear draft versus published state

Keep the chooser/result layout. Show **ยังไม่บันทึก**, **เก็บร่างแล้ว** or **ร่างนี้ยังไม่พร้อมใช้** based on real state.

Primary **บันทึกสำหรับคลิปใหม่**; secondary **เก็บร่าง**. For an explicit originating project, **บันทึกและใช้กับคลิปนี้** is a distinct action with visible scope. Existing clips stay pinned unless the creator explicitly applies a revision.

On visual changes, keep any paid preview tagged **ตัวอย่างจากการตั้งค่าก่อนหน้า** until inputs match again or a new request succeeds. Name-only edits do not invalidate image previews.

### D. Handoff into editor

Editor shows a single summary such as **แบรนด์ของฉัน · ดราม่าชีวิตจริง** and the resolved voice/subtitle information already chosen. “เปลี่ยนสำหรับคลิปนี้” opens per-project controls, not the whole brand form.

- New clip: save/publish successfully first, then create or resume an editor setup project pinned to the returned revision. No paid render starts on this action.
- Originating clip: preserve project, script, media, completed work and source context. Apply only the explicitly chosen revision; do not duplicate the project or regenerate assets silently.
- Saved but navigation/project creation failed: show **บันทึกแบรนด์แล้ว ไปต่อยังไม่สำเร็จ** with **ไปสร้างคลิปต่อ**; retry resumes from the saved ID instead of saving another brand.
- Direct new-video entry still works without a brand. The brand page must not become an onboarding gate.

## 4. Eliminate manual entry with deterministic defaults

| Field today | New default | Optional user control |
|---|---|---|
| Name | Account-private “แบรนด์ของฉัน”, collision-safe suffix | Rename inline |
| Niche / audience | Leave optional; derive clip-specific context from its later script through existing preflight | Writing details if the creator wants persistent guidance |
| Format / treatment | Resolve qualified selected pack; preserve revision | Select custom look in secondary controls |
| Palette / personality | Selected pack or explicitly retained identity | Palette swatches / plain-language choices; hex is advanced |
| Voice provider / ID | Existing valid approved default if accessible; otherwise entitled system default | Named voice picker with available sample, never require typing an ID |
| Subtitles | Explicitly saved user style first; otherwise selected pack's valid config | Visual swatches using actual subtitle renderer |
| Writing tone | Preserve authored tone; otherwise selected pack's seed | Short tone choices, optional text |
| Music / pacing | Valid pack defaults with source/entitlement checks | Optional named choices; no silent paid substitution |
| Logo | Existing explicit account default if valid; otherwise off | Upload/change later |

Precedence: an explicit change in this draft wins; next follow the existing user-override/pack ownership rules; then use validated account/default values. The UI summary must display the fully resolved result. Do not overwrite a user-authored tone or saved subtitle preset when trying another pack. Do not assume the latest generated clone is approved or available.

Defaults must not require a model call. If lookup fails, do not silently select a different voice after the user has reviewed it. Expose an actionable state; saving an incomplete draft may remain possible while create/publish waits for valid required inputs.

## 5. Preview and sample contracts

Three distinct products:

1. **ตัวอย่างสไตล์** — static reviewed demo, free to view, clearly sample content. Its full resolved recipe/version is recorded. It does not claim to reflect every account-specific voice/override.
2. **ดูการตั้งค่าของฉัน** — instant deterministic subtitle/color/layout preview plus separately labeled voice sample when available. No AI-image request.
3. **ลองกับบทของฉัน** — optional contextual generation using actual script/project; show server quote and reuse before action. No generic storm/hands/face triptych presented as the creator's story.

Asset manifest: sample ID, pack version, format/treatment recipe, visual identity hash, media source, review status and available URLs. Ready means file exists, decodes, matches supported aspect and has human review. Unavailable remains labeled without pretending the pack itself is broken.

Full pipeline parity matters more than decorative thumbnails. The concept preview accompanying this plan shows layout and interaction only, with explicitly labeled demo placeholders; it is not evidence of final generated visual quality.

## 6. Reliability and state transitions

States: loading → ready/default selected → dirty → saving → saved → handing off → editor. Failures return to a recoverable state preserving user choices.

- Validate defaults server-side before publish. Handle missing/retired voices, removed assets, full profile cap, frozen profiles and denied AI-image access explicitly.
- Carry an idempotency key through save/create handoff. Disable repeated submission while in flight; server deduplication still required for timeouts/retries.
- Revision pinning remains immutable. Publishing does not rewrite existing projects.
- Protect unsaved work when navigating or switching brands. Draft recovery must be account-scoped, distinguish device draft from server save, and avoid promising sync when offline. Do not repurpose pending paid-preview recovery storage as the general draft store.
- Preview snapshot hash follows image-relevant resolved inputs. Old preview/reroll actions remain tied to their actual snapshot, not whatever the current draft happens to be.
- Entitlement gates stay on the affected paid action. Brand save and selection remain available under existing library/cap rules; fallback never incurs an undisclosed charge.
- Loading placeholders reserve space. Errors have retry/help in place. Confirm durable saves only after server success, never with an optimistic “saved” label.
- Use the existing catalog/compiler/revision services and strengthen their contracts instead of maintaining another UI-only style system.

## 7. Implementation slices

| Slice | Deliverable | Main ownership area | Exit criterion |
|---|---|---|---|
| 1 | Resolved defaults, sample manifest, preview identity, draft/handoff contracts | `src/lib/brand-*`, `style-pack-*`, `src/app/api/brand-library/*`, generation script | Valid complete payload with zero typing; ready samples checked; retries cannot duplicate brands/jobs |
| 2 | New library / chooser / editor states, summary, optional customization | `src/app/(dashboard)/brands/_components/*` | Both new and returning creator paths function on desktop/mobile; no required text entry |
| 3 | Brand-to-editor handoff, per-clip override, return-to-project | Editor project API + `video-editor/_v2/BrandVisualSelector.tsx`, setup state | Exact revision reaches correct project with media/script preserved; failure resumes safely |
| 4 | Real reviewed demos, quality checks and experiment instrumentation | Assets + review manifest + telemetry | Samples match actual output contract; full cross-plan/browser acceptance and measured rollout |

Inspect any applicable project instructions again before implementation. Update ADR 0058/CONTEXT only where approved final customer vocabulary/default semantics actually change. No schema changes are assumed necessary until the durable draft/idempotency seam is designed.

## 8. Quality and release acceptance

**Usability:** zero mandatory typed fields; target at least 4/5 representative first-time testers can choose and reach editor without coaching, with a proposed median setup under 60 seconds. These are acceptance targets, not measured results. Test return users separately.

**Visual quality:** every ready sample reviewed at card and fullscreen sizes; Thai text readable, subjects meaningful and style distinguishable; demo and render use the same versioned recipe. Stock promises mood/selection, not exact AI palette or identical identity.

**Correctness:** source-to-summary-to-payload-to-editor values match; custom user settings preserved; old projects unchanged; new projects receive the selected revision. Screenshot comparison alone is insufficient.

**Reliability tests:** saving timeout then retry, saved-brand/handoff failure, double click, reload with draft, simultaneous tabs, stale preview, deleted asset, retired voice, cap reached, FREE/Trial/Paid image gates, partial/failed generation, originating-project return. No duplicate write/charge or lost draft in covered cases.

**Accessibility / responsiveness:** native keyboard controls, visible focus, selected state beyond color, labeled inputs, error announcements, reduced motion and no horizontal overflow at 320/360/390/768/1280px. Touch targets approximately 44px; Thai editable text at least 16px. Main action stays reachable on mobile without covering content or keyboard.

**Delivery:** run existing applicable brand/style/pin/quote checks plus meaningful state-transition tests and browser QA. Test with isolated fixtures before authenticated staging/production read-only validation. Keep rollback possible without deleting user drafts or revisions.

## 9. North Star and experiment

Primary business link: more active paying creators with successful outcomes, as defined by `subscription-north-star.server.ts`; track recurring conversion separately. Current MAPC includes qualifying prepaid annual customers, not only auto-renewing subscribers.

Main journey metric: **brand-flow start → successful first export within 24h**. Deduplicate users, join to project/revision, wait for a fully observed window, and segment new/returning, paid/trial and stock/AI. Brand saves and preview views are diagnostics only.

Supporting metrics: time to export (median/p75 plus completion rate), second distinct successful project within 7d, draft abandonment, preview-to-repair burden and trial-to-recurring-paid. Guardrails: save/handoff error rate, render failure rate, cost per successful outcome and support burden. Do not count rerenders as repeat creation.

Collect pre-change baseline and use comparable cohorts/experiment assignment. Do not claim a causal retention lift from brand users versus all other users. Set numeric business rollout thresholds after baseline/traffic are known; qualitative test targets above do not substitute for production evidence.

## 10. Deliverable boundary

The original planning deliverable supplied an interactive concept. Mew subsequently approved implementation. The core page, transactional handoff, draft recovery and reviewed still samples are now implemented. The original concept remains a design artifact; current verification and the remaining multi-scene demo/human/production qualification are recorded in `docs/audits/2026-09-06-brands-implementation-review.md`. Deployment has not occurred.


### Concept verification completed

Browser-tested the local concept: selecting finance updates the summary, create sends that selection to the simulated editor, return shows the same brand, and optional rename/save updates the simulated library. Checked no root horizontal overflow at viewport widths 360 and 768px; inspected mobile and desktop layout. JavaScript syntax check passed. This verifies the concept interactions only, not application APIs, actual media quality, persistence, billing or a production release.
