# Whole-branch final review package

Base: 4c2461805dcc2633675996a82ce391cfe706ff60
Candidate: aad67fbbe00e0923a6327f9413216649686600c0

Worker report and full56-command evidence: /Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-task5/docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5.md (task-5-verification.md adjacent).
Approved plan and prior independent reports are in the coordinator worktree. Final-gate-focus.md records prior advisories.

## Commits

aad67fbb test(mcp): verify approved media export and editor lifecycle
2430fab9 fix(mcp): settle refunded render funding mirrors atomically
16dfb9eb feat(mcp): reconcile spending receipts and guide source approval
f62f532a fix: reject stale web apply atomically at completion
2c47fa4f feat: enforce external media fulfillment across shared editors and export
23039d07 fix(mcp): ignore confirmed retired images when resuming completed retries
e9224268 fix(mcp): preserve budget holds across HTTP and guard original execution
bb28fe71 fix(mcp): retain render authority and resume known completed work
4509eb01 feat(mcp): enforce approved root budgets and retained resume checkpoints
2a8bbd7a fix(mcp): pin quote voice model and resolved music choices
e08b628f feat(mcp): prepare owner-scoped video quotes and Studio approval


## Diff stat

 .github/workflows/ci.yml                           |   2 +
 docs/ops/mcp-media-approval-rollout.md             |  34 ++
 .../task-1-approved.png                            | Bin 0 -> 60065 bytes
 .../task-1-external-mobile.png                     | Bin 0 -> 57330 bytes
 .../task-1-receipt-desktop.png                     | Bin 0 -> 64269 bytes
 .../task-1-red.txt                                 |  14 +
 .../task-1-rejected-mobile.png                     | Bin 0 -> 51146 bytes
 .../task-1-signed-out.png                          | Bin 0 -> 17654 bytes
 .../task-1-wrong-owner.png                         | Bin 0 -> 15755 bytes
 .../2026-10-13-mcp-media-source-budget/task-1.md   | 134 +++++++
 .../2026-10-13-mcp-media-source-budget/task-2.md   | 116 ++++++
 .../2026-10-13-mcp-media-source-budget/task-3.md   |  61 ++++
 .../2026-10-13-mcp-media-source-budget/task-4.md   |  94 +++++
 .../task-5-approve.png                             | Bin 0 -> 92486 bytes
 .../task-5-pr-body.md                              |   9 +
 .../task-5-pr-title.txt                            |   1 +
 .../task-5-rejected-mobile.png                     | Bin 0 -> 86564 bytes
 .../task-5-signed-out.png                          | Bin 0 -> 20506 bytes
 .../task-5-verification.md                         | 108 ++++++
 .../task-5-wrong-owner.png                         | Bin 0 -> 14437 bytes
 .../2026-10-13-mcp-media-source-budget/task-5.md   |  47 +++
 package.json                                       |   3 +-
 prisma/schema.prisma                               |  42 +++
 scripts/serve-mcp-video-quote-fixture.ts           |  66 ++++
 scripts/verify-broll-apply-recovery.tsx            |  24 +-
 scripts/verify-broll-rerender.ts                   |   8 +-
 scripts/verify-external-media-policy.ts            |  46 +++
 scripts/verify-external-web-upload.ts              |  51 +++
 scripts/verify-hero-image-namespace-guard.ts       |  22 +-
 scripts/verify-mcp-audit-status.ts                 |   2 +-
 scripts/verify-mcp-background-music.ts             |  12 +
 scripts/verify-mcp-broll-window-edits.ts           |  12 +
 scripts/verify-mcp-budget-orchestrator.ts          | 319 ++++++++++++++++
 scripts/verify-mcp-budget.ts                       | 234 ++++++++++++
 scripts/verify-mcp-chain-export.ts                 |  11 +-
 scripts/verify-mcp-chain-linkage.ts                |   2 +
 scripts/verify-mcp-ci-coverage.ts                  |   1 +
 scripts/verify-mcp-clip-import-job.ts              |  47 ++-
 scripts/verify-mcp-edit-draft.ts                   |  33 +-
 scripts/verify-mcp-edit-persist-export.ts          |  12 +
 scripts/verify-mcp-edit-tools.ts                   |  12 +
 scripts/verify-mcp-external-media.ts               | 300 +++++++++++++++
 scripts/verify-mcp-gemini-voice-style.ts           |  35 +-
 scripts/verify-mcp-image-parent-boundary.ts        |  41 +++
 scripts/verify-mcp-onboarding.ts                   |  14 +-
 scripts/verify-mcp-preview-frame.ts                |  13 +-
 scripts/verify-mcp-spending-summary.ts             | 246 +++++++++++++
 scripts/verify-mcp-stock-gate.ts                   |  20 +-
 scripts/verify-mcp-subtitle-style.ts               |  41 +--
 scripts/verify-mcp-tools.ts                        |   5 +
 scripts/verify-mcp-video-quote.ts                  | 149 ++++++++
 scripts/verify-video-options.ts                    |  22 +-
 src/app/(dashboard)/mcp/confirm/[quoteId]/page.tsx |  14 +
 .../mcp/confirm/[quoteId]/quote-confirmation.tsx   |  70 ++++
 .../video-editor/_v2/pending-edit-view.ts          |  38 +-
 .../video-editor/_v2/usePendingEditDraft.ts        |  10 +-
 .../video-editor/_v2/usePostPhaseEditor.ts         |  51 ++-
 src/app/api/[transport]/route.ts                   | 403 ++-------------------
 src/app/api/editor-projects/[id]/route.ts          |   9 +-
 src/app/api/mcp-quotes/[quoteId]/route.ts          |   6 +
 src/app/api/videos/broll-window/generate/route.ts  |   2 +
 src/app/api/videos/broll-window/upload/route.ts    |   7 +
 src/app/api/videos/fetch-stock/route.ts            |  66 +++-
 src/app/api/videos/jobs/route.ts                   |   3 +-
 src/app/api/videos/render/route.ts                 |  46 ++-
 src/app/api/videos/tts/route.ts                    |   7 +-
 src/lib/ai-generation-jobs.server.ts               |  18 +-
 src/lib/ai-image-reconcile.ts                      |  10 +-
 src/lib/broll-rerender.ts                          |   8 +-
 src/lib/editor-export-enqueue.ts                   |  19 +
 src/lib/external-media.server.ts                   | 100 +++++
 src/lib/external-media.ts                          |  53 +++
 src/lib/internal-ai-access.ts                      |   8 +-
 src/lib/mcp/billing-receipt.ts                     | 162 +++++++++
 src/lib/mcp/broll-source.ts                        |   7 +-
 src/lib/mcp/create-video-input.ts                  |  11 +
 src/lib/mcp/edit-tools.ts                          | 137 ++-----
 src/lib/mcp/onboarding.ts                          |  39 +-
 src/lib/mcp/orchestrator.ts                        |  62 +++-
 src/lib/mcp/pending-edit-draft.ts                  |  61 +++-
 src/lib/mcp/pipeline-client.ts                     |  15 +-
 src/lib/mcp/tools.ts                               |   7 +-
 src/lib/mcp/video-budget-admission.ts              |  66 ++++
 src/lib/mcp/video-budget-checkpoint.ts             | 173 +++++++++
 src/lib/mcp/video-budget.server.ts                 |  88 +++++
 src/lib/mcp/video-job-cancel-core.ts               |   3 +-
 src/lib/mcp/video-job-funding.ts                   |  21 +-
 src/lib/mcp/video-job-status.ts                    |   2 +-
 src/lib/mcp/video-job.ts                           |  46 ++-
 src/lib/mcp/video-options.ts                       |  15 +-
 src/lib/mcp/video-quote-browser-auth.server.ts     |  11 +
 src/lib/mcp/video-quote-http.ts                    |  42 +++
 src/lib/mcp/video-quote.server.ts                  | 206 +++++++++++
 src/lib/mcp/video-quote.ts                         | 105 ++++++
 src/lib/paid-equivalent-entitlement.server.ts      |  11 +-
 src/lib/pending-broll-media.ts                     |  26 ++
 src/lib/render-deploy-drain.ts                     |   2 +-
 src/lib/render/reservation-settlement.ts           |  74 ++--
 src/lib/video-hero-image.server.ts                 |  13 +
 src/lib/video-image-batch-settlement.ts            |   7 +
 100 files changed, 4080 insertions(+), 745 deletions(-)


