# Responsive Logo Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PRO/BUSINESS Logo Overlay to Video Editor v2 that is reusable at account level, independently configurable per project, exact between desktop/mobile preview and export, and optional so it does not add friction to first-video activation.

**Architecture:** Store normalized images as private, server-owned `BrandAsset` files and store only an asset id plus bounded scalar settings in the project draft. Browser previews fetch through an authenticated owner-checked image route. The export boundary resolves the untrusted asset id, verifies plan and ownership, copies an immutable random-named render snapshot, and queues only that trusted snapshot. One pure geometry module drives both browser preview and Remotion placement; the existing subtitle burn remains the single export render.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma/SQLite, Sharp, Remotion, Tailwind/CSS-in-JS, existing client telemetry and `tsx` verification scripts.

## Global Constraints

- Approved design is the source of truth: [2026-07-14-logo-overlay-responsive-design.md](../specs/2026-07-14-logo-overlay-responsive-design.md).
- Work in an isolated git worktree when implementation starts. Do not mix the pre-existing untracked files from `main` into feature commits.
- Keep Logo Overlay optional. Do not add a required modal, upload step, or validation before a user who has no enabled logo exports.
- Scope is Logo Overlay only. Do not add End Scene, animation, free drag, timeline ranges, multiple logos, or a Brand Library page.
- Eligibility is effective `plan === "PRO" || plan === "BUSINESS"`; a current PRO trial is eligible because the authenticated user resolves to PRO. A downgraded FREE account keeps saved config but cannot mutate it or export with it enabled.
- Do not store bytes, data URLs, raw paths, public URLs, or filenames in `EditorProject.draftJson`. The project stores only `assetId`, `enabled`, `position`, `sizePct`, and `opacity`.
- Never accept a client asset URL or filesystem path. The jobs route must turn `assetId` into a server-generated immutable snapshot before enqueueing.
- Keep logo order above the video and below subtitles. Do not alter the existing FREE HERO watermark policy.
- Existing projects and existing export payloads without `logoOverlay` must behave exactly as before. Only a genuinely new project may inherit the account default.
- Use Thai user-facing errors, explicit accessible labels, 44-by-44 px minimum mobile targets, safe-area padding, and the approved 360/375/390/430/768/1023/1024 responsive matrix.
- Add no new test framework. Use the repository's `tsx` verifier pattern, a temporary SQLite database, temporary asset roots, production build, and browser smoke checks.
- The current branch has a known unrelated `npx tsc --noEmit` failure at `src/app/api/payments/checkout/route.ts:129`. A feature pass means no new TypeScript errors and no error whose path is touched by this plan; do not repair that unrelated checkout issue in this branch.
- Every task ends with the named focused verification and a narrow commit. If a red step does not fail for the stated reason, stop and fix the test before implementation.

---

## File and Responsibility Map

| Responsibility | Files |
|---|---|
| Shared config, normalization, nine-anchor geometry | `src/lib/logo-overlay.ts`, `scripts/verify-logo-overlay.ts` |
| Database records and private file lifecycle | `prisma/schema.prisma`, `.gitignore`, `src/lib/brand-assets.server.ts`, `scripts/verify-brand-assets.ts` |
| Authenticated upload/default/metadata/image APIs | `src/app/api/user/brand-assets/route.ts`, `src/app/api/user/brand-assets/[id]/route.ts`, `src/app/api/user/brand-assets/[id]/image/route.ts`, `scripts/verify-brand-asset-api.ts` |
| Account deletion filesystem cleanup | `src/app/api/admin/users/[id]/route.ts`, `src/app/api/clerk-webhook/route.ts` |
| Project draft and account-default inheritance | `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`, `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`, `scripts/verify-logo-project-default.ts` |
| Client asset loading/upload/default mutations | `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`, `src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx` |
| Shared live preview layer | `src/app/(dashboard)/video-editor/_v2/LogoOverlayPreview.tsx` |
| Desktop tab UI | `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx` |
| Mobile actions and accessible sheet | `src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx`, `src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx`, `src/lib/mobile-sheet.ts`, `scripts/verify-mobile-sheet.ts` |
| Client export payload | `src/app/(dashboard)/video-editor/_v2/subtitle-style.ts`, `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts` |
| Server export trust boundary and snapshot retention | `src/lib/logo-export.server.ts`, `src/app/api/videos/jobs/route.ts`, `src/lib/media-reference-graph.ts`, `scripts/verify-logo-export.ts` |
| Trusted render input and layer order | `src/remotion/types.ts`, `src/remotion/SubtitleOverlayComposition.tsx`, `src/app/api/videos/render/route.ts`, `src/app/api/renders/[filename]/route.ts`, `scripts/verify-logo-render.ts` |
| Product telemetry | `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`, `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts`, `src/lib/mcp/orchestrator.ts` |
| Final regression and responsive QA | existing verifiers, `npm run build`, desktop/mobile browser matrix, one real transparent-logo export |

---

### Task 1: Define the shared Logo Overlay contract and geometry

**Files:**

- Create: `src/lib/logo-overlay.ts`
- Create: `scripts/verify-logo-overlay.ts`

**Public contract:**

```ts
export const LOGO_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;

export type LogoPosition = (typeof LOGO_POSITIONS)[number];

export type LogoOverlayConfig = {
  enabled: boolean;
  assetId: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
};

export type LogoIntrinsicSize = { width: number; height: number };
export type LogoFrame = { left: number; top: number; width: number; height: number };
export type BrandAssetView = {
  id: string;
  displayName: string;
  mimeType: "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  imageUrl: string;
};

export const DEFAULT_LOGO_POSITION: LogoPosition = "top-right";
export const DEFAULT_LOGO_SIZE_PCT = 18;
export const DEFAULT_LOGO_OPACITY = 0.9;
export const MIN_LOGO_SIZE_PCT = 8;
export const MAX_LOGO_SIZE_PCT = 35;
export const MIN_LOGO_OPACITY = 0.2;
export const MAX_LOGO_OPACITY = 1;

export function normalizeLogoOverlayConfig(value: unknown): LogoOverlayConfig | null;
export function logoOverlayFrame(input: {
  position: LogoPosition;
  sizePct: number;
  intrinsic: LogoIntrinsicSize;
  frameWidth: number;
  frameHeight: number;
  safeInsetPct?: number;
}): LogoFrame;
```

