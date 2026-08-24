# Full treatment matrix remains fail-closed after technical completion

Date: 2026-08-18
Status: Accepted evidence; release disposition superseded by ADR 0023

The approved public RunPod `z-image-turbo` qualification run completed all 120
cases in the 8 treatments × 5 active Visual Formats × 3 scenes matrix. All 120
artifacts are present at 720 × 1280, all hashes are distinct, and the run used
no automatic quality retry or engine fallback.

Technical completion does not qualify the visual system for release. Strict
original-resolution review found visible Hard Scene Fact failures across
Expert Clarity, Practical Documentary, Thai Human Drama, Premium Product
Lifestyle, Investigative News / Crime, Thai History / Period Storytelling, and
Thai Supernatural / Horror. It also found incidental gibberish lettering in a
Cinematic Realism frame. The full result therefore remains fail-closed.

The two safety boundaries remain intact. Medical frames stay illustrative and
do not supply clinically exact dosage, readings, treatment sequences or
authoritative anatomy. News frames do not identify a real person or present an
identifiable real person's conduct as evidence. The internal proper name
`Kong` is absent from provider prompts; the approved Entity Rendering
Description is used instead.

No image is regenerated automatically because of this review. The system does
not fall back to a generic treatment or a different AI Engine. The next
revision must preserve source qualifiers such as one shared bag and a drop onto
a fingertip inside structured Hard Scene Facts, propagate completed-result
staging to every active format that needs it, and constrain counted
compositions against background duplicates. Any focused paid probe or another
full matrix requires separate approval.

The detailed evidence and case identifiers are recorded in
`artifacts/brand-treatment-v10-qualified-matrix/review.md`; the immutable
technical record is
`artifacts/brand-treatment-v10-qualified-matrix/manifest.json`.
