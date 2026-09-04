# Support audit and Linear synchronization

Use this reference for Studio support-ticket audits, Sentry incident triage, deduplication, and explicit Linear synchronization.

## Sources and evidence

The first-party support source is Prisma `SupportTicket` in `prisma/schema.prisma`. The admin API in `src/app/api/admin/support/route.ts` exposes the current audit vocabulary and limits. Read those files before relying on cached field names.

Build the conclusion through this evidence ladder:

1. **Claim:** ticket text, timestamp, attachment, and affected feature.
2. **Account outcome:** relevant project, video, render job, payment, provider call, and durable database state.
3. **System evidence:** sanitized logs, Sentry group/release, timing, error class, and event counts.
4. **Reproduction:** a safe local or staging reproduction and a failing regression test when feasible.
5. **Resolution:** the fix is merged, deployed, smoke-tested, and no same-signature regression appears during the relevant observation window.

Do not promote a customer claim to a confirmed root cause without corroboration. State confidence as `confirmed`, `probable`, or `unknown`, and name the missing evidence.

Production access follows the repository's production rules. An audit request alone does not authorize SSH or database writes. Prefer existing artifacts and read-only local data; request explicit production access when the missing evidence requires it.

## Support disposition

Use the enums implemented by the admin API:

| Field | Values |
|---|---|
| `category` | `BUG_CONFIRMED`, `FEATURE_REQUEST`, `USER_CONFUSION`, `NEED_MORE_INFO`, `NOT_A_BUG` |
| `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `recommendedAction` | `FIX`, `ADD_FEATURE`, `NEED_MORE_INFO`, `WONT_FIX`, `MONITOR` |

Severity is impact, not emotion:

- `CRITICAL`: customer-blocking outage, incorrect billing, data loss, or a security boundary failure.
- `HIGH`: a core workflow is blocked for multiple customers or has no practical workaround.
- `MEDIUM`: a meaningful defect with a workaround or limited affected population.
- `LOW`: cosmetic, low-frequency, or low-impact behavior.

Audit every ticket into one of these outcomes:

- **Needs information:** leave the ticket open; record the exact evidence needed. Do not create an implementation-ready issue.
- **Not a bug / user confusion:** explain the observed behavior; create a Linear improvement only when repeated confusion demonstrates a product or documentation gap.
- **Monitor:** record the signature and threshold. Create no engineering issue until the threshold or risk policy is met.
- **Actionable bug or feature:** correlate with existing Linear/Sentry work, then propose creating or updating the canonical issue.
- **Duplicate:** link the ticket ID to the canonical issue's sanitized evidence list; do not create another implementation issue.

## Linear issue contract

For an actionable support finding, the Linear issue contains:

```markdown
## Customer impact
<sanitized impact; no identity or private content>

## Evidence
- Support ticket: `<internal-id>`
- Environment/release/time window: ...
- Sentry group or sanitized log signature: ...
- Root-cause confidence: confirmed | probable | unknown

## Reproduction
1. ...

## Expected / actual
...

## Acceptance criteria
- ...

## Verification and rollback
...
```

Apply one type and one area label. Add exactly one execution label when the next actor is known. Add risk labels whenever the work touches production, billing/security, or durable schema/data.

Map support findings conservatively:

| Support disposition | Linear action |
|---|---|
| Confirmed defect + `FIX` | `Bug`, normally `Triage`; `Ready` only when the issue contract is complete |
| Feature request + `ADD_FEATURE` | `Feature`, `Triage` or `Backlog` pending Mew's product decision |
| Repeated user confusion | `Improvement` when product work is justified |
| Needs more information | No new implementation issue; update an existing `Triage` issue only if one already owns the investigation |
| Not a bug / won't fix / monitor | No implementation issue unless a separately justified research or observability task exists |

Priority may be proposed from evidence. Apply it during sync only when Mew authorized the sync and the impact supports the mapping; raw event volume alone does not determine business priority.

## Audit output

For each ticket, report:

- internal ticket ID and age;
- disposition, category, severity, and recommended action;
- canonical Linear issue or `no issue`;
- root-cause confidence and compact evidence;
- missing evidence or next gate;
- proposed customer response status: `not drafted`, `drafted`, or `authorized to send`.

An **audit** stops with this report. A **sync** uses the guarded Linear CLI described in [linear-api.md](linear-api.md), previews every mutation, then applies only the authorized records.
