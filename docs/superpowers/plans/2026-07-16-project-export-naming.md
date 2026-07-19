# Project Export Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use a meaningful Editor Project title for Gallery cards and user-facing `.mp4` downloads while preserving headline/script/`Untitled` fallbacks.

**Architecture:** Add one client-safe naming module that owns display-title precedence and cross-platform filename sanitization. Extend the existing Gallery API response with `project.title`, then pass one resolved filename from `EditorV2Shell` into every completed-export download surface; the private random render URL remains unchanged.

**Tech Stack:** TypeScript, Next.js 15 App Router, React 19, Prisma 6/SQLite, repository `tsx` verification scripts.

## Global Constraints

- A meaningful Project title wins over Content headline and script.
- After trimming, the exact default `New Project` is treated as unset.
- Fallback order is Content headline, short script prefix, then `Untitled`.
- Preserve Thai and other Unicode letters in display and download names.
- Remove control characters and common Windows/macOS-invalid filename characters, collapse whitespace, strip trailing dots/spaces, cap the stem at 80 Unicode code points, and append `.mp4`.
- Keep cryptographically random render storage filenames and existing media-serving behavior unchanged.
- Do not add a database migration, download endpoint, or B-roll enable/disable control.
- Do not modify unrelated untracked files already present in the worktree.

---

## File Structure

- Create `src/lib/video-export-name.ts`: pure, client-safe display-title and download-filename policy.
- Create `scripts/verify-video-export-name.ts`: focused behavior tests plus source-level wiring contracts for API, Gallery, and Editor download surfaces.
- Modify `package.json`: register `verify:video-export-name`.
- Modify `src/app/api/videos/route.ts`: return linked `project.title`.
- Modify `src/app/(dashboard)/videos/page.tsx`: resolve Gallery title and download filename through the shared module.
- Modify `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx`: resolve one filename and pass it to completed-export views.
- Modify `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx`: accept and apply the filename on desktop.
- Modify `src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx`: accept and apply the filename on mobile.

---

### Task 1: Shared Naming Policy

**Files:**
- Create: `src/lib/video-export-name.ts`
- Create: `scripts/verify-video-export-name.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nullable Project title, Content headline, and script strings.
- Produces: `VideoNameInput`, `resolveVideoDisplayName(input): string`, and `resolveVideoDownloadFilename(input): string`.

- [ ] **Step 1: Write the failing behavior verification**

Create `scripts/verify-video-export-name.ts`:

```ts
import assert from "node:assert/strict";
import {
  resolveVideoDisplayName,
  resolveVideoDownloadFilename,
} from "../src/lib/video-export-name";

assert.equal(
  resolveVideoDisplayName({ projectTitle: "  แคมเปญเปิดตัว  ", headline: "หัวข้อ", script: "สคริปต์" }),
  "แคมเปญเปิดตัว",
  "a meaningful project title wins",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: " New Project ", headline: "หัวข้อเดิม", script: "สคริปต์" }),
  "หัวข้อเดิม",
  "the default project title falls back to the content headline",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: "New Project", script: "สคริปต์สั้น" }),
  "สคริปต์สั้น",
  "the default project title falls back to script",
);
assert.equal(
  resolveVideoDisplayName({ projectTitle: "", headline: "", script: "" }),
  "Untitled",
  "empty candidates fall back to Untitled",
);
assert.equal(
  resolveVideoDisplayName({ script: "ก".repeat(45) }),
  `${"ก".repeat(40)}...`,
  "script fallback is capped at 40 Unicode code points",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "คลิปเปิดตัวสินค้า" }),
  "คลิปเปิดตัวสินค้า.mp4",
  "Thai project names remain readable",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "แคมเปญ: เปิด/ตัว* ?" }),
  "แคมเปญ เปิด ตัว.mp4",
  "invalid filename characters become collapsed spaces",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "A\u0000B...  " }),
  "A B.mp4",
  "control characters and trailing dots/spaces are removed",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "<>:\"/\\|?*" }),
  "Untitled.mp4",
  "an empty sanitized stem falls back safely",
);
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "CON" }),
  "Untitled.mp4",
  "reserved Windows device names fall back safely",
);
const longFilename = resolveVideoDownloadFilename({ projectTitle: "ก".repeat(100) });
assert.equal(Array.from(longFilename.slice(0, -4)).length, 80, "filename stem is capped at 80 code points");
assert.equal(
  resolveVideoDownloadFilename({ projectTitle: "New Project", script: "ชื่อจากสคริปต์" }),
  "ชื่อจากสคริปต์.mp4",
  "download naming uses the same fallback policy",
);

console.log("PASS video export naming behavior");
```

Add to `package.json` scripts:

```json
"verify:video-export-name": "tsx scripts/verify-video-export-name.ts"
```

- [ ] **Step 2: Run the verification and confirm RED**

Run: `npm run verify:video-export-name`

Expected: FAIL with `Cannot find module '../src/lib/video-export-name'` because the shared naming module does not exist.

- [ ] **Step 3: Implement the minimal shared naming module**

Create `src/lib/video-export-name.ts`:

```ts
const DEFAULT_PROJECT_TITLE = "New Project";
const SCRIPT_TITLE_LIMIT = 40;
const FILENAME_STEM_LIMIT = 80;
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface VideoNameInput {
  projectTitle?: string | null;
  headline?: string | null;
  script?: string | null;
}

