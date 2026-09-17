# Task 1 fix round 2 review

Reviewed `311c7558..b1da15f0` against the remaining Task 1 blockers and the root ruling on stale drafts.

## Findings

No blocking findings.

`changeTopic()` now invalidates an out-of-context Hook before rendering, while the draft keeps `ScriptEditorStep` mounted with the required stale-context status. This preserves editable saved text without treating it as output for the replacement topic. The mounted fixture reproduces the clear-topic path, retains the edited draft, reselects a Hook, and confirms keyboard activation of both tabs preserves the current values.

The fixture also submits revision-0 legacy niche, audience, tone, banned-word, CTA, and analysis-note data, and observes the published-profile 409 route to `/brands`. The source keeps native summary/button/select controls; the keyboard tab path is now exercised directly.

## Verification

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — pass
- `git diff --check 311c7558..b1da15f0` — pass

The isolated fixture uses only local fictional responses; the integrated browser gate remains Task 4.

## Verdict

**PASS.** Prior Task 1 blockers are resolved for this scoped round.