## Paths

.github/workflows/ci.yml
docs/ops/mcp-media-approval-rollout.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-approved.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-external-mobile.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-receipt-desktop.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-red.txt
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-rejected-mobile.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-signed-out.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1-wrong-owner.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-1.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-2.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-3.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-4.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-approve.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-pr-body.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-pr-title.txt
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-rejected-mobile.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-signed-out.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-verification.md
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5-wrong-owner.png
docs/plans/reports/2026-10-13-mcp-media-source-budget/task-5.md
package.json
prisma/schema.prisma
scripts/serve-mcp-video-quote-fixture.ts
scripts/verify-broll-apply-recovery.tsx
scripts/verify-broll-rerender.ts
scripts/verify-external-media-policy.ts
scripts/verify-external-web-upload.ts
scripts/verify-hero-image-namespace-guard.ts
scripts/verify-mcp-audit-status.ts
scripts/verify-mcp-background-music.ts
scripts/verify-mcp-broll-window-edits.ts
scripts/verify-mcp-budget-orchestrator.ts
scripts/verify-mcp-budget.ts
scripts/verify-mcp-chain-export.ts
scripts/verify-mcp-chain-linkage.ts
scripts/verify-mcp-ci-coverage.ts
scripts/verify-mcp-clip-import-job.ts
scripts/verify-mcp-edit-draft.ts
scripts/verify-mcp-edit-persist-export.ts
scripts/verify-mcp-edit-tools.ts
scripts/verify-mcp-external-media.ts
scripts/verify-mcp-gemini-voice-style.ts
scripts/verify-mcp-image-parent-boundary.ts
scripts/verify-mcp-onboarding.ts
scripts/verify-mcp-preview-frame.ts
scripts/verify-mcp-spending-summary.ts
scripts/verify-mcp-stock-gate.ts
scripts/verify-mcp-subtitle-style.ts
scripts/verify-mcp-tools.ts
scripts/verify-mcp-video-quote.ts
scripts/verify-video-options.ts
src/app/(dashboard)/mcp/confirm/[quoteId]/page.tsx
src/app/(dashboard)/mcp/confirm/[quoteId]/quote-confirmation.tsx
src/app/(dashboard)/video-editor/_v2/pending-edit-view.ts
src/app/(dashboard)/video-editor/_v2/usePendingEditDraft.ts
src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts
src/app/api/[transport]/route.ts
src/app/api/editor-projects/[id]/route.ts
src/app/api/mcp-quotes/[quoteId]/route.ts
src/app/api/videos/broll-window/generate/route.ts
src/app/api/videos/broll-window/upload/route.ts
src/app/api/videos/fetch-stock/route.ts
src/app/api/videos/jobs/route.ts
src/app/api/videos/render/route.ts
src/app/api/videos/tts/route.ts
src/lib/ai-generation-jobs.server.ts
src/lib/ai-image-reconcile.ts
src/lib/broll-rerender.ts
src/lib/editor-export-enqueue.ts
src/lib/external-media.server.ts
src/lib/external-media.ts
src/lib/internal-ai-access.ts
src/lib/mcp/billing-receipt.ts
src/lib/mcp/broll-source.ts
src/lib/mcp/create-video-input.ts
src/lib/mcp/edit-tools.ts
src/lib/mcp/onboarding.ts
src/lib/mcp/orchestrator.ts
src/lib/mcp/pending-edit-draft.ts
src/lib/mcp/pipeline-client.ts
src/lib/mcp/tools.ts
src/lib/mcp/video-budget-admission.ts
src/lib/mcp/video-budget-checkpoint.ts
src/lib/mcp/video-budget.server.ts
src/lib/mcp/video-job-cancel-core.ts
src/lib/mcp/video-job-funding.ts
src/lib/mcp/video-job-status.ts
src/lib/mcp/video-job.ts
src/lib/mcp/video-options.ts
src/lib/mcp/video-quote-browser-auth.server.ts
src/lib/mcp/video-quote-http.ts
src/lib/mcp/video-quote.server.ts
src/lib/mcp/video-quote.ts
src/lib/paid-equivalent-entitlement.server.ts
src/lib/pending-broll-media.ts
src/lib/render-deploy-drain.ts
src/lib/render/reservation-settlement.ts
src/lib/video-hero-image.server.ts
src/lib/video-image-batch-settlement.ts


## Final correction candidate

Current head: `24a7b170239a81fde00694bb30857c1f92db5e94`. Previous package candidate is superseded by the Task5 round1 report. Independent correctness PASS at this head; approved additional security review is in progress.