`safeInsetPct` defaults to `4`, expressed as a percentage of video width and applied equally to all physical edges. `sizePct` is logo width as a percentage of video width. Height preserves the intrinsic aspect ratio. If that height would exceed the frame after safe insets, scale width and height down together. Geometry returns pixel units in the target frame so both preview and Remotion execute the same calculation.

- [ ] Create `scripts/verify-logo-overlay.ts` first. Assert defaults, rejection of blank `assetId`, invalid-position normalization to top-right, size/opacity clamping, all nine anchor coordinates in a 1080-by-1920 frame, wide/tall/square aspect preservation, and containment inside the safe frame.
- [ ] Run `npx tsx scripts/verify-logo-overlay.ts`. Expected red result: module `@/lib/logo-overlay` cannot be found.
- [ ] Implement the constants, types, clamping, defensive finite-number handling, and geometry in `src/lib/logo-overlay.ts`. Keep this module free of React, DOM, Node filesystem, Next.js, and Remotion imports.
- [ ] Use this anchor rule exactly:

```ts
const inset = frameWidth * (safeInsetPct / 100);
const x = position.endsWith("left") ? inset
  : position.endsWith("right") ? frameWidth - inset - logoWidth
  : (frameWidth - logoWidth) / 2;
const y = position.startsWith("top") ? inset
  : position.startsWith("bottom") ? frameHeight - inset - logoHeight
  : (frameHeight - logoHeight) / 2;
```

- [ ] Run `npx tsx scripts/verify-logo-overlay.ts`. Expected green result: `logo-overlay: all checks passed`.
- [ ] Commit:

```bash
git add src/lib/logo-overlay.ts scripts/verify-logo-overlay.ts
git commit -m "feat: add shared logo overlay geometry"
```

---

### Task 2: Add durable private brand assets and account preferences

**Files:**

- Modify: `prisma/schema.prisma`
- Modify: `.gitignore`
- Create: `src/lib/brand-assets.server.ts`
- Create: `scripts/verify-brand-assets.ts`

**Schema:**

Add `brandAssets BrandAsset[]` and `brandPreference BrandPreference?` to `User`, and `brandAssets BrandAsset[]` to `EditorProject`. Add these models:

```prisma
model BrandAsset {
  id              String           @id @default(cuid())
  userId          String
  user            User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId       String?
  project         EditorProject?   @relation(fields: [projectId], references: [id], onDelete: SetNull)
  storageKey      String           @unique
  originalName    String
  mimeType        String
  sizeBytes       Int
  width           Int
  height          Int
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
  defaultFor      BrandPreference? @relation("DefaultBrandAsset")

  @@index([userId, createdAt])
  @@index([projectId])
}

model BrandPreference {
  userId         String     @id
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  defaultAssetId String     @unique
  defaultAsset   BrandAsset @relation("DefaultBrandAsset", fields: [defaultAssetId], references: [id], onDelete: Cascade)
  position       String     @default("top-right")
  sizePct        Float      @default(18)
  opacity        Float      @default(0.9)
  enabled        Boolean    @default(true)
  updatedAt      DateTime   @updatedAt
}
```

**Server service contract:**

```ts
export class BrandAssetError extends Error {
  code: "plan_required" | "project_not_found" | "unsupported_type" |
    "payload_too_large" | "empty_file" | "corrupt_image" |
    "dimensions_too_large" | "asset_not_found" | "asset_in_use" |
    "invalid_config" | "rate_limited";
  status: number;
}

export function canUseLogoOverlay(plan: string): boolean;
export function tryConsumeBrandAssetUpload(userId: string, now?: number): boolean;
export async function saveBrandAsset(input: {
  userId: string;
  plan: string;
  projectId: string;
  file: File;
}): Promise<BrandAssetView>;
export async function getOwnedBrandAsset(userId: string, assetId: string): Promise<BrandAssetView | null>;
export async function getBrandAssetPath(userId: string, assetId: string): Promise<string | null>;
export async function getDefaultBrandPreference(userId: string): Promise<{
  asset: BrandAssetView;
  config: LogoOverlayConfig;
} | null>;
export async function setDefaultBrandPreference(input: {
  userId: string;
  plan: string;
  assetId: string;
  config: LogoOverlayConfig;
}): Promise<void>;
export async function deleteBrandAssetIfUnreferenced(userId: string, assetId: string): Promise<boolean>;
export async function listBrandAssetPathsForUser(userId: string): Promise<string[]>;
export async function removeBrandAssetFiles(paths: readonly string[]): Promise<void>;
```

- [ ] Add the schema and `/data/brand-assets/` to `.gitignore`.
- [ ] Generate and validate the schema against a disposable database:

```bash
npx prisma generate
rm -f /tmp/heroai-logo-model.db
DATABASE_URL=file:/tmp/heroai-logo-model.db npx prisma db push --skip-generate --accept-data-loss
```

Expected: SQLite database synchronized without a Prisma relation error.

- [ ] Create `scripts/verify-brand-assets.ts` before the service. The script must set `BRAND_ASSET_ROOT` to a unique directory under `/tmp`, create two users and two projects, and generate PNG/JPEG/WebP fixtures with Sharp rather than committing binary fixtures.
- [ ] Cover: PRO and BUSINESS acceptance; FREE rejection; extension/MIME/decoded-format disagreement; zero bytes; 5 MB limit; corrupt bytes; 4097 px rejection; EXIF rotation; longest-edge reduction to 2048; alpha preserved after normalized WebP; random server storage key; project ownership; asset ownership; default upsert; default preference blocking asset deletion; project-draft reference blocking delete; and post-user-delete filesystem cleanup removing every captured owned file.
- [ ] Run:

