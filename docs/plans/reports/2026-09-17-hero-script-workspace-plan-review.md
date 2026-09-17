# Hero Script workspace plan review

Date: 2026-09-17

Deliverable: `docs/plans/2026-09-17-hero-script-workspace-ux.md`.

Independent fresh-context critic reviewed only the plan, confirmed decisions Q1–Q6, and acceptance criteria AC1–AC11. No application code was changed or executed as implementation.

## First review

Two blocking verification gaps:

1. Legacy revision-0 and published Brand Library profiles lacked an explicit fixture-level regression through the new compact management surface.
2. The pre-generation topic/Hook discard-and-cancel path lacked a behavioral test; autosave tests cannot cover a draft that has no Script row.

Advisory clarifications:

- Define the exact parallel library-component callback contract.
- Name the persisted search field instead of ambiguous “topic/title”.

## Revisions and second review

The plan now includes the profile fixtures and field/routing checks in Task 1, pre-generation cancel/discard/no-blank-row tests in Task 3, the temporary `ScriptLibrary` export with `onOpenScript(id)` seam, and the Prisma `Script.topic.contains` search definition.

Second critic verdict: **No remaining blockers.** The critic found executable coverage for AC1–AC11 and consistency with the agreed UI-first scope, owner boundaries, draft preservation and explicit handoff behavior.

This is a plan review, not production verification. User approval remains pending. The visual proposal uses fictional records; 20-brand/500-script scale verification is required during implementation, not claimed from the proposal.

## Proposal validation limit

The Browser runtime reported `No browser is available`; its documented discovery check returned an empty list. There is no connected browser in this session. The proposal therefore receives source/static checks only, and must not be described as having passed visual or browser interaction QA. The implementation plan requires those checks in its execution session.
