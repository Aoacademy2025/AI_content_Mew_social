# Generated-image text policy

Date: 2026-08-10
Status: Accepted

Numbers and letters that are physically part of a depicted object — a banknote denomination, a coin
face, a price tag — are acceptable; they belong to the object, not to an overlay. Thai script in a
generated image is forbidden: the model produces authentic-looking Thai glyph forms that spell
nothing, which a Thai viewer reads as broken rather than as an intentional design choice. English
text is allowed, including full sentences, on the evidence that the model renders it correctly.
Readable copy the viewer must act on — anything a customer is meant to read and follow — still
belongs to the deterministic subtitle, headline and brand-mark layers regardless of what English
survives in a generated frame; permitting English in-image does not move that responsibility.

`z-image-turbo`, the model behind Hero AI Image and the Brand Visual System, is positive-only on
both of its provider routes: the public endpoint accepts a negative-prompt field and silently
ignores it, and the custom endpoint's workflow runs at `cfg: 1` with `ConditioningZeroOut` feeding
the sampler's negative input, carrying no negative-prompt token by design. A negative prompt
therefore cannot enforce this policy on the model that ships it. The policy is instead applied at
the Visual Beat request layer — the instructions that ask the model for a scene in the first place —
which is a mitigation, not a guarantee: it narrows what gets requested but cannot verify what gets
rendered. `{{NEGATIVE_PROMPT}}` remains genuinely live and consumed for the `comfy-workflow` engines
that do carry it.

Object-intrinsic numerals are not reliable: the same class of number rendered cleanly in one image
and illegibly in another. No feature may depend on a specific number being readable in a generated
image.

Scene locale continues to follow the story rather than the visual recipe, per ADR 0006; the `-v3`
recipes now honour that separation. See ADR 0005 for how a recipe version stays pinned once a Brand
Profile Revision compiles against it, and ADR 0006 for the rendering/scene boundary this policy
builds on.
