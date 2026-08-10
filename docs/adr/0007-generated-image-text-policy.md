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

A surface whose meaning depends on being read — a sign, banner, poster, screen or page — may be what
a scene is about when the story is genuinely about what it displays. The first implementation stated
the rule as a language-blind ban on such a surface ever being a scene's focal subject, which kept
Thai out but also cost the English signage a story may legitimately need, contradicting the decision
above. The rule is therefore stated as a writing system, not as a subject: lettering is requested in
English using the Latin alphabet, whatever language the source script is written in, and no other
writing system is described.

`z-image-turbo`, the model behind Hero AI Image and the Brand Visual System, is positive-only on
both of its provider routes: the public endpoint accepts a negative-prompt field and silently
ignores it, and the custom endpoint's workflow runs at `cfg: 1` with `ConditioningZeroOut` feeding
the sampler's negative input, carrying no negative-prompt token by design. A negative prompt
therefore cannot enforce this policy on the model that ships it. `{{NEGATIVE_PROMPT}}` remains
genuinely live and consumed for the `comfy-workflow` engines that do carry it.

Enforcement is therefore split in two, and the split matters:

- **Requested** at the Visual Beat layer — `content-preflight.server.ts` and
  `hero-image-scene-brief.ts` ask for English beat fields and English lettering. This is a
  mitigation, not a guarantee: it narrows what gets asked for but cannot verify what comes back.
- **Enforced** at the prompt boundary — `latinLetteringOnly()` in `image-prompt-script.ts` strips
  non-Latin writing from every field on its way into a prompt, in `v3PositiveArtDirectionValue`
  (Brand Visual System) and `buildHeroImagePrompt` (Hero AI Image). A field left with no letter
  contributes nothing and its clause falls back to an English default, so stripping never leaves a
  dangling connector for the text encoder to interpret. This is the only veto a positive-only route
  allows, and it holds even when the planner ignores its instructions or is unavailable entirely —
  the fallback brief is otherwise seeded straight from Thai narration.

One channel is deliberately left alone: a prompt a person typed themselves in AI Studio. Thai there
is the user's intent, not a leak, and stripping it would leave the request with no subject at all.
Serving that case properly means translating the prompt, which is a separate feature.

Object-intrinsic numerals are not reliable: the same class of number rendered cleanly in one image
and illegibly in another. No feature may depend on a specific number being readable in a generated
image.

A sign asked for without its wording is a defect, not a neutral instruction. When a scene requests a
sign and does not say what it reads, the model invents lettering and gets it wrong — the
`defect-thai-beat` case in `artifacts/english-signage-2026-08-10/` asked for "a hand-painted shop
sign" with no words and rendered `TAKFN SICE AIT`. Quoting the exact English words is what makes the
lettering legible, which is why the instruction asks for the words and not merely for the language.

Scene locale continues to follow the story rather than the visual recipe, per ADR 0006; the `-v3`
recipes now honour that separation. See ADR 0005 for how a recipe version stays pinned once a Brand
Profile Revision compiles against it, and ADR 0006 for the rendering/scene boundary this policy
builds on.
