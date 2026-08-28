# Hero Story Film workflow

## Start

Use `hero_story_film_start` once with an idempotency key, approved Thai `narrativeSource`, and one presentation mode:

- `presenter_led`: requires an owner-scoped `presenterAssetId` created from the uploaded 9:16 lipsync video.
- `faceless`: requires `narrationProvider` and a voice. Prefer Mew's saved ElevenLabs clone when requested.

Use `characterProfileId` only when the story needs Mew or another recurring real person. Put wardrobe, era, and styling for this specific film in `characterLookBrief`.

### Presenter upload

When `presenter_led` starts from a local file and has no `presenterAssetId`:

1. Probe the file locally. Require a playable `mp4`, `mov`, or `webm`, 9:16, no longer than 180 seconds, no larger than 500 MB, with a narration audio stream.
2. Call `hero_story_film_create_presenter_upload` with the exact basename, MIME type, and byte count. The grant expires after ten minutes and is single-use.
3. Stream the file to the exact returned `uploadUrl` with `scripts/upload-story-film-presenter.mjs`. Supply `uploadToken` through `STORY_FILM_UPLOAD_TOKEN`; never print it or place it in the MCP arguments, URL, or project source.
4. Copy the returned `asset.id` into `hero_story_film_start.presenterAssetId`.

If the upload fails after the grant is claimed, create a fresh grant. The MCP receives metadata only; local paths and media bytes stay outside MCP calls.

## Gates

For every gate:

1. Call `hero_story_film_read`.
2. Give Mew the review URL and identify the exact stage/revision.
3. Wait for an explicit approve or repair instruction.
4. Call `hero_story_film_decide` with the exact values just read and a fresh idempotency key.
5. Read again and report the new state.

Use Visual QA before approving keyframes, videos, or a Final Preview:

- `anatomy`: hands, arms, faces, and people count are correct.
- `spatialDirection`: eyelines, monitor/screen direction, and spatial sides are correct.
- `continuity`: identity, wardrobe, setting, props, and lighting remain continuous.
- `generatedText`: generated signs, screens, interfaces, and legible text were checked.

## Decision targets

Music or Final Cut setup:

```json
{
  "musicSource": "user",
  "musicTrackId": "track-id",
  "editorial": {
    "subtitlesEnabled": true,
    "subtitleMode": "sentence",
    "subtitleStylePreset": "box-rounded",
    "subtitleTextEffect": "fade",
    "subtitlePosition": "bottom",
    "subtitleFontFamily": "Kanit",
    "headlineHook": {
      "enabled": true,
      "headline": "ประโยคที่ทำให้คนหยุดเลื่อน",
      "durationMs": 5000,
      "preset": "viral",
      "topPercent": 20,
      "fontFamily": "Kanit"
    },
    "textOverlays": [
      { "sceneKey": "scene-03", "text": "ข้อความสั้นที่ช่วยเล่าเรื่อง" }
    ]
  }
}
```

Final Review selective repair:

```json
{
  "sceneKeys": ["scene-03", "scene-17"],
  "repairLayer": "keyframe",
  "musicSource": "user",
  "musicTrackId": "track-id",
  "editorial": {
    "subtitlesEnabled": true,
    "subtitleMode": "sentence",
    "subtitleStylePreset": "box-rounded",
    "subtitleTextEffect": "fade",
    "subtitlePosition": "bottom",
    "subtitleFontFamily": "Kanit",
    "headlineHook": {
      "enabled": true,
      "headline": "ประโยคที่ทำให้คนหยุดเลื่อน",
      "durationMs": 5000,
      "preset": "viral",
      "topPercent": 20,
      "fontFamily": "Kanit"
    },
    "textOverlays": []
  },
  "visualQa": {
    "anatomy": true,
    "spatialDirection": true,
    "continuity": true,
    "generatedText": true
  }
}
```

Use `repairLayer: "keyframe"` for anatomy, composition, identity, wardrobe, props, text in the generated frame, or wrong screen direction. Use `repairLayer: "video"` only for a scene whose `mediaPlan` is `video` and whose defect is motion, camera movement, or temporal behavior.

For an editorial-only revision, omit `sceneKeys` and `repairLayer`; include the corrected music/editorial target and a precise instruction.

## Conversation examples

- “ทำเรื่องใหม่แบบ faceless ใช้เสียงมิว ElevenLabs v3” → gather/confirm the approved story source and start one project.
- “ต่อโปรเจกต์ล่าสุด” → read `latestEligible`; resume only when the result is unambiguous.
- “approve” → read first, state the gate/revision being approved, then decide only that gate.
- “scene 3 จอหันผิดฝั่ง” → at Final Review revise `scene-03` at the keyframe layer; preserve all other scenes.
- “เพลงไม่เข้า เปลี่ยนเพลงแต่ภาพเหมือนเดิม” → editorial-only Final Review revision; do not send scene keys.

Do not start a second project merely because the conversation continues in another coding client. Claude Code and Codex must both resolve and operate the same persisted Hero project.
