---
name: mewshort
description: "Run Mew's internal Hero Story Film workflow from natural-language chat: start or resume one vertical short-film project, review gated artifacts, approve exact revisions, and repair selected B-roll scenes. Use for Hero Story Film production in this repo, not generic video editing or the public HeroAI MCP."
---

# Mewshort

Operate Hero Story Film as a conversation, not a command language. Keep one active project in the conversation and translate Mew's natural-language choices into the internal Story Film MCP.

Read [references/workflow.md](references/workflow.md) before starting, advancing, or repairing a project.

## Invariants

- One project produces one 9:16 clip no longer than 180 seconds.
- Use the separate internal Story Film MCP only. Never fall back to the public `create_video_job` tool.
- Presenter upload uses a one-time grant from `hero_story_film_create_presenter_upload`. Stream bytes to the returned Hero URL with `scripts/upload-story-film-presenter.mjs`; keep the short-lived token out of chat and logs.
- Grok subscription generation belongs to the internal worker lane; never call Grok directly from Studio or expose the subscription path publicly.
- Call `hero_story_film_read` before every decision. Copy the exact `projectId`, `stage`, and `revision` from that read.
- Never infer approval from silence, enthusiasm, or a prior gate. Return the Hero review link and stop for Mew's decision whenever an artifact is reviewable.
- If “โปรเจกต์ล่าสุด” resolves to several candidates, show the candidates and ask which one. Do not guess.
- Presenter-led uses Mew's uploaded lipsync video as A-roll and its audio as the Narration Master. Faceless uses the selected Hero/ElevenLabs voice; Mew's ElevenLabs workflow uses `eleven_v3`.
- A real recurring person requires a pinned Character Profile/reference set. Identity references persist; wardrobe and look remain project-specific.
- Preserve approved assets. A revision must invalidate only the requested scene/layer and its downstream dependency.

## Final Cut

Final Render has two distinct approvals:

1. At `renderSetup: true`, choose music and editorial settings, then `approve` to create a Final Preview.
2. Review the actual Final Preview. Use `render` only after Mew explicitly approves that file.

At Final Review, use `revise` with `sceneKeys` and `repairLayer` for visual defects. A music, subtitle, Headline, or text-only change must not regenerate visual assets. Story Film uses Hero Studio's shared Remotion subtitle/Headline engine while the internal MCP remains the control plane; never route the whole project through public `create_video_job`.

Prefer provider timing saved with the Narration Master. ElevenLabs v3 and Hero Voice provide timing directly; presenter uploads use the durable Gemini forced-alignment job. If alignment is unavailable or fails the exact-script quality gate, the render reports `storyboard_fallback`. Never claim fallback timing is word-accurate.

Report what changed, what stayed pinned, the current revision, and the review URL after every accepted decision.
