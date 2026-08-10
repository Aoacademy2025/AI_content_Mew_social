# CONTEXT.md — Ubiquitous Language

Glossary of domain terms. Definitions only — no implementation details.
(Started 2026-07-02 during the Video Editor v2 redesign planning session.)

## Video Editor

- **Editor v2** — the redesigned Video Editor experience (per the AO Academy design handoff). Coexists with the current editor ("v1") behind a rollout switch until v2 becomes the default.
- **Editor Phase** — which of the three mutually-exclusive stages a project is in: **Setup** (สเต็ป 1–2: script + elements), **Rendering** (job in flight), **Post** (สเต็ป 3: subtitle refinement + export). The phase determines which UI is shown.
- **Setup Phase** — the user makes only essential decisions; every setting has a default; a render can be started immediately.
- **Post Phase** — subtitle tools and the timeline appear only here, i.e. only after a render exists.
- **Segment** — one line of the script (1 บรรทัด = 1 เซ็กเมนต์); the unit shown in the step-1 rail and used for pacing.
- **Narrative Source** — the finalized words that visual planning follows, whether they come from a system-generated script, a creator-written script or the transcript of an uploaded video.
- **Content Preflight** — reusable content understanding prepared from a Narrative Source before AI-assisted visual direction or generation. It identifies the Content Domain and visual-story signals without generating B-roll assets.
- **Visual Beat** — the structured story intent for one B-roll window, including the relevant subject, action, setting, emotion and narrative emphasis. It carries scene meaning rather than provider-specific prompt wording or brand styling.
- **Outdated Visual Beat / ฉากที่เนื้อหาเปลี่ยน** — a Visual Beat whose meaning no longer matches the current Narrative Source after an edit. Its existing asset remains intact and is regenerated only after the creator reviews and confirms the affected scenes.
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
- **Starter AI Image Allowance / สิทธิ์ทดลองภาพ AI** — the image-generation allowance for an account that has not yet subscribed, starting with its public PRO trial and continuing into Free within the same 30-day usage window. Trial expiry does not grant a second allowance. It is not a second credit currency: paid subscriptions continue to use the shared Credit balance for AI generation and overflow minutes.
- **Render Receipt (สรุปก่อนเรนเดอร์)** — the mandatory pre-render summary shown before any render starts: minutes to be used vs plan quota (framed as "included"), incremental credits for AI generation, overflow-minute charges if quota is exhausted, and a note that avatar seconds bill through the user's own HeyGen key. Estimates are labeled as such; the actual charge comes from the real TTS duration.
- **Mix Preset** — one of three named b-roll compositions the user picks in Setup: ฟรีล้วน (stock only, 0 credits), ผสม AI แนะนำ (the default for paid plans), AI เต็มที่. Replaces per-source percentage controls.
- **Per-window Upgrade** — (later phase) replacing a single b-roll window with an AI-generated image or video clip, paid per window; re-rendering for an upgrade never re-charges minutes.

## AI Generation