```bash
DATABASE_URL=file:/tmp/heroai-logo-model.db \
BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-red \
npx tsx scripts/verify-brand-assets.ts
```

Expected red result: module `@/lib/brand-assets.server` cannot be found.

- [ ] Implement `src/lib/brand-assets.server.ts` with `runtime = node` compatible dependencies only. Default the root to `path.join(process.cwd(), "data", "brand-assets")`; allow `BRAND_ASSET_ROOT` for tests and deployment configuration.
- [ ] Enforce PNG/JPEG/WebP extension and declared MIME before decode. Verify `sharp(fileBytes).metadata().format` agrees with that pair. Reject either decoded dimension above 4096 before resizing. Store `originalName` only as a display label after stripping control characters and truncating to 120 characters.
- [ ] Normalize with:

```ts
const normalized = await sharp(bytes, { failOn: "error" })
  .rotate()
  .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
  .webp({ lossless: true })
  .toBuffer({ resolveWithObject: true });
```

Store under `${userId}/${randomUUID()}.webp`, create directories recursively, and persist only the relative server-generated key. Never concatenate a client filename into a path.
- [ ] Write the normalized bytes to a same-directory random temporary file, rename atomically to the final server key, and create the DB row. If rename or DB creation fails, remove both temporary/final files before rethrowing so failed uploads do not leave usable orphan assets.
- [ ] Implement a 20 uploads/user/hour in-process sliding window with an exported clock argument for deterministic tests. Consume the rate slot after authentication/plan/project checks and before Sharp decode. Project validation requires matching owner and `status !== "archived"`.
- [ ] Parse all `EditorProject.draftJson` values structurally when checking references. A logo asset is in use only when `draft.logoOverlay.assetId === assetId`, not merely when a JSON string contains the id. When saving an account default, require `config.assetId === assetId` after normalization.
- [ ] Delete a DB row first only after proving it is neither the account default nor referenced by any project; then unlink its normalized file. If unlink reports `ENOENT`, treat cleanup as already complete. `listBrandAssetPathsForUser` returns only resolved descendants of the configured brand root; `removeBrandAssetFiles` rejects any path outside that root.
- [ ] Re-run the brand asset verifier with a fresh database/root. Expected green result: `brand-assets: all checks passed`.
- [ ] Commit:

```bash
git add prisma/schema.prisma .gitignore src/lib/brand-assets.server.ts scripts/verify-brand-assets.ts
git commit -m "feat: persist private brand logo assets"
```

---

### Task 3: Expose owner-checked brand asset APIs and account deletion cleanup

**Files:**

- Create: `src/app/api/user/brand-assets/route.ts`
- Create: `src/app/api/user/brand-assets/[id]/route.ts`
- Create: `src/app/api/user/brand-assets/[id]/image/route.ts`
- Create: `scripts/verify-brand-asset-api.ts`
- Modify: `src/app/api/admin/users/[id]/route.ts`
- Modify: `src/app/api/clerk-webhook/route.ts`

**HTTP contract:**

```text
GET    /api/user/brand-assets
       -> { eligible, defaultLogo: { asset, config } | null }

POST   /api/user/brand-assets   multipart(file, projectId)
       -> 201 { asset }

GET    /api/user/brand-assets/:id
       -> { asset }

PATCH  /api/user/brand-assets/:id
       body { setAsDefault: true, enabled, position, sizePct, opacity }
       -> { ok: true, defaultLogo }

DELETE /api/user/brand-assets/:id
       -> { deleted: true } or 409 asset_in_use

GET    /api/user/brand-assets/:id/image
       -> owner-checked image/webp bytes
```

Read endpoints remain available after downgrade so a FREE user can see the saved-but-locked selection. POST, PATCH, and DELETE require PRO/BUSINESS. The server must run `normalizeLogoOverlayConfig` for PATCH, return `400 invalid_config` for a missing/blank asset id, and clamp finite size/opacity values to the shared bounds.

- [ ] Create `scripts/verify-brand-asset-api.ts` around exported route-independent helpers: map each `BrandAssetError` to the exact status/error/message payload, verify content-length rejection above `5 MB + 256 KB` before `formData()`, verify read access is owner-only but not plan-gated, verify FREE mutations are 403, and verify cross-user metadata/image/delete/default operations are 404.
- [ ] Run the script. Expected red result: at least one API/helper import is missing.
- [ ] Implement the collection route. Catch malformed multipart bodies as `400 invalid_body`; return `413 payload_too_large`, `415 unsupported_type`, `422 corrupt_image`/`dimensions_too_large`, `429 rate_limited`, and localized Thai `message` values from the typed service error.
- [ ] Implement the item route. `GET` returns metadata only. `PATCH` accepts only `setAsDefault: true` plus normalized config. `DELETE` returns 409 rather than silently leaving a referenced file.
- [ ] Implement the image route using a Node read stream after `getBrandAssetPath(user.id, id)`. Send:

```ts
{
  "Content-Type": "image/webp",
  "Cache-Control": "private, max-age=3600",
  "X-Content-Type-Options": "nosniff",
}
```

Do not reveal `storageKey` or the absolute path in JSON, headers, logs, or errors.
- [ ] In both hard-delete paths, call `listBrandAssetPathsForUser(id)`, perform the existing Prisma user delete (which cascades records), then call `removeBrandAssetFiles(paths)` as best-effort cleanup. If the DB delete fails, do not unlink. A Clerk retry after files have already disappeared must still return success.
- [ ] Re-run:

```bash
rm -f /tmp/heroai-logo-api.db
DATABASE_URL=file:/tmp/heroai-logo-api.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-logo-api.db \
BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-api \
npx tsx scripts/verify-brand-asset-api.ts
```

