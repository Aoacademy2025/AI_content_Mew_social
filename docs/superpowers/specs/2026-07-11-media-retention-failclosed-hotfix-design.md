# Media Retention Fail-Closed Hotfix Design

## Context

The cleanup graph currently lets expired `Video` and completed `VideoJob` references become cleanup candidates even when a non-archived `EditorProject` still points at those owners through `activeJobId`, `activeExportJobId`, or `latestVideoId`. The project loop only suppresses its draft-file fallback for matching pointer keys; it does not add a project-level live reference to those keys.

The same dry-run reports one aggregate `missingBeforeExpiry` count. That total mixes final playback media, other primary media, and reproducible derivatives, which prevents safe prioritization during review.

## Approved containment

1. A non-archived project adds an always-live `project-draft` reference to every canonical primary and derived key reached through an exact-owner match on any of its three media pointers.
2. Archived projects do not add this containment reference.
3. Cross-user or cross-project pointers remain graph errors and do not gain protection.
4. Missing live references are classified into exactly one of `critical`, `primary`, or `derived`:
   - `critical`: missing final playback output (`Video.videoUrl` or top-level `VideoJob.outputJson.videoUrl`).
   - `primary`: other missing canonical media that is not derived.
   - `derived`: normalized stock media or low-resolution render previews whose source key is present in the graph.
5. Public/admin health output contains only aggregate category counts. A private mode-0600 dry-run review artifact contains the read-only inventory with canonical key, category, owners, effective expiry, and optional source key. It contains no absolute path.
6. Existing `missingBeforeExpiry` remains for compatibility and equals the sum of the three categories.

## Data flow and safety properties

Reference metadata gains an optional `critical` marker. Duplicate references from the same owner merge conservatively, so a later discovery cannot discard `alwaysProtect` or `critical`. The cleanup planner computes the inventory from live graph references and filesystem observation only. The inventory is omitted from API summaries and metrics; only the private review artifact receives it.

The cleanup candidate manifest and its hash are unchanged in shape. This hotfix makes eligibility stricter but does not add a new mutation path. Dry-run remains read-only apart from its existing private metrics/review files.

## Alternatives considered

- Extending FREE retention from three to seven days would change product policy without resolving stale pointers after the new window, so it is not the containment fix.
- Reporting richer metrics without graph protection would leave active project media eligible for deletion.
- Protecting only the effective preview pointer would miss export-transition and latest-gallery media. All exact-owned pointers are protected instead.

## Verification

Tests cover non-archived protection for all pointer types and derived keys, archived behavior, owner mismatch, critical tagging, mutually exclusive category totals, sanitized metrics, private inventory shape and permissions, and dry-run immutability. Existing media safety verifiers, typecheck, and production build must remain green before opening the PR.
