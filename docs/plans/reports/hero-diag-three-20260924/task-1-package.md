# Task 1 review package

Base 3d2c27a6
Head 9aec6657755dbea458d20f172e73b24377ae2b1a

```text
9aec6657 chore(db): split slow transaction phase timings (HERO-10)
 docs/ops/ops-guardrails-runbook.md          |  19 +-
 package.json                                |   2 +-
 scripts/fixtures/prisma-slow-tx-caller.ts   |  14 ++
 scripts/fixtures/prisma-slow-tx-disabled.ts |  15 ++
 scripts/fixtures/prisma-slow-tx-owner.ts    |   5 -
 scripts/verify-prisma-slow-tx.ts            | 314 +++++++++++++++++++++++++---
 src/lib/prisma-options.ts                   |  11 +-
 src/lib/prisma.ts                           |  41 +++-
 8 files changed, 361 insertions(+), 60 deletions(-)
docs/ops/ops-guardrails-runbook.md
package.json
scripts/fixtures/prisma-slow-tx-caller.ts
scripts/fixtures/prisma-slow-tx-disabled.ts
scripts/fixtures/prisma-slow-tx-owner.ts
scripts/verify-prisma-slow-tx.ts
src/lib/prisma-options.ts
src/lib/prisma.ts
```
