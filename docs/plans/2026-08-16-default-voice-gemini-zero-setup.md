# Default voice → Gemini + missing-key preflight in Editor v2

## Problem

A brand-new signup cannot render a single clip without buying an ElevenLabs
subscription first — the opposite of what the product's own onboarding promises.

The cause is a three-link chain, all of it live on `main`:

| # | Surface | Current behavior |
|---|---------|------------------|
| 1 | `prisma/schema.prisma:37` | `ttsProvider String? @default("elevenlabs")` — every new `User` row is stamped ElevenLabs |
| 2 | `src/app/api/user/video-settings/route.ts:22` | `user.ttsProvider ?? "elevenlabs"` — a second, independent ElevenLabs fallback for `NULL` rows |
| 3 | `_v2/useV2Project.ts:245,1404,1704` → `_v2/useV2Job.ts:306` | Editor v2 seeds `voiceEngine` from that account value and posts it as `voiceProvider` |

Result at `src/app/api/videos/jobs/route.ts:427`: HTTP 400
`"ต้องใส่ ElevenLabs API key ก่อน (Settings → API Keys)"`, then `:430`
`"ต้องระบุ ElevenLabs Voice ID"`.

This contradicts two places where the team already documented the intended
default:

- `src/lib/key-tiers.ts:42-47` — ElevenLabs is tier `advanced` with the label
  *"ไม่ใส่ก็ใช้งานได้ — ระบบใช้เสียง Gemini แทน"*
- `src/lib/mcp/onboarding.ts:104` — *`voiceProvider="gemini"` (ค่าเริ่มต้น)*

Gemini is the managed provider (`MANAGED_GEMINI=1` + `GEMINI_SERVER_KEY`,
resolved in `src/lib/gemini-key.ts:12`), so it needs zero setup. The stored
default is simply wrong.

Secondarily, Editor v2 has **no client-side key preflight at all** (v1 has one
at `video-editor/page.tsx:2814-2849`), so the user only discovers a missing key
as a raw error toast after pressing Render.

B-roll is **not** part of this defect: `_v2/useV2Project.ts:403` already
defaults `mixPreset: "free"` → `brollSource: "stock"` (free stock video/photo,
zero AI credits), and `:1747-1755` re-forces `"free"` for every non-internal-tester
account. Verified against `mix-presets.ts` and `kie-image-guards.ts:39`.

## Decisions taken in this session

- Scope = voice default + preflight. The Pexels/Pixabay BYOK requirement at
  `jobs/route.ts:438` stays as-is (see Out of scope).
- Backfill rewrites only accounts that never proved an ElevenLabs intent:
  `ttsProvider = 'elevenlabs' AND elevenlabsKey IS NULL/''` → `'gemini'`.
  An account holding an ElevenLabs key is treated as having chosen it.
- Preflight fires on the Render click and presents the existing
  `ApiKeyModal` (`src/components/ui/api-key-modal.tsx`), plus a
  "ใช้เสียง Gemini แทน (ฟรี)" action for the ElevenLabs case.

## Implementation note (mechanism for the preflight)

Do **not** re-implement the key rules on the client. `jobs/route.ts:424-440`
already runs every guard *before* it creates any `VideoJob`, and it answers
with `{ error: "missing_key", missingKey: "elevenlabs" | "broll" | "gemini" }`.
So the Render click reaches the server, gets a 400, and the client opens the
modal from `missingKey`. This keeps one source of truth and cannot drift from
the server, while still surfacing at exactly the moment Mew asked for.

`SubmitResult` (`_v2/useV2Job.ts:85-92`) already carries `code`/`provider`, and
`EditorV2Shell.handleSubmitResult` (`:145-150`) already branches on them for the
HeyGen quota alert — the missing-key branch follows that same shape.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Voice default → Gemini across DB / API / v1 UI + backfill + verify script | `mew-worker` | subagent | — | build, verify script, code review, `/security-review` |
| 2 | Editor v2 missing-key preflight modal + switch-to-Gemini action | `mew-worker` | subagent | — | build, code review |

Tasks 1 and 2 touch disjoint files and are dispatched together.

