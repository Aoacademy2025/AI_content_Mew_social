# CONTEXT.md — Ubiquitous Language

Glossary of domain terms. Definitions only — no implementation details.
(Started 2026-07-02 during the Video Editor v2 redesign planning session.)

## Video Editor

- **Editor v2** — the redesigned Video Editor experience (per the AO Academy design handoff). Coexists with the current editor ("v1") behind a rollout switch until v2 becomes the default.
- **Editor Phase** — which of the three mutually-exclusive stages a project is in: **Setup** (สเต็ป 1–2: script + elements), **Rendering** (job in flight), **Post** (สเต็ป 3: subtitle refinement + export). The phase determines which UI is shown.
- **Setup Phase** — the user makes only essential decisions; every setting has a default; a render can be started immediately.
- **Post Phase** — subtitle tools and the timeline appear only here, i.e. only after a render exists.
- **Segment** — one line of the script (1 บรรทัด = 1 เซ็กเมนต์); the unit shown in the step-1 rail and used for pacing.
- **Caption / การ์ดซับ** — one on-screen subtitle unit with text, start/end time, and an optional tag (hook / body / cta). Editable in the Post phase.
- **Advanced Settings (ตั้งค่าขั้นสูง)** — collapsible areas that hold every existing capability the redesign's default surfaces don't show (e.g. avatar position calibration, chroma sliders, split mode, FPS/quality). Policy: features are *relocated* into Advanced, never deleted.
- **Timeline** — the 4-track visualization in the Post phase (avatar / b-roll / subtitles / music). Only the subtitle track is editable; the other tracks are display + select/jump only.

## Rendering

- **Background Render** — a render whose entire generation pipeline runs server-side as a job; the user may close the tab and resume later. Contrast with the v1 behavior where the browser orchestrates the pipeline and closing the tab stops it.
- **Preview Mode (of a video job)** — a background job that stops after producing the *base render* (and avatar composite, if any) **without burned subtitles**, returning captions and config so the editor can enter the Post phase.
- **Base Render** — the assembled video (voice + b-roll + music + avatar) *before* subtitles are burned in.
- **Burn / Export** — the final step that renders subtitles into the video file. The Post phase's single primary action.
- **Cutaway Mode (เต็มจอ + B-roll)** — direct-upload mode where the user's own full-frame clip gets automatic subtitles and stock b-roll cutaways while the original voice continues.

## Credit Economy

- **Render Minute (นาที)** — the primary metering unit of a subscription: minutes of *output video* rendered per 30-day window (PRO 80, BUSINESS 150). Rounded to nearest whole minute, minimum 1. Not the same thing as a Credit.
- **Credit (เครดิต)** — the single top-up currency, 1 credit = ฿1 of perceived value. Spent on things *beyond* the subscription's included minutes: overflow render minutes and AI generation. Never used for anything the plan already includes.
- **Granted Credits** — the monthly credit allowance included with a paid plan (use-it-or-lose-it, resets each 30-day window). Spent before Purchased.
- **Purchased Credits** — credits bought as one-time packs; roll over (~12 months).
- **Overflow Minutes** — render minutes beyond the plan quota, paid from credits (2 credits/minute) instead of hard-walling the user. Must be disclosed on the Render Receipt before rendering, never charged silently.
- **Render Receipt (สรุปก่อนเรนเดอร์)** — the mandatory pre-render summary shown before any render starts: minutes to be used vs plan quota (framed as "included"), incremental credits for AI generation, overflow-minute charges if quota is exhausted, and a note that avatar seconds bill through the user's own HeyGen key. Estimates are labeled as such; the actual charge comes from the real TTS duration.
- **Mix Preset** — one of three named b-roll compositions the user picks in Setup: ฟรีล้วน (stock only, 0 credits), ผสม AI แนะนำ (the default for paid plans), AI เต็มที่. Replaces per-source percentage controls.
- **Per-window Upgrade** — (later phase) replacing a single b-roll window with an AI-generated image or video clip, paid per window; re-rendering for an upgrade never re-charges minutes.

## AI Generation

- **Hero AI Image** — the customer-facing AI image feature in Video Editor. During the internal beta it uses the RunPod AI Engine and the Public Z-Image route; the product name does not expose or redefine the underlying provider.
- **Hero AI Voice** — the customer-facing voice feature backed by OmniVoice. During the internal beta its Voice Backend is RunPod; it is governed by the subscriber's maximum clip duration rather than a fixed whole-script character ceiling.
- **AI Engine** — the provider family a customer chooses before choosing an image model. The engine fixes the commercial and operational boundary of that generation job.
- **RunPod AI** — the AI Engine for open-weight image models executed through RunPod. It never invokes a Cloud API model when unavailable or unsuccessful.
- **Cloud API** — the separate AI Engine for closed/provider-hosted models such as GPT Image. It has its own models, prices and generation jobs.
- **Engine Retry** — another attempt within the same AI Engine under that engine's rules. Moving to another engine is a new customer choice, never a retry or fallback.
- **Voice Backend** — the infrastructure route that executes Hero AI Voice. A video job pins one Voice Backend for its lifetime; changing the rollout switch only affects new jobs.
- **GPU Fallback** — RunPod selecting the next allowed GPU type for the same custom endpoint when a preferred type is unavailable. It does not change the AI Engine, model, price quote or customer choice.

## Rollout

- **Rollout Switch** — the two-layer mechanism controlling who sees Editor v2: an environment default for everyone plus a per-person override, so v2 can be QA'd on production before being enabled for all users.

## Hero Script

- **Hero Script** — the viral script writer at `/hero-script` (menu: "เขียนสคริปต์ AI"): topic → hook variants → full script → 1-click handoff into the editor. Sibling of Hero AI Image / Hero AI Voice.
- **BrandProfile** — a saved, structured niche identity (นิชเจาะลึก, audience, tone, banned words, CTA style, analysis notes) that conditions every Hero Script generation. Plan-capped (FREE 1 / PRO 5 / BUSINESS ∞). Distinct from the legacy `Style` blob and from `BrandPreference` (visual logo defaults).
- **Niche Drill-down (ขุดนิช)** — turns a broad seed ("การเงิน") into 7 specific sub-niche angles ("การเงินสาย dark…"); re-drilling a picked niche goes one level deeper. v1 is LLM-knowledge-only.
- **Viral Framework** — the curated library in `src/lib/viral-frameworks.ts`: 10 hook formulas, 5 story structures, retention rules, 4 CTA styles. The flow is hook-first: the user picks/edits a hook before the full script exists; the chosen hook is never rewritten by the model.
- **Continuity** — idea generation is conditioned on the profile's saved script topics: never repeat, and ≥2 of 8 ideas must continue/serialize past topics.
- **Script Handoff (ส่งไปตัดต่อ)** — atomic creation of an EditorProject from a saved Script using the editor's own default-draft builder; the assembled script is blank-line-stripped so "1 line = 1 Segment" always holds. FREE plan: locked (editor is PRO+).
