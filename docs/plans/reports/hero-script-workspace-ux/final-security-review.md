# Final security review — BLOCK

Baseline `8e7089f3..edb2fd09`; reviewed the approved plan, final package, Task 2/3 reports, `CONTEXT.md`, ADR 0008, and the changed library/detail/client handoff paths. No production mutation, external auth bypass, deploy, customer data, or sub-agent was used.

## Blocking finding

### High — an in-flight handoff does not own its workspace

High confidence. `ScriptEditorStep.tsx:450-506` starts the non-idempotent handoff but captures no script/workspace generation. Generate/regenerate controls and text inputs remain enabled while `sending` (`:557-603`), and New/open transitions remain available from `page.tsx:188-218,296-326`. On success the handler reads **current** `draftRef.current` and writes the returned project ID/status into it (`ScriptEditorStep.tsx:481-489`) before navigating.

Concrete reproduction: open fictional saved Draft A, hold `/generate`, start handoff for A, release generation so it installs new Draft B, then release handoff. The server project is created from saved A, while the client marks B as sent with A's project and navigates away; B can be lost. The same mismatch occurs if another record is opened while the handoff POST is held. This violates latest-text preservation and the rule that a response started for another script must not overwrite the current workspace. Make handoff mutually exclusive with generation/regeneration/edit/replacement or capture and validate the exact workspace token before finalization/navigation. Add held-response cases for generate/regen and New/open crossing handoff.

The correctness review separately records the one-shot save snapshot race and open-existing navigation that bypasses save/discard; those reinforce this same release boundary and should be fixed in the combined round.

## Security boundary results

- **PASS — library admission and ownership:** `requireHeroScriptUser()` runs before parsing/queries. Items, count, historical brand options, and linked-project availability are caller-scoped; a foreign brand filter returns indistinguishable zero results. Detail project availability uses the same owner predicate.
- **PASS — input/read boundary:** duplicate known parameters, invalid enums/integers, overlong search/brand input, oversized offsets, and `pageSize > 20` are rejected. Prisma receives structured predicates; GET performs only reads. Payloads exclude Hook/body/CTA, provider/customer identity data, and foreign project IDs.
- **PASS — gates and evidence:** handoff still uses the existing server owner/plan gate and atomic project/script transaction; quota/pricing/MAPC/schema behavior is unchanged. Telemetry adds no raw script text, and fixtures/evidence are fictional.
- **PASS — remembered preferences:** writing and guide keys include the account ID; stored profile IDs are revalidated against that account's available profiles, allowed durations are validated, and account-ID changes reset hydration/default refs. The small verifier covers separate account keys and unavailable-profile fallback. The mounted browser fixture stubs one account; it is not treated as real-auth evidence.

## Independent verification

- `npm run verify:hero-script-library` — PASS (500 owned rows, foreign owner/brand/project exclusion, gate-before-parse, bounded payload, read-only GET, pagination/filter behavior).
- `npx tsx scripts/verify-hero-script-workspace.ts` — PASS (account-scoped preferences and latest-only detail restore).
- Targeted `git diff --check` — PASS.

No advisory findings beyond the blocking handoff ownership defect.
