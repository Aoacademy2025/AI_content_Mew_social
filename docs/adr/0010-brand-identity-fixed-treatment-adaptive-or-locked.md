# Brand identity stays fixed while treatment adapts or locks

Date: 2026-08-17
Status: Accepted

A Brand Profile fixes its Primary Visual Format and Brand Visual Language across videos, while its Treatment Policy is either Adaptive Treatment, which derives a visible Suggested Treatment from each Narrative Source by default, or Locked Treatment, which inherits one creator-chosen treatment for a specialized channel. This hybrid boundary was chosen over fully automatic visual selection, which can make a channel's format jump between videos, and mandatory per-video selection, which adds completion friction; a project may still deliberately override its inherited treatment without rewriting the Brand Profile.

AI recommendations select only from a reviewed Treatment Catalog rather than inventing free-form top-level treatments. The initial catalog is prioritized from recurring patterns in completed non-Admin customer work and support outcomes, so internal QA volume cannot distort apparent demand; scene-level direction remains adaptive inside the selected preset.

Visual Planning Readiness creates one Treatment Pin for the whole video. Every generated scene and later Scene Reroll must compile that same preset; AI may vary only Scene Intensity and beat-specific subject, action, setting or emotion. It may not reclassify individual scenes into other presets, and changing the Treatment Pin is an explicit project-level creator action.

The Treatment Pin stores both the Treatment Preset identity and its immutable Treatment Preset Version. New videos use the latest qualified version, while existing scenes and Scene Rerolls remain reproducible on the pinned version; adopting a newer version follows the same explicit all-or-nothing change rule. A Targeted Visual Repair that replaces an invalid generic placeholder pins the current qualified version.

Once a project already has generated AI B-roll, an explicit Treatment Pin change is all-or-nothing for that AI image set. The creator may confirm regeneration of every existing AI image with the image count and credit total disclosed, or cancel and keep the current pin; V1 removes the existing `ใช้แนวใหม่เฉพาะภาพต่อจากนี้` option because it knowingly creates a half-changed video. Stock and uploaded B-roll remain outside the treatment promise, and applying the confirmed image replacements does not consume another render minute.

Before the first image generation, Adaptive Treatment may revise its recommendation whenever the Narrative Source changes, provided the creator has not selected a treatment explicitly. An explicit creator selection or the first generated AI image fixes the Treatment Pin: later script analysis may show a better recommendation but never applies it silently. Keeping the pin regenerates only confirmed Outdated Visual Beats under that same treatment; adopting the new recommendation follows the all-or-nothing existing-image rule above.

## Initial Treatment Catalog

The accepted V1 catalog contains eight presets. Internal names remain stable for storage and evaluation, while the concrete Thai labels are the only names shown to creators:

| Internal preset | Creator-facing label |
| --- | --- |
| Expert Clarity | ผู้เชี่ยวชาญอธิบายชัด |
| Practical Documentary | สาธิตจากชีวิตจริง |
| Thai Human Drama | ดราม่าชีวิตไทย |
| Modern Business and Technology | ธุรกิจและเทคทันสมัย |
| Premium Product and Lifestyle | โฆษณาสินค้าพรีเมียม |
| Investigative News and Crime | ข่าวสืบสวนเข้มข้น |
| Thai History and Period Storytelling | ประวัติศาสตร์และตำนานไทย |
| Thai Supernatural Horror | หนังผีไทย |

The first seven reflect recurring topic and storytelling patterns in completed customer projects; Thai Supernatural Horror also addresses direct support evidence that a neutral treatment produced bright, non-frightening imagery and failed to preserve a human character.

All eight presets must pass a Treatment Qualification Benchmark before the catalog ships once to the entitled population. The release matrix covers all 8 Treatment Presets × all 5 Visual Formats × at least 3 scenes—opening, development and a key scene—for a minimum of 120 internal images. Every pair checks preservation of hard story facts, Story Entity type, setting, time, treatment recognition and cross-scene coherence; a pair that fails minimum quality is fixed and rerun rather than exposed as an untested combination. The strongest qualified pairs shape recommendation ranking, but every inherited format remains usable without a mandatory format switch.

Thai Supernatural Horror includes the two reported regressions as mandatory cases: an elderly woman at a house at night must remain frightening and nocturnal, and Kong must remain an adult Thai man in the funeral scene rather than becoming a gorilla. Internal benchmark generations consume no customer credits and never count as customer-demand evidence.

Benchmark inputs are De-identified Customer Benchmark Fixtures, not copied raw scripts. They retain only the minimal narrative pattern and Hard Scene Facts needed to reproduce quality behavior after account identity, contact details, business identifiers and unrelated wording are removed. The token `Kong` remains in its regression fixture because its ambiguity triggers the defect, but no fixture or report links it to the support-ticket account; results are reported only by aggregate topic, format and treatment.

