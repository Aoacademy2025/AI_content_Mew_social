// verify-editor-pending-draft.ts — T8 (ADR 0064, plan docs/plans/2026-10-03-mcp-edit-before-export.md,
// G21): the web Post phase loads the Pending Edit Draft + the stale-revision export guard.
//
// Covers:
//  A) load precedence of `pendingEditForWeb` (server projection) — matching base → draft surfaced;
//     mismatched base / no draft / no active job → null (today's behaviour, unchanged).
//  B) the client-safe `normalizeWebPendingEdit` round-trips the server's shape over a JSON hop,
//     and fails closed (null) on anything malformed — it never trusts the network response.
//  C) `enqueueEditorExport`'s CAS guard (G21): a stale `expectedPendingRevision` refuses with 409
//     `stale_revision` and enqueues no job; a matching revision enqueues normally and carries
//     `mcpPendingEditRevision` through unchanged (reusing the existing G12 clear trigger in
//     orchestrator.ts — this script never re-tests that trigger itself, see note below); omitting
//     `expectedPendingRevision` (no draft loaded) behaves exactly as before T8.
//  D) G31: the shared EditorV2Shell harness has a registered stub for the new `./usePendingEditDraft`
//     import (checked here as a source-marker; the harness itself is exercised by
//     `npm run verify:editor-job-runtime` / `verify:post-export-edit-state`, run separately).
//
// Self-contained: builds its own throwaway SQLite (absolute path, like verify-editor-projects.ts).
//
// Run: DATABASE_URL="file:$(pwd)/prisma/test-pending-draft.db" npx prisma db push --skip-generate --accept-data-loss
//      && DATABASE_URL="file:$(pwd)/prisma/test-pending-draft.db" npx tsx scripts/verify-editor-pending-draft.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pending-draft-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate --accept-data-loss", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { pendingEditForWeb } = await import("../src/lib/mcp/pending-edit-draft");
  const { enqueueEditorExport } = await import("../src/lib/editor-export-enqueue");
  // The client module is plain TS with no React/DOM dependency, so it loads fine under plain tsx.
  const { normalizeWebPendingEdit, PENDING_EDIT_BANNER_TEXT } = await import(
    "../src/app/(dashboard)/video-editor/_v2/pending-edit-view"
  );

  function draftJson(baseJobId: string) {
    return JSON.stringify({
      version: 1,
      rootJobId: "root-job-1",
      baseJobId,
      captions: [{ text: "สวัสดีค่ะ", startMs: 0, endMs: 1_000 }],
      originalCaptions: [{ text: "สวัสดีค่ะ", startMs: 0, endMs: 1_000 }],
      cardLen: "sentence",
      subtitleConfig: {
        preset: "plain", effect: "none", fontFamily: "Kanit", bold: true, fontWeight: 900,
        fontSize: 80, textColor: "#FFFFFF", accentColor: "#FFE500", shadow: false, outline: false,
        outlineSize: 0, verticalPos: 82,
      },
      captionOverrides: {},
      windowEdits: [],
    });
  }

  await section("A) pendingEditForWeb load precedence (G21)", async () => {
    const matching = pendingEditForWeb({
      activeJobId: "job-base-1",
      pendingEditJson: draftJson("job-base-1"),
      pendingEditRevision: 3,
    });
    check("a matching base surfaces the draft", matching !== null);
    check("the revision is carried through", matching?.revision === 3);
    check(
      "captions come from the stored draft",
      matching?.draft.captions[0]?.text === "สวัสดีค่ะ",
    );
    check(
      "MCP-only fields (rootJobId / logoOverlay / windowEdits) are not surfaced",
      !("rootJobId" in (matching?.draft ?? {}))
      && !("logoOverlay" in (matching?.draft ?? {}))
      && !("windowEdits" in (matching?.draft ?? {})),
    );

    const mismatchedBase = pendingEditForWeb({
      activeJobId: "job-base-2",
      pendingEditJson: draftJson("job-base-1"),
      pendingEditRevision: 3,
    });
    check(
      "a draft seeded for a DIFFERENT base job reads as no draft",
      mismatchedBase === null,
    );

    const noDraft = pendingEditForWeb({
      activeJobId: "job-base-1",
      pendingEditJson: null,
      pendingEditRevision: 0,
    });
    check("no stored draft reads as no draft", noDraft === null);

    const noActiveJob = pendingEditForWeb({
      activeJobId: null,
      pendingEditJson: draftJson("job-base-1"),
      pendingEditRevision: 3,
    });
    check("a project with no active job reads as no draft", noActiveJob === null);
  });

  await section("B) normalizeWebPendingEdit (client-safe parse)", async () => {
    const serverShape = pendingEditForWeb({
      activeJobId: "job-base-1",
      pendingEditJson: draftJson("job-base-1"),
      pendingEditRevision: 7,
    });
    // Simulate the network hop: the route JSON-serializes this as `project.pendingEdit`.
    const overTheWire = JSON.parse(JSON.stringify(serverShape));
    const normalized = normalizeWebPendingEdit(overTheWire);
    check("round-trips the revision", normalized?.revision === 7);
    check(
      "round-trips captions",
      normalized?.draft.captions[0]?.text === "สวัสดีค่ะ",
    );
    check(
      "exact banner text matches the plan verbatim",
      PENDING_EDIT_BANNER_TEXT === "มีการแก้จาก AI agent ที่ยังไม่ export",
    );
    check("undefined reads as no draft", normalizeWebPendingEdit(undefined) === null);
    check("null reads as no draft", normalizeWebPendingEdit(null) === null);
    check(
      "a non-numeric revision fails closed",
      normalizeWebPendingEdit({ ...overTheWire, revision: "7" }) === null,
    );
    check(
      "a draft missing captions fails closed",
      normalizeWebPendingEdit({ ...overTheWire, draft: { ...overTheWire.draft, captions: undefined } }) === null,
    );
    check(
      "a caption missing endMs fails closed",
      normalizeWebPendingEdit({
        ...overTheWire,
        draft: { ...overTheWire.draft, captions: [{ text: "x", startMs: 0 }] },
      }) === null,
    );
  });

  const baseUser = await prisma.user.create({
    data: { id: "pending-draft-user", name: "u", email: "pending-draft@t.test", plan: "PRO" },
  });
  const basePreview = {
    version: 2,
    videoUrl: "/api/renders/base.mp4",
    preview: {
      captions: [{ text: "สวัสดีค่ะ", startMs: 0, endMs: 1_000 }],
      audioDurationMs: 1_000,
      config: {},
    },
  };
  const baseJob = await prisma.videoJob.create({
    data: {
      userId: baseUser.id,
      type: "create",
      status: "done",
      inputJson: "{}",
      outputJson: JSON.stringify(basePreview),
    },
  });
  const project = await prisma.editorProject.create({
    data: {
      userId: baseUser.id,
      activeJobId: baseJob.id,
      pendingEditRevision: 5,
    },
  });
  await prisma.videoJob.update({ where: { id: baseJob.id }, data: { projectId: project.id } });

  const enqueueUser = { id: baseUser.id, plan: "PRO" };
  const minimalOverlay = { durationInFrames: 30, voiceFile: "/api/audio/voice.wav" };

  await section("C) enqueueEditorExport CAS guard (G21)", async () => {
    const beforeJobCount = await prisma.videoJob.count({ where: { userId: baseUser.id } });

    const staleResult = await enqueueEditorExport({
      user: enqueueUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: baseJob.id,
      subtitleOverlayConfig: minimalOverlay,
      idempotencyKey: "pending-draft-test-stale",
      expectedPendingRevision: 99, // project is actually at revision 5
    });
    check("a stale expectedPendingRevision refuses the export", staleResult.ok === false);
    check(
      "the refusal is 409 stale_revision",
      !staleResult.ok && staleResult.status === 409 && staleResult.error === "stale_revision",
    );
    check(
      "the refusal carries a Thai message",
      !staleResult.ok && typeof staleResult.message === "string" && staleResult.message.length > 0,
    );
    const afterStaleJobCount = await prisma.videoJob.count({ where: { userId: baseUser.id } });
    check("no job was enqueued for the stale attempt", afterStaleJobCount === beforeJobCount);

    const matchResult = await enqueueEditorExport({
      user: enqueueUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: baseJob.id,
      subtitleOverlayConfig: minimalOverlay,
      idempotencyKey: "pending-draft-test-match",
      expectedPendingRevision: 5, // matches the project's current revision
    });
    check("a matching expectedPendingRevision is accepted", matchResult.ok === true);
    if (matchResult.ok) {
      const row = await prisma.videoJob.findUnique({ where: { id: matchResult.job.id } });
      check(
        "the created job carries mcpPendingEditRevision — reusing the existing G12 clear trigger"
        + " in orchestrator.ts (not re-implemented here)",
        row?.inputJson.includes("\"mcpPendingEditRevision\":5") === true,
      );
    }

    const noDraftResult = await enqueueEditorExport({
      user: enqueueUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: baseJob.id,
      subtitleOverlayConfig: minimalOverlay,
      idempotencyKey: "pending-draft-test-no-draft",
      // expectedPendingRevision omitted: a project with no pending draft loaded.
    });
    check(
      "omitting expectedPendingRevision behaves exactly as before T8 (no CAS check applied)",
      noDraftResult.ok === true,
    );
    if (noDraftResult.ok) {
      const row = await prisma.videoJob.findUnique({ where: { id: noDraftResult.job.id } });
      check(
        "no mcpPendingEditRevision is written when the web never loaded a draft",
        row?.inputJson.includes("mcpPendingEditRevision") === false,
      );
    }
  });

  await section("D) G31: the shared Shell harness registers the new import", async () => {
    const harnessSource = readFileSync("scripts/editor-project-job-runtime-harness.ts", "utf8");
    check(
      "editor-project-job-runtime-harness.ts has a requireMock case for ./usePendingEditDraft",
      harnessSource.includes("\"./usePendingEditDraft\""),
    );
    const shellSource = readFileSync(
      "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
      "utf8",
    );
    check(
      "EditorV2Shell.tsx actually imports usePendingEditDraft (the harness case is not orphaned)",
      /from\s+"\.\/usePendingEditDraft"/.test(shellSource),
    );
  });

  await section(
    "E) PR-A fix round: headline override resync is unconditional (no stale headline after discard/reseed)",
    async () => {
      const hookSource = readFileSync(
        "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
        "utf8",
      );
      const resyncEffectMatch = hookSource.match(
        /useEffect\(\(\) => \{\s*if \(!pendingEdit[\s\S]*?\}, \[pendingEdit\]\);/,
      );
      check("usePostPhaseEditor still defines the pendingEdit resync effect", !!resyncEffectMatch);
      const resyncEffect = resyncEffectMatch![0];
      check(
        "the resync effect no longer guards the headline override behind `if (draft.headlineHook)`"
        + " (that guard left a stale override standing after a discard/reseed removed the headline)",
        !/if\s*\(\s*draft\.headlineHook\s*\)\s*setHeadlineOverrideState/.test(resyncEffect),
      );
      check(
        "the resync effect sets the headline override unconditionally from the draft"
        + " (so a headline-less draft correctly clears a stale override back to undefined)",
        /setHeadlineOverrideState\(draft\.headlineHook\);/.test(resyncEffect),
      );
    },
  );

  await section(
    "F) PR-A fix round: a failed reload drops the stale draft instead of looping on 409 forever",
    async () => {
      const hookSource = readFileSync(
        "src/app/(dashboard)/video-editor/_v2/usePendingEditDraft.ts",
        "utf8",
      );
      const reloadFnMatch = hookSource.match(
        /const reloadPendingEdit = useCallback\(async \(\)[\s\S]*?\n {2}\}, \[projectId\]\);/,
      );
      check("usePendingEditDraft still defines reloadPendingEdit", !!reloadFnMatch);
      const reloadFn = reloadFnMatch![0];
      check(
        "a non-ok response clears pendingEdit instead of leaving the stale revision in place",
        /if \(!res\.ok\) \{[\s\S]*?setPendingEdit\(null\)[\s\S]*?return null;\s*\}/.test(reloadFn),
      );
      check(
        "a thrown fetch error also clears pendingEdit (not just a silent null return)",
        /\} catch \{[\s\S]*?setPendingEdit\(null\)[\s\S]*?return null;\s*\}/.test(reloadFn),
      );
    },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
