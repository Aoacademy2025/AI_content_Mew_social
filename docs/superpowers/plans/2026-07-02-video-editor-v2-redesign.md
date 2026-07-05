# Video Editor v2 Redesign — Decisions + Plan (grilled 2026-07-02)

Source design: `design_handoff_editor_redesign` (Google Drive zip, AO Academy / krisada).
Final screens: **5a** (สเต็ป 1 สคริปต์/ใช้คลิปเอง), **4a** (สเต็ป 2 องค์ประกอบ), **5b** (ระหว่างเรนเดอร์),
**4b** (สเต็ป 3 แต่งซับ + timeline). `Design System.dc.html` v1.1 = token source of truth.
Local copy: scratchpad `design_handoff/design_handoff_editor_redesign/` (README + 2 HTML) — **re-download from Drive if scratchpad is gone** (session-specific path).

See also: `CONTEXT.md` (glossary), `docs/adr/0001-editor-v2-background-pipeline-on-videojob.md`.

## Decisions (all resolved with Mew, 2026-07-02)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | **/video-editor only.** /video-creator untouched; merge/retire = later decision. |
| 2 | Rollout switch | **`NEXT_PUBLIC_EDITOR_V2` env default + per-person override** (query/localStorage) so Mew QAs v2 on prod before flipping for everyone. Old UI stays in the bundle as fallback. |
| 3 | Logic reuse | **Extract page.tsx logic into shared hooks** (behavior-preserving refactor PRs, old UI pixel-identical, deployable independently). v2 and v1 consume the same hooks — no fork, no drift. |
| 4 | Feature gaps in design | **Relocate, never delete.** Design hierarchy wins the default surface; everything else moves into "ตั้งค่าขั้นสูง" collapsibles at its natural location (avatar position, chroma, split mode, 17 presets, FPS/quality, …). |
| 5 | Timeline (4 tracks) | **Subtitle track fully editable** (port existing drag/snap/undo). Avatar / b-roll / music tracks = display + click-to-select/jump + open related settings. No new clip-editing backend. |
| 6 | Cutaway feature | **Launches WITH v2** (Mew's call — cutaway stays dormant until v2 ships; flip `NEXT_PUBLIC_EDITOR_V2` + `NEXT_PUBLIC_CLIP_CUTAWAY` together). v2 QA must include cutaway e2e. |
| 7 | Background render | **IN v2 scope** (per mockup: close tab, work continues). |
| 8 | BG architecture | **Extend VideoJob/orchestrator with preview mode** (spike-validated; see ADR 0001). NOT RENDER_VIA_QUEUE. Requires intent-sync with wao. |
| 9 | Launch order | **Server upgrade 8c/32GB FIRST, then flip v2.** Build proceeds in parallel on the flag. |
| 10 | Job-done notification | **In-app only** (draft remembers jobId → auto-resume; dashboard badge). No email/push in phase 1. |
| 11 | AI script chips ("ช่วยเขียน hook"/"ปรับให้กระชับ") | **Cut from v2, fast-follow** (needs new managed-Gemini endpoint + rate-limit/metering). UI reserves the spot behind a sub-flag. Segment drag-reorder (client-only) IS in v2. |

Defaults adopted without a fork (veto anytime):
- Fonts per design (Kanit + Noto Sans Thai), scoped to the editor.
- Desktop-first like today; don't regress current responsiveness. Design ref = 1200×800.
- v2 reads the existing localStorage `EditorDraft` format and `?resume=` param; drafts gain a `jobId` field.
- Old UI stays reachable (`?ui=v1`) for a few weeks after flip; delete later.
- Hook-extraction PRs merge+deploy continuously (small, build-verified), UI unchanged.
- Icons: Lucide line icons only, no emoji (design rule). 1 screen = 1 gradient button.

## Key reality-vs-mockup gaps found (drive the work items)

1. **"ปิดหน้าได้ งานทำต่อ" is the opposite of today** — pipeline is browser-orchestrated and
   `beforeunload` beacons `render-cancel`. → decision #7/#8.
2. Design shows ~⅓ of the real control surface (17 subtitle presets vs 4, avatar position
   canvas absent, split modes absent, render settings absent, credits UI absent…). → decision #4.
   Full inventory: session agent report 2026-07-02 (60+ items, per-area, with file:line).
3. Design's "ใช้คลิปที่ถ่ายเอง" card = the dormant cutaway mode + 2 more direct modes. → decision #6.
4. Rendering-screen checklist must map real stages (tts/captions/keywords/stock/config/render/avatar)
   → human-language steps (design lists 4).

## Phases

- **P0 — Skeleton.** Add `NEXT_PUBLIC_EDITOR_V2` switch + per-user override + empty v2 shell
  route-in-place. *(2026-07-02: Mew now runs the whole project solo — no wao sync needed.)*
- **P1 — Hook extraction (continuous).** Pull pipeline/state logic out of page.tsx into hooks,
  behavior-preserving, small PRs, deploy as they land. Old UI unchanged.
- **P2 — Design kit.** Editor-scoped tokens (colors/type/radius/glass), button tiers, cards,
  chips, step-indicator pill, segmented controls. From `Design System.dc.html` v1.1.
- **P3 — Setup phase (จอ 5a + 4a).** Step 1 script + mode cards + segment rail (drag reorder);
  step 2 four groups + advanced collapsibles + preview + single render CTA (quota caption from
  real plan data).
- **P4 — Backend preview mode.** Orchestrator preview branch + versioned `outputJson`
  (captions/config/voiceUrl/duration) + editor submits VideoJob + resume-by-jobId + in-app
  status/badge. Avatar composite included; interactive position adjust = Post-phase free
  re-composite.
- **P5 — Rendering screen (จอ 5b).** Glass panel + progress ring + humanized stage checklist
  fed by job stage/progress; cancel; close-tab-safe.
- **P6 — Post phase (จอ 4b).** Caption card list + subtitle controls (design defaults on top,
  advanced below) + 4-track timeline (sub track editable; others display/select) + Burn as
  "ส่งออกวิดีโอ".
- **P7 — QA + launch.** Mew's prod QA via override on all flows: script / cutaway / avatar
  bookend-both / burn / draft+job resume / quota+credit paths. Server upgrade 8c/32GB →
  flip `EDITOR_V2` + `CLIP_CUTAWAY` together. Rollback = flip back (no revert).

## Risks / guardrails

- **Minefields:** subtitle timing layers (tts-timing, split-script — fail-open rules in
  CLAUDE.md) and avatar composite guards. Hooks must move, not modify, this logic.
- **MCP path is live:** preview mode must be additive; MCP clients keep getting burned videos;
  `outputJson` readers accept old + new shapes.
- **Worker load:** web traffic joins mcp-video-worker → needs concurrency/fairness pass +
  heartbeat watchdog; safe once the 8c/32GB upgrade lands (decision #9 sequencing).
- **Ownership:** Mew runs the whole project solo (2026-07-02) — schema/ecosystem/deploy
  changes are hers to make; build-verify render-backend changes before merging (hygiene, not a gate).