Expected green result: `brand-asset-api: all checks passed`.

- [ ] Commit:

```bash
git add src/app/api/user/brand-assets src/app/api/admin/users/'[id]'/route.ts src/app/api/clerk-webhook/route.ts scripts/verify-brand-asset-api.ts
git commit -m "feat: add authenticated brand asset APIs"
```

---

### Task 4: Persist project logo config and inherit defaults only for new projects

**Files:**

- Modify: `src/lib/logo-overlay.ts`
- Create: `scripts/verify-logo-project-default.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`

Add this pure helper so initialization policy is verifiable without mounting React:

```ts
export function logoOverlayForNewProject(input: {
  hasExistingDraft: boolean;
  accountDefault: LogoOverlayConfig | null;
}): LogoOverlayConfig | undefined {
  return input.hasExistingDraft || !input.accountDefault
    ? undefined
    : { ...input.accountDefault };
}
```

- [ ] Write `scripts/verify-logo-project-default.ts` first. Cover: account default copied for a blank new project; no default means no key; local draft never gets backfilled; server project draft never gets backfilled; returned config is a copy; legacy draft parsing still succeeds when `logoOverlay` is absent.
- [ ] Run `npx tsx scripts/verify-logo-project-default.ts`. Expected red result: `logoOverlayForNewProject` is not exported.
- [ ] Implement the helper and export `LogoOverlayConfig` for client use.
- [ ] Extend `V2Draft` with `logoOverlay?: LogoOverlayConfig`, add `logoOverlay` React state, normalize it inside `applyDraft`, include it in `buildDraft`, reset it, include it in the one-second autosave dependencies, and expose `logoOverlay`, `setLogoOverlay`, and `canUseLogoOverlay` from `useV2Project`. Derive eligibility into a local `logoEligible` binding, then expose it as `canUseLogoOverlay: logoEligible` so it does not shadow the imported pure function.
- [ ] Add `loadAccountLogoDefault(): Promise<LogoOverlayConfig | null>` in `useV2Project.ts`, backed by `GET /api/user/brand-assets`. Treat non-OK/network responses as no default and do not block editor bootstrap.
- [ ] Preserve this exact initialization decision:

```ts
const hasLocalDraft = Object.keys(localDraft).length > 0;
const seedDraft = hasLocalDraft ? localDraft : buildDraft();
if (!hasLocalDraft) {
  const accountDefault = await loadAccountLogoDefault();
  const inherited = logoOverlayForNewProject({ hasExistingDraft: false, accountDefault });
  if (inherited) seedDraft.logoOverlay = inherited;
}
```

When a server project id exists and loads successfully, apply only its draft. Do not call the default endpoint to fill a missing key. A local draft also counts as existing work and is not backfilled.
- [ ] Extend `saveStatus` to `"idle" | "saving" | "saved" | "error"`. Treat a non-2xx draft PATCH or a fetch rejection as `error`, add `retryProjectSave()` using a `saveRevision` state counter in the autosave effect dependencies, and expose both values. Update the existing `SaveStatus` presentation in `EditorV2Shell` so `error` reads `ยังไม่ได้บันทึก` and provides a retry button.
- [ ] Make `resetProject` async. Fetch the default before constructing the fresh draft, set `logoOverlay` to the copied default or `undefined`, apply all default React state, then call `createServerProject(nextDraft)`. Keep failure non-blocking.
- [ ] In `EditorV2Shell.handleNewProject`, change the call to `void p.resetProject()` before moving to step 0. Pass `projectId`, `logoOverlay`, `onLogoOverlayChange={p.setLogoOverlay}`, `logoEligible={p.canUseLogoOverlay}`, `projectSaveStatus={p.saveStatus}`, and `onRetryProjectSave={p.retryProjectSave}` into both post-phase variants.
- [ ] Run:

```bash
npx tsx scripts/verify-logo-project-default.ts
npx tsx scripts/verify-editor-projects.ts
```

Expected: both scripts pass, including legacy project draft behavior.

- [ ] Commit:

```bash
git add src/lib/logo-overlay.ts scripts/verify-logo-project-default.ts 'src/app/(dashboard)/video-editor/_v2/useV2Project.ts' 'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx'
git commit -m "feat: persist per-project logo settings"
```

---

### Task 5: Secure the export boundary and retain immutable logo snapshots

**Files:**

- Create: `src/lib/logo-export.server.ts`
- Create: `scripts/verify-logo-export.ts`
- Modify: `src/app/api/videos/jobs/route.ts`
- Modify: `src/lib/media-reference-graph.ts`

**Trust boundary types:**

```ts
export type ClientLogoExportInput = {
  enabled: true;
  assetId: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
};

export type TrustedLogoRenderInput = {
  src: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
};

export async function stageLogoForExport(input: {
  userId: string;
  plan: string;
  projectId: string;
  rawLogoOverlay: unknown;
  rendersRoot?: string;
}): Promise<{ trusted: TrustedLogoRenderInput; snapshotPath: string } | null>;

export async function removeLogoSnapshot(snapshotPath: string): Promise<void>;
```

Snapshots live in `public/renders/logo-snapshot-${randomUUID()}.webp` and are referenced as `/api/renders/<filename>`. They are intentionally detached from the mutable private asset before the durable job is accepted. The 128-bit random name follows the security model already documented by `/api/renders/[filename]`.