Because every catalog pairing passes minimum quality, a stronger pairing creates only a Format Recommendation, never a conflict or generation block. The system preserves the Brand Profile's inherited Primary Visual Format by default and may say in plain language that another format is likely to express this story more strongly, with an optional `เปลี่ยนเฉพาะคลิปนี้` action. It never changes format silently; only explicit creator acceptance applies the project-scoped override.

V1 does not add a post-generation image acceptance gate or any hidden automatic image retry. The initial render keeps its existing image count and cost. Quality improvements happen before generation by preserving hard story facts and compiling the selected Treatment Preset into every scene. If a creator still wants a different result, the existing per-window Scene Reroll remains the recovery path and continues to cost the current two credits per requested replacement; V1 adds no separate correction screen or mandatory feedback step.

Visual direction in V1 adds zero required setup steps. Adaptive Treatment is the default for every Brand Profile because Treatment is primarily a per-video decision; the profile keeps stable visual identity while the narrative supplies the video's treatment. Locked Treatment is an optional advanced Brand Profile setting for a specialized channel and, only when enabled, asks the creator to select one preset from the full catalog.

A creator may render without understanding or selecting a Treatment Preset. The existing project visual control shows a plain-language summary such as `คนสมจริง · หนังผีไทย`; its optional change action shows the recommended preset and two content-relevant alternatives before a secondary `ดูทั้งหมด` action reveals the complete catalog. The current free-form per-video treatment field is removed so an arbitrary or generic phrase cannot bypass the reviewed catalog. Recurring Character Descriptions remain entirely behind the scenes, advanced vocabulary and character fields do not enter the beginner path, and post-render correction continues through the existing per-window B-roll controls.

Customer-facing copy uses `แนวเล่าเรื่อง` and concrete Thai option names. It never exposes the internal terms Treatment, Preset, Pin, Version or Scene Intensity; Adaptive and Locked policies are presented as `AI เลือกแนวเล่าเรื่องตามเนื้อหา` and `ใช้แนวเล่าเรื่องเดิมทุกคลิป`. A Format Recommendation uses neutral optional copy rather than conflict language, warning color or a blocking state.

A creator may submit a render while Content Preflight is still running, but image generation waits for Visual Planning Readiness without requiring another click. The project must not persist or compile an unfinished generic treatment merely because the asynchronous analysis has not returned; only the completed recommendation or an explicit creator choice may be pinned for generation. The waiting state is shown as progress, creates no extra image or credit charge, and accepts a small pre-generation delay in exchange for avoiding the observed race that discarded a completed horror treatment.

If Content Preflight still fails after the text provider's existing three automatic attempts, the render stops before image generation and before any image credit is charged. The creator sees one plain-language retry action; V1 does not stack another retry loop, expose provider terminology or continue with a generic visual fallback. A temporary inability to plan the requested story is safer than charging for predictably neutral or irrelevant imagery.

V1 quality is measured from real non-Admin customer behavior rather than a mandatory rating prompt. Its primary visual-quality signal is First-pass Visual Acceptance, segmented by Treatment Preset and paired with preview-to-export completion, Treatment override rate, render latency, image cost and relevant support-ticket recurrence. Successful Scene Rerolls are already observable; Stock, upload and visibility replacements must also be recorded behind the scenes so every explicit rejection has the same measurement weight. Admin, team and QA activity never enters customer-demand or acceptance results.

Treatment V1 ships once to the full population already entitled to use AI B-roll rather than introducing customer-specific logic or a staged treatment experiment. Existing plan access, trial allowance and image pricing remain unchanged, and Stock-only creators are unaffected. Post-launch measurement is still segmented by real customer topic and treatment so broad availability does not erase the evidence needed for iteration.

The operational switch is a Treatment Emergency Stop, not a route back to the old generic behavior. It rejects new AI B-roll work that lacks a completed Treatment Pin before any image charge, offers the existing Stock path, and never changes AI Engine or compiles `ชัดเจนและเหมาะกับเนื้อหา`. Completed pins remain readable so already accepted work and eligible Scene Rerolls can recover; re-enabling planning admits new AI image work again.

The pinned treatment applies consistently to every Video Editor image tied to that Content Preflight: full AI B-roll, AI slots inside AutoMix and Scene Reroll. Stock-only output remains outside the promise, and standalone AI Studio keeps its creator-authored prompt behavior rather than being forced into the catalog. An Adaptive Brand Profile's Brand Look Preview continues to isolate and test stable brand identity with neutral standard scenes; only a profile that explicitly uses `ใช้แนวเล่าเรื่องเดิมทุกคลิป` previews its locked catalog option.