function trimmed(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  return candidate ? candidate : null;
}

function scriptTitle(script: string | null | undefined): string | null {
  const candidate = trimmed(script);
  if (!candidate) return null;
  const chars = Array.from(candidate);
  return chars.length > SCRIPT_TITLE_LIMIT
    ? `${chars.slice(0, SCRIPT_TITLE_LIMIT).join("")}...`
    : candidate;
}

export function resolveVideoDisplayName(input: VideoNameInput): string {
  const projectTitle = trimmed(input.projectTitle);
  if (projectTitle && projectTitle !== DEFAULT_PROJECT_TITLE) return projectTitle;
  return trimmed(input.headline) ?? scriptTitle(input.script) ?? "Untitled";
}

export function resolveVideoDownloadFilename(input: VideoNameInput): string {
  let stem = resolveVideoDisplayName(input)
    .replace(/[\u0000-\u001f\u007f<>:\"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  stem = Array.from(stem).slice(0, FILENAME_STEM_LIMIT).join("").replace(/[. ]+$/g, "");
  if (!stem || WINDOWS_RESERVED_STEM.test(stem)) stem = "Untitled";
  return `${stem}.mp4`;
}
```

- [ ] **Step 4: Run the focused verification and confirm GREEN**

Run: `npm run verify:video-export-name`

Expected: `PASS video export naming behavior` and exit code 0.

- [ ] **Step 5: Commit the shared policy**

```bash
git add package.json scripts/verify-video-export-name.ts src/lib/video-export-name.ts
git commit -m "fix(video): centralize project export naming"
```

---

### Task 2: Gallery API and Gallery Card Wiring

**Files:**
- Modify: `scripts/verify-video-export-name.ts`
- Modify: `src/app/api/videos/route.ts:26-40`
- Modify: `src/app/(dashboard)/videos/page.tsx:1-45,520-645`

**Interfaces:**
- Consumes: Task 1's `resolveVideoDisplayName` and `resolveVideoDownloadFilename`.
- Produces: Gallery API items with `project: { title: string } | null`; Gallery cards whose visible and download names use the shared policy.

- [ ] **Step 1: Extend the verification with failing Gallery wiring contracts**

Append before the final `console.log` in `scripts/verify-video-export-name.ts`:

```ts
import { readFileSync } from "node:fs";

const videosApiSource = readFileSync(
  new URL("../src/app/api/videos/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  videosApiSource,
  /project:\s*\{\s*select:\s*\{\s*title:\s*true\s*\}\s*\}/,
  "Gallery API selects the linked project title",
);

const gallerySource = readFileSync(
  new URL("../src/app/(dashboard)/videos/page.tsx", import.meta.url),
  "utf8",
);
assert.match(gallerySource, /resolveVideoDisplayName\(/, "Gallery uses the shared display-name resolver");
assert.match(gallerySource, /projectTitle:\s*video\.project\?\.title/, "Gallery passes project title to the resolver");
assert.match(gallerySource, /download=\{downloadFilename\}/, "Gallery supplies the resolved download filename");
```

Move the existing final log after these assertions.

- [ ] **Step 2: Run the verification and confirm RED**

Run: `npm run verify:video-export-name`

Expected: FAIL at `Gallery API selects the linked project title`.

- [ ] **Step 3: Return the Project relation from the Gallery API**

Add this field to the existing Prisma `select` in `src/app/api/videos/route.ts`:

```ts
project: { select: { title: true } },
```

- [ ] **Step 4: Use the shared policy in Gallery cards and downloads**

Add the import in `src/app/(dashboard)/videos/page.tsx`:

```ts
import { resolveVideoDisplayName, resolveVideoDownloadFilename } from "@/lib/video-export-name";
```

Extend `VideoItem`:

```ts
project?: { title: string } | null;
```

Replace the inline title expression in `VideoCard` with:

```ts
const nameInput = {
  projectTitle: video.project?.title,
  headline: video.content?.headline,
  script: video.script,
};
const title = resolveVideoDisplayName(nameInput);
const downloadFilename = resolveVideoDownloadFilename(nameInput);
```

Replace the Gallery download anchor attribute with:

```tsx
download={downloadFilename}
```

Keep `href`, `target`, and `rel` unchanged.

- [ ] **Step 5: Run the focused verification and confirm GREEN**

Run: `npm run verify:video-export-name`

Expected: all behavior and Gallery wiring assertions pass with exit code 0.

- [ ] **Step 6: Commit the Gallery fix**

```bash
git add scripts/verify-video-export-name.ts src/app/api/videos/route.ts 'src/app/(dashboard)/videos/page.tsx'
git commit -m "fix(gallery): show and download with project title"
```

---

### Task 3: Editor Desktop and Mobile Download Wiring

**Files:**
- Modify: `scripts/verify-video-export-name.ts`
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx:30-75,400-565`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhase.tsx:38-65`
- Modify: `src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx:44-135`

**Interfaces:**
- Consumes: Task 1's `resolveVideoDownloadFilename` and existing `V2Project.projectTitle/script/mode`.
- Produces: required `downloadFilename: string` props on `PostPhase`, `PostPhaseMobile`, and `ExportedView`.

- [ ] **Step 1: Extend the verification with failing Editor wiring contracts**

Append before the final log in `scripts/verify-video-export-name.ts`:

```ts
const shellSource = readFileSync(
  new URL("../src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", import.meta.url),
  "utf8",
);
assert.match(shellSource, /resolveVideoDownloadFilename\(/, "Editor shell resolves one shared download filename");
assert.equal(
  (shellSource.match(/downloadFilename=\{downloadFilename\}/g) ?? []).length,
  3,
  "Editor shell passes the filename to desktop Post, mobile Post, and ExportedView",
);

for (const filename of ["PostPhase.tsx", "PostPhaseMobile.tsx"]) {
  const source = readFileSync(
    new URL(`../src/app/(dashboard)/video-editor/_v2/${filename}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /downloadFilename:\s*string/, `${filename} requires the download filename`);
  assert.match(source, /download=\{downloadFilename\}/, `${filename} applies the download filename`);
}
assert.match(shellSource, /download=\{downloadFilename\}/, "resumed exported view applies the download filename");
```

- [ ] **Step 2: Run the verification and confirm RED**

Run: `npm run verify:video-export-name`

Expected: FAIL at `Editor shell resolves one shared download filename`.

- [ ] **Step 3: Resolve the Editor filename once and pass it to all views**

Add to `EditorV2Shell.tsx` imports:

```ts
import { resolveVideoDownloadFilename } from "@/lib/video-export-name";
```

After `const p = useV2Project();`, add:

```ts
const downloadFilename = resolveVideoDownloadFilename({
  projectTitle: p.projectTitle,
  script: p.mode === "script" ? p.script : null,
});
```

Pass this prop at the three existing render sites:

```tsx
downloadFilename={downloadFilename}
```

The sites are `PostPhaseMobile`, `PostPhase`, and `ExportedView`.

Update `ExportedView`'s signature and its anchor:

```tsx
function ExportedView({ job, onNewProject, onEditPreview, downloadFilename }: {
  job: V2JobState;
  onNewProject: () => void;
  onEditPreview?: () => void;
  downloadFilename: string;
}) {
```

```tsx
<a href={videoUrl} download={downloadFilename}>
```

- [ ] **Step 4: Require and apply the filename in desktop and mobile Post views**

Add `downloadFilename` to each component's destructured props and type:

```tsx
downloadFilename: string;
```

Replace each completed-export anchor's bare `download` attribute with:

```tsx
download={downloadFilename}
```

Do not change playback URLs or export submission payloads.

- [ ] **Step 5: Run the focused verification and confirm GREEN**

Run: `npm run verify:video-export-name`

Expected: all naming, Gallery, and Editor wiring assertions pass with exit code 0.

- [ ] **Step 6: Commit the Editor fix**

```bash
git add scripts/verify-video-export-name.ts 'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' 'src/app/(dashboard)/video-editor/_v2/PostPhase.tsx' 'src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx'
git commit -m "fix(editor): name exported downloads from project"
```

---

### Task 4: Fresh Verification and Regression Audit

**Files:**
- Verify only; modify production files only if a command exposes a defect in the scoped change.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: fresh evidence that the targeted regression, relevant editor project contracts, lint, and production build succeed.

- [ ] **Step 1: Run the focused regression verification**

Run: `npm run verify:video-export-name`

Expected: `PASS video export naming behavior` and exit code 0.

- [ ] **Step 2: Run relevant existing project verification**

Run: `npm run verify:editor-projects`

Expected: `ALL ... EDITOR-PROJECT CHECKS PASSED`. If the pre-existing generated Prisma client/schema mismatch (`providerCheckpointJson`) still blocks this command, record it as an unrelated repository verification blocker and do not alter schema/generated code as part of this fix.

- [ ] **Step 3: Lint every changed TypeScript/TSX file**

Run:

```bash
npx eslint \
  scripts/verify-video-export-name.ts \
  src/lib/video-export-name.ts \
  src/app/api/videos/route.ts \
  'src/app/(dashboard)/videos/page.tsx' \
  'src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx' \
  'src/app/(dashboard)/video-editor/_v2/PostPhase.tsx' \
  'src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx'
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: Next.js production build exits 0.

- [ ] **Step 5: Inspect the final diff and test scope**

Run:

```bash
git diff HEAD~3 --check
git diff HEAD~3 --stat
git status --short
```

Expected: no whitespace errors; only the design/plan plus scoped naming, API, Gallery, Editor, script, and package files are committed; unrelated pre-existing untracked files remain untouched.

- [ ] **Step 6: Report the result without changing B-roll behavior**

Report the naming precedence, user-facing filename behavior, commands that passed, any pre-existing verification blocker, and the commit hashes. Explicitly state that Ticket 1 (B-roll enable/disable) remains deferred for evaluation.