- [ ] Create `scripts/verify-logo-export.ts` first with a temporary database, private brand root, and temporary workspace/public renders root supported by the `rendersRoot` option. Cover: absent logo returns `null`; disabled logo returns `null`; FREE enabled logo returns 403; PRO/BUSINESS success; foreign asset and foreign project return 404; missing asset returns a localized re-upload error; out-of-range scalars are clamped; arbitrary client `src`/path fields are ignored; snapshot bytes equal the normalized source at staging time; replacing/deleting the source later does not alter the snapshot; and cleanup after queue failure removes it.
- [ ] Run the verifier. Expected red result: module `@/lib/logo-export.server` cannot be found.
- [ ] Implement staging. Validate `projectId` from the source job, not from the browser request. Load the owned asset through `getBrandAssetPath`, copy to a random flat `.webp` name using `COPYFILE_EXCL`, and return only the trusted internal shape.
- [ ] In the durable export branch of `src/app/api/videos/jobs/route.ts`, read `logoOverlay` only from `body.subtitleOverlayConfig.logoOverlay`. Clone the subtitle object and delete `logoOverlay` from that clone before validation, so disabled/malformed client objects and arbitrary `src` fields can never be queued. If staging returns a trusted logo, add only that trusted object back; when the property is absent, the rest of the logo-free config remains unchanged.

  1. verify source job ownership/status/project as it already does;
  2. call `stageLogoForExport` with `srcJob.projectId` and authenticated `user.plan`;
  3. add `trusted` to the already-sanitized cloned subtitle config;
  4. enqueue that cloned config;
  5. remove the snapshot if create/update fails before the job is durable.

- [ ] Never enqueue `assetId`, `storageKey`, original filename, or the authenticated image URL. The worker input must contain only the random render URL and scalar/intrinsic values.
- [ ] Extend `buildMediaReferenceGraph` to query `inputJson` for queued/processing `VideoJob` rows and collect their canonical `/api/renders/` refs with `alwaysProtect: true`. This closes the gap while a durable export waits for the worker. Preserve the current done-job `outputJson` behavior.
- [ ] Add a verifier case that places a snapshot only in a queued job's `inputJson`, builds the media graph, and proves `renders/logo-snapshot-…webp` is protected.
- [ ] Run:

```bash
rm -f /tmp/heroai-logo-export.db
DATABASE_URL=file:/tmp/heroai-logo-export.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-logo-export.db \
BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-export \
npx tsx scripts/verify-logo-export.ts
```

Expected green result: `logo-export: all checks passed`.

- [ ] Commit:

```bash
git add src/lib/logo-export.server.ts scripts/verify-logo-export.ts src/app/api/videos/jobs/route.ts src/lib/media-reference-graph.ts
git commit -m "feat: stage trusted logo snapshots for export"
```

---

### Task 6: Render the trusted logo below subtitles in the existing burn

**Files:**

- Modify: `src/remotion/types.ts`
- Modify: `src/remotion/SubtitleOverlayComposition.tsx`
- Modify: `src/app/api/videos/render/route.ts`
- Modify: `src/app/api/renders/[filename]/route.ts`
- Create: `scripts/verify-logo-render.ts`

Extend `SubtitleOverlayConfig` only with the trusted internal type:

```ts
logoOverlay?: {
  src: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
};
```

- [ ] Create `scripts/verify-logo-render.ts` first. Extract/export a pure `normalizeTrustedLogoRenderInput` from `src/lib/logo-export.server.ts` and cover: only a flat `/api/renders/logo-snapshot-<uuid>.webp` is accepted; traversal, absolute external URLs, authenticated brand image URLs, missing dimensions, and arbitrary extensions are rejected; normal scalar bounds are enforced; absent config remains absent; and the render-file MIME map serves `.webp` as `image/webp`.
- [ ] Add a source-order assertion that the logo element in `SubtitleOverlayComposition.tsx` occurs after `<OffthreadVideo` and before the subtitle `keywordPopups.map` block. This is a focused invariant check, not a snapshot of the whole component.
- [ ] Run the verifier. Expected red result: trusted render normalization/layer marker is absent.
- [ ] Add `webp: "image/webp"` to the MIME map in `/api/renders/[filename]`, then resolve a trusted logo `src` in the render route using the existing flat render directory rules. Require the exact random snapshot filename pattern, confirm the local file exists, and turn it into an absolute same-origin URL for Remotion. If the internal config is malformed, return `400 invalid_logo_overlay`; do not silently drop it.
- [ ] Import `Img` and `logoOverlayFrame` in `SubtitleOverlayComposition.tsx`. Compute against `useVideoConfig()` width/height and the trusted intrinsic dimensions. Render this block after video/audio and before subtitles:

```tsx
{logoOverlay && (() => {
  const box = logoOverlayFrame({
    position: logoOverlay.position,
    sizePct: logoOverlay.sizePct,
    intrinsic: { width: logoOverlay.intrinsicWidth, height: logoOverlay.intrinsicHeight },
    frameWidth: width,
    frameHeight: height,
  });
  return (
    <Img
      data-logo-overlay="true"
      src={logoOverlay.src}
      style={{ position: "absolute", ...box, objectFit: "contain", opacity: logoOverlay.opacity }}
    />
  );
})()}
```

- [ ] Do not add a new render call, quota reserve, or gallery save. The current orchestrator still posts one `subtitleOverlayConfig` to `/api/videos/render` and saves its one burned result.
- [ ] Run:

```bash
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-clip-charge.ts
```

Expected: all pass; the billing verifiers show no extra charge path.

- [ ] Commit:

```bash
git add src/remotion/types.ts src/remotion/SubtitleOverlayComposition.tsx src/app/api/videos/render/route.ts src/app/api/renders/'[filename]'/route.ts scripts/verify-logo-render.ts
git commit -m "feat: burn logo overlay with subtitles"
```

---

### Task 7: Build the shared client editor, controls, and live preview

**Files:**

- Create: `src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts`
- Create: `src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx`
- Create: `src/app/(dashboard)/video-editor/_v2/LogoOverlayPreview.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/subtitle-style.ts`
- Create: `scripts/verify-logo-client-contract.ts`

**Hook contract:**

