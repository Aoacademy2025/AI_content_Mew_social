# Task 2 review package

Base: 3d2c27a65a96f88435bc4e9df45c26b493df0b35
Head: f75ff386ae011873cba2733488cb0ee52e286c0f

```text
f75ff386 fix(cleanup): yield between apply objects (HERO-41)
 scripts/benchmark-media-local-eviction.ts       | 250 +++++++++++++++++++-----
 scripts/verify-media-local-eviction.ts          |   6 +-
 scripts/verify-media-local-missing-reconcile.ts |  27 +++
 src/lib/media-local-eviction.ts                 |  10 +-
 src/lib/media-local-missing-reconcile.ts        |  10 +-
 5 files changed, 240 insertions(+), 63 deletions(-)
scripts/benchmark-media-local-eviction.ts
scripts/verify-media-local-eviction.ts
scripts/verify-media-local-missing-reconcile.ts
src/lib/media-local-eviction.ts
src/lib/media-local-missing-reconcile.ts
```
