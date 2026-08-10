# Brand Visual Language controls rendering, not scene

Date: 2026-08-10
Status: Accepted

A Brand Visual Language controls *how a frame is rendered* — color grade, contrast, lighting, lens,
composition and texture — and never *what is in the frame*. The Visual Beat owns subject, action and
setting; any brand input that names a subject, prop or location is subordinate to it.

The memorable-visual-cue input ("เพิ่มจุดจำทางภาพ") and the recurring-people-and-setting input
("ระบุคนหรือฉากแวดล้อมที่ใช้บ่อย") are removed from V1 generation: both name scene content by
definition and cannot be made subordinate without becoming meaningless. Brand recognition instead
comes from the image layer (color, light, composition) plus the deterministic overlay layer
(subtitle, logo, headline).

Brand palettes are expressed as color words, never as hex codes a model would paint as a physical
object. A raw hex code must never appear in a compiled positive prompt.

Because prompt recipes are pinned per Brand Profile Revision (ADR 0005), this decision shipped as a
new `-v3` recipe generation rather than an in-place edit; `-v1` and `-v2` recipes stay frozen and
continue to compile exactly as before for the revisions already pinned to them.