```ts
export function useLogoOverlayEditor(input: {
  projectId: string | null;
  eligible: boolean;
  value: LogoOverlayConfig | undefined;
  onChange: (next: LogoOverlayConfig | undefined) => void;
  projectSaveStatus: "idle" | "saving" | "saved" | "error";
  onRetryProjectSave: () => void;
}): {
  asset: BrandAssetView | null;
  loading: boolean;
  saving: boolean;
  unsaved: boolean;
  error: string | null;
  setEnabled(enabled: boolean): void;
  setPosition(position: LogoPosition): void;
  setSizePct(value: number): void;
  setOpacity(value: number): void;
  upload(file: File): Promise<boolean>;
  saveAsDefault(): Promise<boolean>;
  removeFromProject(): void;
};
```

- [ ] Write `scripts/verify-logo-client-contract.ts` first around pure helpers exported by the new hook module: accepted picker MIME/extension labels, multipart field construction, privacy-safe telemetry properties, upload-response parsing, and `buildV2BurnConfig` emitting `{enabled:true, assetId, position, sizePct, opacity}` only when an enabled normalized project config exists.
- [ ] Run the script. Expected red result: client helpers do not exist.
- [ ] Implement `useLogoOverlayEditor`. When `value.assetId` changes, fetch owner-checked metadata from `GET /api/user/brand-assets/:id`; the returned `asset.imageUrl` is the only preview source. An upload POSTs `file` and `projectId`, leaves the previous value untouched on failure, and changes the project only after a 201 response. A first upload uses enabled/top-right/18%/90%; a replacement preserves the project's current enabled/position/size/opacity values and changes only `assetId`.
- [ ] After a successful project upload, show an inline choice state. `ใช้เฉพาะโปรเจกต์นี้` dismisses it; `ตั้งเป็นโลโก้หลักสำหรับโปรเจกต์ใหม่` calls `saveAsDefault`. If PATCH fails, keep the project upload and show `ตั้งเป็นโลโก้หลักไม่สำเร็จ`; do not roll the working project selection back.
- [ ] `removeFromProject` sets project config to `undefined`. After the existing one-second draft autosave window, issue best-effort DELETE for the old asset only if it was a project-only upload; treat 409 as retained/referenced, not a visible failure.
- [ ] Derive `unsaved` from upload/default mutation state plus `projectSaveStatus === "saving" || projectSaveStatus === "error"`. A project autosave failure must show `ยังไม่ได้บันทึก` and wire retry to `onRetryProjectSave`, while retaining the local live config.
- [ ] Implement `LogoOverlayControls` once for desktop and mobile. Include the approved empty/configured states, an explicit `แสดงโลโก้ในโปรเจกต์นี้` switch, thumbnail/name, `เปลี่ยน`, `ลบออกจากโปรเจกต์`, nine accessible position buttons, size 8–35 slider with percentage, opacity 20–100 slider with percentage, and locked FREE upsell copy.
- [ ] Upload flow must present the choice `ใช้เฉพาะโปรเจกต์นี้` versus `ตั้งเป็นโลโก้หลักสำหรับโปรเจกต์ใหม่` after file selection. Do not make account default implicit.
- [ ] Implement `LogoOverlayPreview` with `ResizeObserver` on its absolute 9:16 preview container. Call `logoOverlayFrame` with the rendered container dimensions and asset intrinsic dimensions. Render an authenticated `<img>` with `pointer-events:none`, `object-fit:contain`, and the configured opacity. Return `null` for disabled/missing asset.
- [ ] Extend `buildV2BurnConfig` with a final optional `logoOverlay` argument. It must preserve the old returned object when absent and include the client id/scalars when enabled.
- [ ] Extend `usePostPhaseEditor` options with the project logo props, `projectSaveStatus`, `onRetryProjectSave`, and `surface: "desktop" | "mobile"`; create one `logo` hook instance, pass the enabled config to `buildV2BurnConfig`, and return `logo`. Keep subtitle state ownership unchanged.
- [ ] Emit these client telemetry names with only `planEligible`, normalized error code, size bucket, position, enabled, and surface (`desktop`/`mobile`) where relevant: `logo_overlay_panel_opened`, `logo_overlay_upload_started`, `logo_overlay_upload_done`, `logo_overlay_upload_error`, `logo_overlay_toggled`, `logo_overlay_default_saved`, `logo_overlay_export_submitted`. Never send asset id, filename, URL, path, or storage key.
- [ ] Run `npx tsx scripts/verify-logo-client-contract.ts`. Expected green result: `logo-client-contract: all checks passed`.
- [ ] Commit:

```bash
git add 'src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts' 'src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx' 'src/app/(dashboard)/video-editor/_v2/LogoOverlayPreview.tsx' 'src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts' 'src/app/(dashboard)/video-editor/_v2/subtitle-style.ts' scripts/verify-logo-client-contract.ts
git commit -m "feat: add shared logo overlay editor controls"
```

---

### Task 8: Add the desktop `ซับ | โลโก้` panel

**Files:**

- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`

- [ ] Add the new props to `PostPhase` and pass them into `usePostPhaseEditor`:

```ts
projectId: string | null;
logoOverlay?: LogoOverlayConfig;
onLogoOverlayChange: (next: LogoOverlayConfig | undefined) => void;
logoEligible: boolean;
projectSaveStatus: "idle" | "saving" | "saved" | "error";
onRetryProjectSave: () => void;
```

Pass `surface:"desktop"` with these values into `usePostPhaseEditor`; `PostPhaseMobile` passes the same values with `surface:"mobile"` in Task 9.

- [ ] Before editing the component, extend `scripts/verify-logo-client-contract.ts` with source-contract checks that desktop contains both `ซับ` and `โลโก้`, renders `LogoOverlayControls` only in the logo branch, and places `LogoOverlayPreview` before `V2CaptionOverlay`. Run it and expect red because the desktop source does not yet contain the Logo tab/layer.
- [ ] Add local `rightTab: "subtitle" | "logo"` defaulting to `"subtitle"`. At the top of the existing 330 px right panel, render the repository `Segmented` control with `ซับ` and `โลโก้`. Keep the full existing subtitle control tree mounted only when `rightTab === "subtitle"`; render `LogoOverlayControls` when it is `"logo"`.
- [ ] On first transition to the logo tab during a mount, emit `logo_overlay_panel_opened` with `surface:"desktop"`.
- [ ] Insert `LogoOverlayPreview` in the center video preview after the `<video>` and before `V2CaptionOverlay`. Give it the same absolute bounds as the displayed video. Verify the overlay does not intercept avatar-adjust or playback pointer events.
- [ ] Keep the current export CTA location and wording. A project with no enabled logo exports without any logo-related prompt.
- [ ] Manually verify keyboard tab order: segmented tabs, enable switch, upload/replace/remove, nine anchors in reading order, size, opacity, default action, export. Every position button must have Thai `aria-label`; the selected state must use `aria-pressed`.
- [ ] Run `npx tsx scripts/verify-logo-client-contract.ts`. Expected green result: desktop Logo tab and preview layer invariants pass.
- [ ] Run `npx tsc --noEmit`. Expected current repository exit is 2 with only the pre-existing `src/app/api/payments/checkout/route.ts:129` error; there must be no `PostPhase`, logo component, or `EditorV2Shell` error.
- [ ] Commit:

```bash
git add 'src/app/(dashboard)/video-editor/_v2/PostPhase.tsx' 'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' scripts/verify-logo-client-contract.ts
git commit -m "feat: add desktop logo overlay panel"
```

---

### Task 9: Make the mobile Logo sheet touch-native and accessible

**Files:**

- Create: `src/lib/mobile-sheet.ts`
- Create: `scripts/verify-mobile-sheet.ts`
- Create: `src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx`

**Reusable sheet contract:**

```ts
export type MobileSheetSize = "medium" | "large";

export function MobileSheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: MobileSheetSize;
  triggerRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}): React.ReactNode;
```

`medium` is `min(60dvh, 620px)` with internal scrolling. `large` preserves the current editing/style capacity up to `94dvh`.

- [ ] Write `src/lib/mobile-sheet.ts` signatures and `scripts/verify-mobile-sheet.ts` tests first for pure `shouldDismissSheetDrag({distanceY, velocityY})`: dismiss at 96 px downward travel or 0.65 px/ms downward velocity, never dismiss upward motion, and clamp visual drag translation at zero.
- [ ] Run `npx tsx scripts/verify-mobile-sheet.ts`. Expected red result: implementation exports are missing.
- [ ] Implement the pure functions, then build `MobileSheet.tsx`. Move the current scrim/glass/handle structure out of `PostPhaseMobile`. Add `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape handling, body scroll lock, focus trap across real focusable descendants, and focus restoration to `triggerRef`.
- [ ] Before modifying `PostPhaseMobile`, extend `scripts/verify-logo-client-contract.ts` with source-contract checks for equal `แก้ซับ`/`โลโก้` actions, `MobileSheet` medium usage, an enabled text/icon indicator, and `LogoOverlayPreview` before `V2CaptionOverlay`. Run it and expect red because mobile Logo UI is not present yet.
- [ ] Implement pointer swipe-down only from the drag handle. While open, push one same-URL history state tagged with a sheet token. `popstate` closes the sheet; closing via UI consumes only that tagged entry. Do not navigate away or duplicate history entries when switching between edit/style/logo sheets.
- [ ] Keep the scrim above the underlying export footer and set pointer events so taps cannot pass through. Pad sheet content with `calc(20px + env(safe-area-inset-bottom))`.
- [ ] Replace both current local `Sheet` usages with `MobileSheet size="large"`, then delete the local `Sheet` function from `PostPhaseMobile.tsx`.
- [ ] Add two equal 44 px minimum actions directly below the sticky preview: `แก้ซับ` and `โลโก้`. The Logo action gets an icon, text, and a visible `เปิดอยู่` badge/check when enabled; do not rely on purple color alone.
- [ ] Add the same project logo/save props from `PostPhase` to `PostPhaseMobile`, pass them to `usePostPhaseEditor` with `surface:"mobile"`, then open `MobileSheet size="medium"` from the Logo action and render the shared `LogoOverlayControls`. Pass a trigger ref for focus return. Emit `logo_overlay_panel_opened` once per open with `surface:"mobile"`.
- [ ] Insert the shared live preview layer after the preview `<video>` and before `V2CaptionOverlay`. Pause playback when the logo sheet opens, matching current edit-sheet behavior.
- [ ] Run `npx tsx scripts/verify-mobile-sheet.ts` and `npx tsx scripts/verify-logo-client-contract.ts`. Expected green results: `mobile-sheet: all checks passed` and mobile source-contract checks pass.
- [ ] With the dev server running, use responsive browser mode and verify all of these widths: 360, 375, 390, 430, 768, 1023, and 1024 px. At each mobile width verify 44 px targets, nine-grid fit, numeric sliders, sheet-only scroll, no horizontal overflow, safe-area padding, scrim blocking export, swipe-down, Escape, Back, focus trap, and trigger focus restoration. At 1024 confirm the desktop tabs replace mobile actions cleanly.
- [ ] Commit:

```bash
git add src/lib/mobile-sheet.ts scripts/verify-mobile-sheet.ts scripts/verify-logo-client-contract.ts 'src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx' 'src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx'
git commit -m "feat: add responsive mobile logo overlay sheet"
```

---

### Task 10: Complete server/client telemetry without sensitive asset data

**Files:**

- Modify: `src/lib/mcp/orchestrator.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts`
- Modify: `scripts/verify-logo-client-contract.ts`
- Modify: `scripts/verify-logo-export.ts`

