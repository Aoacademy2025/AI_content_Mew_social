# Image text policy — enforce what we actually promise

> Follow-up to `2026-08-10-brand-visual-storytelling-fix.md` (PR #212). Branches from that PR's head
> because it touches the same compiler.

## Problem

Two facts established on 2026-08-10, both verified against production code and real renders.

### 1. The text-free contract has never been enforced

`publicZImageProviderInput()` in `src/lib/runpod-image-contract.ts:42-55` builds the RunPod payload
from `{ prompt, size, seed, output_format, enable_safety_checker }`. It accepts `negativePrompt` in
its input type and **silently drops it**. That function is the only path every production
`z-image-turbo` call takes (`src/lib/runpod-serverless.ts:159-161`). Only the `comfy-workflow`
protocol consumes `{{NEGATIVE_PROMPT}}`.

So `TEXT_FREE_NEGATIVE_PROMPT_TERMS` — ~60 terms including `text`, `letters`, `logo`, `watermark`,
`screen text` — is computed on every call and thrown away. **CONTEXT.md's "Text-free AI Image"
guarantee and the 08-09 brief's "ภาพไม่มีตัวอักษร" rest on a no-op.** Generated images have mostly
been text-free because nothing asked for text, not because anything forbade it.

This also invalidates one justification given in PR #212: when the three unconditional guardrail
lines were removed, the stated reason was that their anti-text job "moves entirely to the negative
prompt". It does not. Removing them was still correct — they caused the reported storytelling bug,
and the nine proof renders carry no unwanted text — but the reasoning was wrong and is corrected here.

### 2. Z-Image renders English well and Thai as nonsense

Eight-image probe, `artifacts/image-text-probe-2026-08-10/`, `cinematic-realism-v3`, 9:16, real
provider path. Sheet: https://claude.ai/code/artifact/6fbd61b1-680e-4b3b-abbd-555b3585c4d2

| Case | Result |
|---|---|
| English, 1 word (`OPEN`) | Correct |
| English, 3 words (`WET FLOOR CAUTION`) | Correct, but the model added a second, unrequested illegible line nearby |
| English, 9 words (`THE FOOD DRIVE STARTS AT NINE ON SATURDAY MORNING`) | Every word correct and legible |
| Thai, 1 word (`เปิด`) | Real Thai glyph forms, not a real word |
| Thai, 5 words (`ลดราคาสินค้าทุกชิ้น`) | Rendered `สลดขลาสืนล้าทุดชื่น` — authentic-looking Thai, complete nonsense |
| Numerals on banknotes/coins | Illegible smears in this sample, though `finance-explain` in the PR #212 proof pack rendered a clean `500` |
| Mixed Thai + English signage | English correct, Thai nonsense, same frame |
| Control (negative terms "applied") | Identical failure to `mixed` — the payload was byte-identical, proving the ban is inert |

## Decisions (locked with Mew 2026-08-10)

1. **Numbers and letters intrinsic to a depicted object** — banknote denominations, coin faces, price
   tags — are **acceptable**. They are part of the object, not an overlay.
2. **Thai script in generated images is forbidden.** The model produces authentic-looking Thai that
   spells nothing; a Thai viewer reads it as broken.
3. **English text is allowed.** Evidence supports it, including full sentences.
4. Readable copy the viewer must act on still belongs to the deterministic subtitle / headline /
   brand-mark layers. Allowing English in-image does not move that responsibility.

**Superseded:** CONTEXT.md's **Text-free AI Image / ภาพไม่มีตัวอักษร** as an absolute, and the 08-09
brief's "ภาพ AI ทุกแนวใน V1 เป็นภาพไม่มีตัวอักษร".

**Reliability caveat to record, not to build on:** intrinsic numerals rendered cleanly once and
illegibly once. No feature may depend on a specific number being readable.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Establish whether RunPod Z-Image accepts a negative prompt, empirically | `mew-worker` | subagent | — | evidence read by session |
| 2 | Wire it or remove the dead path; apply the new text policy in the compiler | `mew-worker-heavy` | subagent | 1 | build + verify scripts, code review |
| 3 | Docs: ADR 0007, CONTEXT.md, brief supersede note | `mew-worker` | subagent | 2 | session review vs decisions |
| 4 | Image proof: Thai suppression works, English survives, storytelling unharmed | `mew-worker` | subagent | 2 | session eye, then Mew |

---

### Task 1 — Does the endpoint accept a negative prompt?

Empirical, not documentation-only. Submit the same seed and prompt to the live `z-image-turbo`
endpoint twice — once with a `negative_prompt` field in the payload, once without — using a prompt
whose output the term should visibly change. Try the field-name variants the provider may expect
(`negative_prompt`, `negativePrompt`). Record whether the endpoint rejects the field, ignores it, or
changes the image.

Deliver a plain answer: **accepted / ignored / rejected**, with the raw responses and the images.
Budget 6 images maximum.

### Task 2 — Implement

Branch on Task 1's answer:

- **If accepted:** thread `negativePrompt` through `publicZImageProviderInput` and make it real.
  Then the text policy lives in the negative list: drop the blanket English-suppressing terms
  (`text`, `letters`, `words`, `typography`, `legible writing`, `screen text`), keep the terms that
  protect the deterministic layers (`logo`, `watermark`, `signature`, `brand name`, `subtitle`,
  `caption`, `headline`), keep `numbers`/currency terms **off** the list per decision 1, and add
  Thai-specific terms (`Thai text`, `Thai script`, `Thai characters`, `Thai signage`, `ตัวอักษรไทย`).
- **If ignored or rejected:** delete the dead `negativePrompt` plumbing for the public Z-Image path
  rather than leaving a no-op that reads as a guarantee, and record in `ai-image-policy.ts` that this
  route is positive-only. Then Thai suppression must be expressed in the positive prompt.

**If you end up writing positive-prompt clauses, this is the dangerous part of the task.** The bug
PR #212 just fixed was caused by exactly this — anti-text guardrails written as positive art
direction ("walls and screens are plain empty solid color fields", "every circular motif is a solid
unmarked disc") that the model obeyed as composition instructions. Any clause you add must:
- name no object, prop or location that isn't already in the Visual Beat;
- survive the existing `verify-brand-visual-system.ts` story-first assertions;
- be justified in your report against the question "could a model read this as a thing to draw?"

Prefer the smallest possible intervention. If Thai cannot be suppressed without art-direction risk,
say so and propose handling it at the Visual Beat layer (`content-preflight.server.ts` already
instructs Gemini to produce text-free beats) instead of the compiler.

`-v1` and `-v2` recipes stay frozen. If the positive prompt changes for v3, bump to `-v4` and freeze
v3 the same way, per ADR 0005 — and extend the migration script.

### Task 3 — Docs

- `docs/adr/0007-generated-image-text-policy.md` — the four decisions, the reliability caveat, and
  the enforcement reality (which channel actually reaches the model).
- `CONTEXT.md` — redefine **Text-free AI Image / ภาพไม่มีตัวอักษร** to match: no Thai script, no
  synthesized brand marks or subtitles, English and object-intrinsic characters permitted. Link
  ADR 0007.
- `docs/plans/2026-08-09-brand-visual-system-product-brief.md` — extend the existing
  `## แก้ไขภายหลัง (2026-08-10)` section with this supersede.

### Task 4 — Image proof

Reuse `scripts/brand-visual-proof-pack.ts` conventions. Maximum 9 images:
- a Thai street/market scene under the new rules — no readable Thai may appear;
- a scene where English signage is natural — English may appear and should read correctly;
- the cyclone Hook/Explain/Close from PR #212's pack, re-rendered, to prove storytelling is unharmed.

Self-contained contact sheet at `artifacts/image-text-policy-2026-08-10/`, same standalone-HTML rules
as the previous two sheets (JPEG data URIs, content markup only, `<title>`, theme-aware tokens on
bare `:root` plus `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`
plus `:root[data-theme="dark"]`, responsive, under 12 MB). Thai copy must be proofread.

## Acceptance Criteria

- [ ] A plain, evidence-backed answer on whether the live Z-Image route accepts a negative prompt.
- [ ] No inert code path remains that reads as a text guarantee.
- [ ] Thai script does not appear readably in generated images, proven on a Thai-setting scene.
- [ ] English signage renders correctly and is not suppressed.
- [ ] Object-intrinsic numerals are not banned.
- [ ] The PR #212 storytelling fix still holds — cyclone renders weather, no circular motifs.
- [ ] `-v1`/`-v2` (and `-v3`, if a `-v4` is introduced) remain byte-identical.
- [ ] `npm run build`, `tsc --noEmit`, and the five brand verify scripts pass.
- [ ] CONTEXT.md no longer claims an absolute the system does not deliver.

## Out of scope

- Making intrinsic numerals reliable — recorded as a caveat only.
- Model-rendered Thai via a different engine (GPT Image via KIE) — still future work.
- Anything in `/brands` UI.

## Status

interviewed 2026-08-10 | approved: 2026-08-10 | executed: in progress | delivered: -