- **Hero AI Image** — the customer-facing AI image feature in Video Editor. During the internal beta it uses the RunPod AI Engine and the Public Z-Image route; the product name does not expose or redefine the underlying provider.
- **Faceless Brand** — a creator, channel or brand whose videos do not rely on a visible presenter or avatar for recognition. Its identity must be carried by recurring non-face signals across the content.
- **Brand DNA** — the persistent identity system that makes a creator or brand recognizable across videos through its script voice, voice identity, subtitle presentation, brand marks and Brand Visual Language. It remains recognizable when the video's subject and treatment change; it is not the brand's niche or content category.
- **Brand Profile** — a reusable identity for one creator, channel or brand that carries its Brand DNA and supplies the default script style, voice, Subtitle Style, brand mark, Brand Visual Language and Primary Visual Format. An account may keep multiple Brand Profiles; each video project uses one profile and may deliberately override its defaults.
- **Brand Profile Draft** — editable, unpublished changes to a Brand Profile. Draft changes may be previewed but affect no video project until the creator explicitly publishes them as a Brand Profile Revision.
- **Brand Profile Revision** — an immutable version of a Brand Profile's defaults and Brand Visual Language. A video project stays pinned to one revision until its creator explicitly adopts a newer one.
- **Brand Library / แบรนด์ของฉัน** — an account's collection of Brand Profiles and their revisions. Video projects select from this library while full profile creation and maintenance happen outside the per-video flow.
- **Brand Visual Language** — the recurring rendering grammar of a Brand Profile: its palette, personality-driven contrast/lighting/lens character, composition and texture. It controls how a frame is rendered, never what is in the frame — that is the Visual Beat's job (ADR 0006). It is the visual component of Brand DNA, not a video's topic or temporary mood.
- **Visual Brand Brief** — the creator's structured input for shaping a Brand Visual Language: its primary look, palette, personality and optional Visual Notes. See ADR 0006 for what a Visual Brand Brief may and may not control.
- **Visual Notes / รายละเอียดเพิ่มเติม** — optional plain-language guidance a creator adds to a Visual Brand Brief. The system translates its intent into structured visual rules; it is never treated as a provider prompt or exposed as raw model syntax.
- **AI ช่วยออกแบบแนวภาพ** — an explicit, creator-initiated refinement of a Visual Brand Brief into a more coherent proposal. It changes nothing until the creator accepts the proposal and does not itself generate an image.
- **Visual System Consistency** — recognizable coherence in a Brand Profile's visual grammar across scenes and videos. It means matching art direction, not exact reproduction of the same character, mascot, product or other subject.
- **Visual Brand Coverage** — the extent to which a video's B-roll assets follow its Brand Visual Language. Stock-only B-roll makes no visual-language promise, AutoMix covers only its AI-generated windows, and Hero AI Image covers every generated B-roll window.
- **AI Image Density / ความถี่ภาพ AI** — the number of distinct AI images allocated across a video's duration. Lower density makes each image remain on screen longer while preserving the selected visual language; it is not the same as reducing Visual Brand Coverage or mixing in Stock.
- **Text-free AI Image / ภาพไม่มีตัวอักษร** — an AI-generated visual that carries no Thai script and no model-synthesized brand marks, subtitles or headlines. English lettering and characters intrinsic to a depicted object (a banknote denomination, a price tag) are permitted. The deterministic subtitle, headline and brand-mark layers still own all copy the viewer must act on, regardless of what English survives in a generated frame. See ADR 0007.
- **Content Domain** — the subject area inferred from a video's script, such as finance, medicine or history. It supplies the scene's domain context and vocabulary without deciding how the imagery is rendered.
- **Visual Format** — the structural form used to communicate a video's imagery, such as comic storytelling, infographic, stick-figure storytelling, historical storytelling or a photoreal scene. It is independent of the Content Domain and is expressed through the selected Brand Visual Language.
- **Visual Format Card** — an image-led choice that previews a Visual Format without requiring the creator to understand or write an image prompt.
- **Visual Format Benchmark** — the fixed comparison matrix used to qualify a Visual Format on the current image model before it can appear as a customer choice. Every candidate renders the same Hook, Explain and Action/Close scenes so style recognition and cross-scene coherence can be judged independently of subject matter.
- **Brand Differentiation Benchmark** — the fixed comparison that renders the same scenes for two deliberately different Visual Brand Briefs within one Visual Format. It verifies that text-only brand rules make each brand internally coherent and recognizably distinct without claiming character identity or conditioning.
- **Safety Canary** — a small, stable rollout cohort used to prove that AI-image jobs settle correctly, failed jobs restore allowance or credits, and provider reliability and cost remain within explicit limits before exposure expands. It is an operational safety gate, not a statistically powered paid-conversion experiment.
- **Primary Visual Format** — the default Visual Format of a Brand Profile. New videos inherit it automatically, while a creator may deliberately override it for an individual video.
- **Brand Look Preview** — three representative Hook, Explain and Action/Close scene images generated during Brand Profile setup so the creator can judge whether the proposed Brand Visual Language remains coherent across different kinds of visual content before saving it.
- **Visual Treatment** — the art direction selected for one video, keeping the style and tone of its generated B-roll coherent while preserving the chosen Brand Profile. It describes how the video tells its story, not what niche or topic it covers.
- **Suggested Treatment** — the visible Visual Treatment inferred from a video's script and used when the creator makes no selection. It keeps the default creation path automatic while remaining explicitly overridable.
- **Trend Pack** — a curated, replaceable combination of a Visual Format, Visual Treatment and composition rules that offers a recognizable current look. Selecting one affects only the current video unless the creator explicitly saves it as a Brand Profile default; it never replaces the Content Domain or Brand Visual Language implicitly.
- **แนวภาพ** — the creator-facing name for a ready-to-use visual outcome. Plain Thai names hide its underlying Visual Format, Visual Treatment and composition rules; avoid exposing terms such as preset, Trend Pack or Visual Treatment in customer-facing copy.
- **Project Look / แนวภาพของคลิปนี้** — an unsaved, project-scoped visual choice used to try or deliberately override a look without creating or changing a Brand Profile. The creator may explicitly promote it into the Brand Library after seeing the result.
- **Brand Subtitle Style** — a Brand Profile's default selection from the existing subtitle font, color and presentation controls. New projects inherit it and may override it; choosing a Visual Format never changes it automatically.
- **Scene Reroll / ลองภาพนี้ใหม่** — a creator-requested replacement image for one Visual Beat that preserves the selected Brand Visual Language. It is a new generation, not an Engine Retry.
- **Brand Look Revision / ปรับแนวภาพทั้งช่อง** — a creator-approved change to the Visual Brand Brief and Brand Visual Language for future image generation. It is distinct from replacing a single scene image.
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