Branch: `mew/default-voice-gemini` cut from `main` (the current branch
`mew/hero-voice-emotion-rig` carries unrelated unmerged WIP; this fix must ship
independently). Per CLAUDE.md, open a PR into `main` — Mew merges and deploys.

---

### Task 1 — Voice default → Gemini (DB / API / v1 UI / backfill)

**Files**

1. `prisma/schema.prisma:37` — `ttsProvider String? @default("gemini")`
2. `src/app/api/user/video-settings/route.ts:22` — replace the literal fallback
   with `parseTtsProvider(user.ttsProvider)` from `@/lib/tts-providers`
   (it already defaults to `"gemini"` at `tts-providers.ts:13`). Removing the
   duplicated literal is the point — don't just swap the string.
3. `src/app/(dashboard)/video-creator/page.tsx:371` —
   `useState<"elevenlabs" | "gemini">("gemini")` (a hardcoded ElevenLabs initial
   state that flashes before `:543` hydrates from the account).
4. **New** `scripts/backfill-tts-provider-gemini.ts` — idempotent, prints the
   affected count before and after:
   ```
   UPDATE User SET ttsProvider = 'gemini'
   WHERE ttsProvider = 'elevenlabs'
     AND (elevenlabsKey IS NULL OR TRIM(elevenlabsKey) = '')
   ```
   Support `--dry-run` (default) and `--apply`, so it can be inspected on prod
   before it writes.
5. **New** `scripts/verify-default-voice-provider.ts` — follows the team's
   `verify-*.ts` pattern (throwaway SQLite via `tsx`, never `prisma/dev.db`).

**Deliberately NOT changed** — these already read correctly once the stored
default is `"gemini"`, and changing them would break users who genuinely chose
ElevenLabs:
- `src/app/api/videos/jobs/route.ts:426`
- `src/app/api/[transport]/route.ts:159`
- `src/lib/tts-providers.ts:30` (`resolveJobTtsProvider`)

**Verification the worker must run and paste**

- `npx tsx scripts/verify-default-voice-provider.ts` covering:
  - a fresh `User` row created with no explicit `ttsProvider` → reads back `"gemini"`
  - `ttsProvider = NULL` → `parseTtsProvider` → `"gemini"`
  - backfill on `('elevenlabs', elevenlabsKey = NULL)` → `"gemini"`
  - backfill on `('elevenlabs', elevenlabsKey = <set>)` → **unchanged**
  - backfill on `('gemini', …)` → unchanged; running it twice changes nothing
  - `resolveJobTtsProvider(undefined, "gemini")` → `"gemini"`;
    `resolveJobTtsProvider("elevenlabs", "gemini")` → `"elevenlabs"`
- `npx prisma db push` against a **throwaway** SQLite file, pasting the output.
  Deploy runs `prisma db push`; a SQLite default change rebuilds the table, so
  confirm it does not ask for `--accept-data-loss`. If it does, say so and stop —
  that changes the deploy story and is Mew's call.
- `npm run build`

---

### Task 2 — Editor v2 missing-key preflight

**Files**

1. `src/app/(dashboard)/video-editor/_v2/useV2Job.ts`
   - extend `SubmitResult` (`:85-92`) with `missingKey?: RequiredKeyType`
   - in both failure branches (`:361` create, `:441` export) map the response
     `d.missingKey` → the modal's key type. Server sends `"broll"` for the
     Pexels-or-Pixabay case (`jobs/route.ts:439`); map it to `"pexels"`, whose
     `ApiKeyModal` copy already reads *"ใช้สำหรับดาวน์โหลด Stock video"*.
     `RequiredKeyType` (`api-key-modal.tsx:7`) has no `"broll"` member — do not
     add one.
2. `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`
   - in `handleSubmitResult` (`:145`), before the generic `toast.error`, branch on
     `result.missingKey` → render `<ApiKeyModal keyType={…} onSaved={retry} />`
     following the existing `heygenQuotaAlert` shape
   - `onSaved` re-runs the same submit path the user was on (`handleRender` /
     `handleConfirmRender`), matching v1's `retryStep` behavior at
     `video-editor/page.tsx:5087-5092`
   - when `result.missingKey === "elevenlabs"`, the modal also offers
     **"ใช้เสียง Gemini แทน (ฟรี)"** → `p.setVoiceEngine("gemini")` then re-submit.
     Copy for that path, verbatim:
     > เสียง ElevenLabs ต้องใช้คีย์ของคุณเองและมีค่าใช้จ่าย — เสียง Gemini ใช้ได้ทันที ไม่ต้องตั้งค่า