- [ ] Add failing assertions that telemetry payload builders reject the keys `assetId`, `filename`, `src`, `url`, `storageKey`, and `originalName` and that export completion is recorded only when the trusted job config contains a logo.
- [ ] Run both focused scripts. Expected red result: completion telemetry is absent.
- [ ] At client submit, record `logo_overlay_export_submitted` after `onExportJob` accepts the job, not on button click. Properties are `{ surface, position }` only.
- [ ] At durable export completion in the orchestrator, emit `logo_overlay_export_completed` through the existing server telemetry path only if `input.subtitleOverlayConfig.logoOverlay` matches the trusted internal shape. Properties are `{ position, durationBucket }`; derive duration bucket from existing preview duration and do not include any asset identifier.
- [ ] Telemetry failures are fail-open and cannot fail or delay export finalization.
- [ ] Run:

```bash
npx tsx scripts/verify-logo-client-contract.ts
rm -f /tmp/heroai-logo-export-telemetry.db
DATABASE_URL=file:/tmp/heroai-logo-export-telemetry.db npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL=file:/tmp/heroai-logo-export-telemetry.db \
BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-export-telemetry \
npx tsx scripts/verify-logo-export.ts
```

Expected: both pass and their privacy assertions are green.

- [ ] Commit:

```bash
git add src/lib/mcp/orchestrator.ts 'src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts' scripts/verify-logo-client-contract.ts scripts/verify-logo-export.ts
git commit -m "feat: measure logo overlay adoption safely"
```

---

### Task 11: Run regression, visual parity, real export, and handoff

**Files:**

- Modify only if a Logo Overlay regression is found: files already named in Tasks 1–10
- Do not include unrelated baseline fixes in this feature branch

- [ ] Start from a clean feature worktree and inspect `git status --short`. Confirm only intended feature files are tracked/modified.
- [ ] Create a fresh verification database and run the entire feature suite:

```bash
rm -f /tmp/heroai-logo-final.db
rm -rf /tmp/heroai-brand-assets-final
DATABASE_URL=file:/tmp/heroai-logo-final.db npx prisma db push --skip-generate --accept-data-loss
npx tsx scripts/verify-logo-overlay.ts
DATABASE_URL=file:/tmp/heroai-logo-final.db BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-final npx tsx scripts/verify-brand-assets.ts
DATABASE_URL=file:/tmp/heroai-logo-final.db BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-final npx tsx scripts/verify-brand-asset-api.ts
npx tsx scripts/verify-logo-project-default.ts
DATABASE_URL=file:/tmp/heroai-logo-final.db BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-final npx tsx scripts/verify-logo-export.ts
npx tsx scripts/verify-logo-render.ts
npx tsx scripts/verify-logo-client-contract.ts
npx tsx scripts/verify-mobile-sheet.ts
```

Expected: every script prints its named `all checks passed` line.

- [ ] Run the adjacent existing regression suite:

```bash
npx tsx scripts/verify-editor-projects.ts
npx tsx scripts/verify-render-duration-bill.ts
npx tsx scripts/verify-clip-charge.ts
npx tsx scripts/verify-media-reference-graph.ts
npx tsx scripts/verify-media-cleanup-mode.ts
```

Expected: all pass, including queued/processing export snapshot retention and existing cleanup dry-run/apply behavior.

- [ ] Run `npx prisma generate`, then `npm run build`. Expected: successful production build.
- [ ] Run `npx tsc --noEmit`. Expected: no new errors; the only accepted failure is the pre-existing checkout metadata error at `src/app/api/payments/checkout/route.ts:129`.
- [ ] Desktop browser smoke: PRO user, no logo; PNG transparent upload; each of nine anchors; size min/max; opacity min/max; project-only replacement; save as account default; reload persistence; export without logo; export with logo.
- [ ] Mobile browser smoke at 390 px: upload from picker; medium sheet; live position/size/opacity; internal scroll; swipe/Escape/Back; focus restoration; export CTA blocked behind scrim; reload persistence.
- [ ] Legacy/downgrade smoke: open a pre-feature project and confirm no logo; start a new project and confirm explicit account default inheritance; downgrade a logo-enabled fixture to FREE and confirm controls lock while saved preview/config remains and export returns the Thai upgrade message; separately confirm a FREE legacy/no-logo project still exports normally.
- [ ] Security smoke: request another user's metadata/image route and get 404; submit another user's `assetId` to export and get 404; submit an external `src` and confirm it never reaches queued `inputJson`; inspect queued input to confirm it contains only a random `logo-snapshot-*.webp` URL and scalars.
- [ ] Produce one real 1080-by-1920 export with a transparent square logo at top-right, 18%, 90%. Compare a captured preview frame and exported frame: position tolerance at most 1 px at render resolution, alpha preserved, subtitles visually above logo, and no extra clip/minute charge.
- [ ] Verify the responsive matrix from Task 9 on one iPhone-class and one Android-class real/device-simulated viewport. Check no overlap at 1023/1024 breakpoint.
- [ ] Expose the QA build over Tailscale with `npm run dev -- --hostname 0.0.0.0 --port 3007`, obtain the address with `tailscale ip -4`, and report `http://<tailscale-ip>:3007/video-editor?ui=v2` together with test account/fixture scope, commit SHA, and required environment flags. Do not expose private asset roots or production credentials.
- [ ] Inspect `git diff --check`, `git status --short`, and `git log --oneline --max-count=12`. Commit only Logo Overlay fixes discovered during this task with narrowly named commits.
- [ ] Request code review using `superpowers:requesting-code-review`, address verified findings, and rerun every affected focused verifier plus `npm run build`.
- [ ] Finish the branch using `superpowers:finishing-a-development-branch`; present merge/PR/keep/cleanup choices without deploying automatically.

## Done Definition

The feature is complete only when a PRO or BUSINESS user can upload a transparent logo from desktop or mobile, configure it once, reload without losing it, export one video whose logo matches preview, make it the default for future projects without rewriting old projects, and disable or replace it independently. FREE downgrade, legacy no-logo exports, cross-user denial, immutable in-flight snapshots, account deletion cleanup, mobile accessibility, single-burn billing, and privacy-safe telemetry must all be demonstrated by the checks above.
