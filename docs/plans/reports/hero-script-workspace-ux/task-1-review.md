# Task 1 review — focused writing surface and retained workspace

Reviewed `8e7089f3..d1b052d7` against the approved Task 1 plan and package.

## Blocking findings

1. **[medium] Preference hydration can replace restored/current writing context.**
   `page.tsx:49-55` unconditionally applies local preferences whenever the profile request resolves, while `restoreScript()` sets a record's profile and duration at `page.tsx:74-91`. A delayed profile response after restoring a record replaces that record's context with the remembered new-writing defaults; the same timing can discard an early explicit duration selection. This violates the context/identity contract. Hydrate once for the authenticated account before edits/restores, and cover deferred identity/profile responses plus restore.

2. **[medium] Progressive workflow visibility was not implemented.**
   The page mounts Hook and full-script steps immediately (`page.tsx:129-131`). `HookStep` only disables its action for an empty topic, and `ScriptEditorStep` still renders its full heading and disabled primary action (`ScriptEditorStep.tsx:471-492`). The approved Task 1 behavior requires topic → Hook → full script progression and compact completed steps.

3. **[medium] The required behavioral evidence is absent.**
   `verify-hero-script-workspace.ts` tests only pure helper copies and storage parsing; it does not mount the tab shell or exercise real tab clicks, deferred preferences, profile fetches, revision-0/published controls, guide state, or keyboard accessibility. This does not meet the agreed scoped component-harness/red-first requirement. Existing `verify:hero-script` protects server/profile access behavior but not this client surface.

## Advisory

The source preserves the writing pane with `hidden`, and its native controls appear keyboard reachable, but no browser/component evidence verifies retained mounted state, 20-profile layout, or mobile/accessibility behavior. The unavailable in-app runtime is not itself a blocker; Task 4 remains the integrated browser gate.

## Verification

- `npx tsx scripts/verify-hero-script-workspace.ts` — pass
- changed-file ESLint — pass
- `npm run verify:hero-script` — 531 passed; access check passed
- `git diff --check 8e7089f3..d1b052d7` — pass

## Verdict

**BLOCK.** Resolve the two behavior gaps and add mounted behavioral coverage before Task 1 is accepted.