**Constraints**

- Reuse `ApiKeyModal` as-is where possible. If the extra secondary action needs a
  prop, add an **optional** one; `video-creator/page.tsx:2520` and
  `video-editor/page.tsx:5084` must keep working untouched.
- Setup-phase create path only. The export/burn path needs no TTS or stock key;
  wire the mapping there only if the server can actually answer `missing_key`.
- No new key rules on the client — read `missingKey` off the response.

**Verification**

- `npm run build`
- Paste the reasoning for each mapped `missingKey` value against the server's
  actual emitters in `jobs/route.ts:428/435/439`.

---

## Acceptance Criteria

- [ ] `prisma/schema.prisma` `ttsProvider` default is `"gemini"`; no literal
      `"elevenlabs"` fallback remains in `api/user/video-settings/route.ts`
- [ ] A user row created with no explicit `ttsProvider` reads back `"gemini"`
      through `GET /api/user/video-settings`
- [ ] `POST /api/videos/jobs` with no `voiceProvider`, for an account with no
      saved default, does **not** return `missingKey: "elevenlabs"`
- [ ] Backfill: `elevenlabs` + no key → `gemini`; `elevenlabs` + key → unchanged;
      idempotent on a second run; `--dry-run` is the default
- [ ] MCP `create_video_job` with no `voiceProvider` resolves to Gemini
      (`api/[transport]/route.ts:159` reads the corrected stored default)
- [ ] Editor v2: a `missing_key` response opens `ApiKeyModal`, not a bare toast
- [ ] Editor v2: the ElevenLabs case offers "ใช้เสียง Gemini แทน (ฟรี)", which
      switches the engine and re-submits without a page reload
- [ ] `npm run build` passes
- [ ] `scripts/verify-default-voice-provider.ts` passes, output pasted
- [ ] `prisma db push` on a throwaway DB applies the default change without
      requesting `--accept-data-loss`, output pasted

## Out of scope

- **Managed Pexels/Pixabay server key.** Mew scoped it out this session. It
  would remove the last zero-setup blocker but changes the BYOK model in
  CLAUDE.md, needs an abuse cap and a shared-key ToS/rate-limit review, and
  deserves its own ADR.
- **Removing the ElevenLabs option.** It stays a selectable premium/cloning
  voice; only the *default* changes.
- **Restyling v1 Editor / video-creator.** Task 1 changes exactly one hardcoded
  initial state there; no other v1 work.
- **`geminiKeyMode` / any other `@default` in the schema.**

## Status

interviewed 2026-08-16 | approved: 2026-08-16 | executed: 2026-08-16 | delivered: PR pending merge

## Executed — deviations from the plan as written

Two surfaces were found during execution that the plan's three-link chain missed,
both the same defect class, both approved for inclusion by the owner mid-flight:

4. `src/lib/brand-profile-seed.ts` `currentBrandVoiceDefaults` — `input.ttsProvider || "elevenlabs"`
   → `parseTtsProvider(input.ttsProvider)`. Seeds a Brand Profile's voice default
   from the account (`api/brand-library/route.ts:130`).
5. `src/lib/brand-profile-seed.ts` `createBlankBrandProfileSeed` — `voice.provider`
   `"elevenlabs"` → `"gemini"`. This is the "create a new Brand" form draft
   (`BrandLibraryClient.tsx`), bound to the provider `Select` in
   `AdvancedSettings.tsx:563`, so the form opened pre-set to ElevenLabs.

Task 2 also gained one item beyond its file list: the server answers **two**
different causes with `error: "missing_voice_id"` and no discriminating field
(`jobs/route.ts:493` OmniVoice, `:514` ElevenLabs). The client dialog therefore
discriminates on the engine captured at failure time, not on the error string.

Not done, deliberately: `prisma db push` verification proved the SQLite default
change needs no `--accept-data-loss`, but the backfill itself has NOT been run on
production. It is `--dry-run` by default; run it with `--apply` after deploy.
