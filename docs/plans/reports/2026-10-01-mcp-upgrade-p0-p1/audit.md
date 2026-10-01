# HERO MCP upgrade audit — 2026-10-01

Code: origin/main `8c6560d2` (snapshot, read-only). Prod data: read-only SQL run by Mew via `!` (60-day window).
North star = MAPC (paying creators with ≥1 completed video / 30d). MCP is PRO/BUSINESS-only, so every MCP user is in that population.

## Mew's clip `cmuoikpho004klc1z90uccxtv` (2026-09-30 19:44 UTC)
- ElevenLabs, avatar bookend avatar_iv, automix, subtitleMode=sentence, position=top.
- 48 cards, text exact, timing provider_alignment, subtitleQa passed → text and timing are correct.
- Cause of "ตัดคำผิด": card length. MCP single-line budget = `maxCardCharsFor(80)` = 24 chars
  (`src/lib/mcp/orchestrator-steps.ts:140`), but sentence-mode cards run up to 46 chars
  (e.g. "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ"), so they wrap to 2 lines at font 80 / weight 900.
  Chromium then picks the wrap point (`renderSubtitle.tsx:358-362`, keep-all + word joiners only for short tokens).
  Inference: the splitter cannot split unspaced Thai runs. Not visually confirmed; grab a frame to confirm.
- Subtitle QA checks text and timing only, never line fit, so it passed.
- Font size cannot be changed: `buildBurnConfig` hard-codes DEFAULT_STYLE (size 80, Kanit 900, stroke)
  (`orchestrator-steps.ts:124-133, 253`). There is no input param and no post-render edit.
- Lead, unverified: inputJson avatarOffsetX=4 / Y=28 come from the saved preset, while the MCP schema caps them at ±2.
  This may be a units mismatch.

## Real MCP usage (60 d)
- 1,806 tool calls; 20 users created clips; 220 jobs ([customer] 62, [customer] 54, [customer] 33, [customer] 17).
- 9/20 creators are now FREE. 23 denied calls came from lapsed users who still tried to use MCP.
- 29 failed jobs (≈12%): **all errorCode NULL + generic "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"**. Last failure 08-30.
- create_video_job in-band refusals: 54 calls / 10 users. The reasons are not stored.
- Same script re-created: ~40/220 jobs (≈18%), e.g. [customer] ran 7 scripts ×3–6 each, [customer] ran 2 scripts ×3 in 20 min.
  Likely edit-by-regenerate (intent not proven).
- Agents send subtitleMode in 89% of creates (243/274) and position in 83%: subtitles are what users control most.
- geminiVoiceStyle was sent once and silently dropped (bug: `src/app/api/[transport]/route.ts:277`).
- userAgent is never recorded (all "?"), so the client cannot be identified. 0 support tickets mention MCP.

## Gaps vs web editor
MCP jobs have no projectId and no preview, so export/broll-rerender refuse them (`api/videos/jobs/route.ts:385-390`).
MCP clips are therefore dead ends: they cannot be edited in the web editor or via MCP.
The web editor has: caption edit, subtitle style/size/card length, headline hook, logo, layer toggles,
per-window B-roll swap/upload/AI reroll/trim, free re-render and free export, Hero Voice, region pref, clip count, cancel.

## Recommended scope (north-star ordered)
P0 make the first render right: Thai card-length enforcement for unspaced runs (shared core, affects web too)
  + line-fit QA + subtitle size/style params at create time; geminiVoiceStyle passthrough;
  real errorCode/reason/userAction on failed MCP jobs; record client name.
P1 every MCP job = EditorProject + preview + auto-export; return "open in web editor" link; cancel tool.
P2 edit tools: get_video_timeline, update_captions, set_subtitle_style (size), edit_broll_window,
  apply_broll_edits, export_video; preview frames (image content) so the agent can QA before telling the user.
P3 script from Style, Brand Visual, upload-by-URL.
Success metric: share of MCP jobs delivered with no same-script re-create within 24 h (baseline ≈82%);
  0 generic failures.
