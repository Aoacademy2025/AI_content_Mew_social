# HERO issue delivery and support close-out

Use this reference when implementing a `HERO-*` issue, preparing or verifying a deployment, or closing related customer tickets.

## Delivery state machine

| Observable event | Linear state |
|---|---|
| New signal awaiting correlation | `Triage` |
| Valid but intentionally unscheduled work | `Backlog` |
| Issue contract complete and unblocked | `Ready` |
| An owner has started investigation or implementation | `In Progress` |
| Pull request is open and ready for review | `In Review` |
| Fix is merged and awaits production release/verification | `Ready to Deploy` |
| Production deploy and symptom-specific smoke test pass | `Done` |

Do not use state changes as promises. Move the issue only after the corresponding event exists.

## Fix sequence

1. Read the Linear issue, linked support IDs, Sentry evidence, and repository instructions. Stop if the issue is `Mew-decision` or `Manual-action` and the required action is unresolved.
2. Correlate the claimed symptom with code and available evidence. If the root cause is unknown, diagnose before editing and keep the issue `In Progress` with a concise evidence comment.
3. Create the worktree through Orca as required by `CLAUDE.md`. Use a branch such as `mew/hero-123-short-slug`; never edit the root checkout.
4. Add a regression test or verification harness that fails for the observed defect when feasible. Implement the narrowest fix that satisfies the issue contract.
5. Run scoped checks, the regression verification, TypeScript checks, and the production build when the change can affect build/runtime behavior.
6. Open a pull request whose title contains `HERO-123`. Add the root cause, risk, test evidence, deployment notes, and rollback path to the PR and Linear issue.
7. After merge, move to `Ready to Deploy`. Production deployment remains Mew's explicit decision under the repository rules.
8. After an authorized deploy, verify the exact customer symptom and relevant Sentry release/group. Move to `Done` only after both are healthy.

Use [linear-api.md](linear-api.md) for guarded issue transitions, labels, and comments.

## Support close-out

Closing a ticket writes customer-visible state and can send both an in-app notification and email. Require explicit authorization for the exact ticket IDs and reply text.

Before apply:

- confirm the canonical Linear issue is `Done` or document why no code change was required;
- confirm production evidence covers the customer's symptom, not only a generic health check;
- draft a Thai reply that states what the customer can do now, avoids internal stack/provider details, and asks for the minimum useful follow-up if the symptom remains;
- use the existing idempotent `scripts/ops-close-*.ts` pattern: dry-run first, `RUN=1` only after authorization, fail closed on an unexpected existing reply/status;
- preserve `category`, `severity`, `recommendedAction`, `auditNote`, `impactNote`, `auditedAt`, `adminReply`, `repliedAt`, notification, and email verification.

Never close a ticket merely because a pull request merged. Never silently overwrite a human reply. Report email delivery failure separately; the database and in-app notification result must still be verified.

## Regression handling

If Sentry or support reports the same symptom after release:

- same root cause: reopen the canonical Linear issue and attach the new release/time-window evidence;
- different root cause: create a new issue and relate it to the earlier issue;
- uncertain: return to `Triage`, mark confidence `unknown`, and state the next discriminating check.
