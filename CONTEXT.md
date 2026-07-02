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

## Rollout

- **Rollout Switch** — the two-layer mechanism controlling who sees Editor v2: an environment default for everyone plus a per-person override, so v2 can be QA'd on production before being enabled for all users.
