// Run with: npx tsx scripts/verify-editor-projects.ts
// Spins a throwaway SQLite DB and verifies EditorProject ownership/persistence contracts.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "editorprojects-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const projects = await import("../src/lib/editor-projects");
  const jobs = await import("../src/lib/mcp/video-job");
  const projectPatch = await import("../src/lib/editor-project-patch");
  const updateWithRevision = projects.updateEditorProject as unknown as (
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  const patchEditorProjectForUser = (
    projectPatch as typeof projectPatch & {
      patchEditorProjectForUser?: (
        userId: string,
        projectId: string,
        body: unknown,
      ) => Promise<Response>;
    }
  ).patchEditorProjectForUser;

  const now = new Date();
  const alice = await prisma.user.create({
    data: {
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      plan: "PRO",
      usageCount: 7,
      usageLimit: 100,
      minutesUsed: 12,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
    },
  });
  const bob = await prisma.user.create({
    data: {
      id: "bob",
      name: "Bob",
      email: "bob@example.com",
      plan: "PRO",
      usageCount: 0,
      usageLimit: 100,
      usagePeriodStartedAt: now,
    },
  });

  const p = await projects.createEditorProject(alice.id, {
    title: "  Launch Reel  ",
    draft: { mode: "script", script: "hello" },
  });
  ok(p.title === "Launch Reel", "create trims title");
  ok(p.draft?.script === "hello", "create stores structured draft JSON");
  ok((p as unknown as { draftRevision?: number }).draftRevision === 0, "create response starts at draft revision zero");

  const loadedAtZero = await projects.getEditorProject(alice.id, p.id);
  ok(
    (loadedAtZero as unknown as { draftRevision?: number } | null)?.draftRevision === 0,
    "GET response includes the stored draft revision",
  );

  const usageAfterCreate = await prisma.user.findUnique({ where: { id: alice.id } });
  ok(usageAfterCreate?.usageCount === 7 && usageAfterCreate?.minutesUsed === 12, "project create does not mutate quota counters");

  const aliceList = await projects.listEditorProjects(alice.id);
  const bobList = await projects.listEditorProjects(bob.id);
  ok(aliceList.length === 1 && aliceList[0].id === p.id, "list returns current user's project");
  ok(bobList.length === 0, "list does not leak projects across users");

  let crossUserDenied = false;
  try { await projects.assertEditorProjectOwner(bob.id, p.id); } catch { crossUserDenied = true; }
  ok(crossUserDenied, "assertEditorProjectOwner denies cross-user project");

  const updated = await projects.updateEditorProject(alice.id, p.id, {
    title: "",
    status: "rendering",
    draft: JSON.stringify({ mode: "upload", clipUrl: "/api/renders/a.mp4" }),
    touchLastOpened: true,
  });
  ok(updated?.title === "New Project", "empty title falls back to New Project");
  ok(updated?.status === "rendering", "update accepts known status");
  ok(updated?.draft?.mode === "upload", "update accepts JSON-string draft");

  const revisionProject = await projects.createEditorProject(alice.id, {
    title: "Revision ordering",
    draft: { script: "initial" },
  });
  const acceptedRevisionTwo = await updateWithRevision(alice.id, revisionProject.id, {
    draft: { script: "B" },
    draftRevision: 2,
  });
  ok(
    acceptedRevisionTwo?.draftRevision === 2
      && (acceptedRevisionTwo.draft as { script?: string } | undefined)?.script === "B",
    "newer revision B is accepted",
  );
  let staleRevisionError: unknown;
  try {
    await updateWithRevision(alice.id, revisionProject.id, {
      draft: { script: "late A" },
      draftRevision: 1,
    });
  } catch (error) {
    staleRevisionError = error;
  }
  ok(
    (staleRevisionError as { code?: string })?.code === "stale_revision",
    "late lower revision A is rejected",
  );
  const afterLateA = await projects.getEditorProject(alice.id, revisionProject.id);
  ok(
    (afterLateA as unknown as { draftRevision?: number } | null)?.draftRevision === 2
      && (afterLateA?.draft as { script?: string } | undefined)?.script === "B",
    "late A cannot overwrite B in the database",
  );

  const conflictChoiceProject = await projects.createEditorProject(alice.id, {
    title: "Observed revision conflict choice",
    draft: { script: "initial" },
  });
  await updateWithRevision(alice.id, conflictChoiceProject.id, {
    draft: { script: "server-six" },
    draftRevision: 6,
  });
  const observed = await updateWithRevision(alice.id, conflictChoiceProject.id, {
    draft: { script: "local-choice" },
    draftRevision: 7,
    expectedDraftRevision: 6,
  });
  assert.equal(observed?.draftRevision, 7);
  ok(
    observed?.draftRevision === 7
      && (observed.draft as { script?: string } | undefined)?.script === "local-choice",
    "explicit local choice succeeds when the observed revision is current",
  );

  await assert.rejects(
    updateWithRevision(alice.id, conflictChoiceProject.id, {
      draft: { script: "stale-choice" },
      draftRevision: 8,
      expectedDraftRevision: 6,
    }),
    (error: unknown) => (error as { code?: string }).code === "stale_revision",
  );
  ok(true, "explicit local choice rejects a stale observed revision");
  const afterStaleChoice = await projects.getEditorProject(alice.id, conflictChoiceProject.id);
  assert.equal(afterStaleChoice?.draft.script, "local-choice");
  ok(
    afterStaleChoice?.draftRevision === 7 && afterStaleChoice.draft.script === "local-choice",
    "stale explicit local choice cannot overwrite the current draft",
  );

  let unpairedExpectedRevisionError: unknown;
  try {
    await updateWithRevision(alice.id, conflictChoiceProject.id, {
      expectedDraftRevision: 7,
    });
  } catch (error) {
    unpairedExpectedRevisionError = error;
  }
  const afterUnpairedExpectedRevision = await projects.getEditorProject(alice.id, conflictChoiceProject.id);
  ok(
    (unpairedExpectedRevisionError as { code?: string })?.code === "invalid_draft_revision"
      && afterUnpairedExpectedRevision?.draftRevision === 7
      && afterUnpairedExpectedRevision.draft.script === "local-choice",
    "expected revision without a revision-bearing draft is invalid and does not write",
  );

  const equalRevisionProject = await projects.createEditorProject(alice.id, {
    title: "Equal revision race",
    draft: { script: "initial" },
  });
  const equalRevisionResults = await Promise.allSettled([
    updateWithRevision(alice.id, equalRevisionProject.id, {
      draft: { script: "same revision first" },
      draftRevision: 1,
    }),
    updateWithRevision(alice.id, equalRevisionProject.id, {
      draft: { script: "same revision second" },
      draftRevision: 1,
    }),
  ]);
  ok(
    equalRevisionResults.filter((result) => result.status === "fulfilled").length === 1
      && equalRevisionResults.filter(
        (result) => result.status === "rejected"
          && (result.reason as { code?: string })?.code === "stale_revision",
      ).length === 1,
    "concurrent equal revisions have exactly one winner",
  );
  const retryAfterConflict = await updateWithRevision(alice.id, equalRevisionProject.id, {
    draft: { script: "retry latest" },
    draftRevision: 2,
  });
  ok(
    retryAfterConflict?.draftRevision === 2
      && (retryAfterConflict.draft as { script?: string } | undefined)?.script === "retry latest",
    "retry with a newer revision succeeds",
  );

  const legacyDraftUpdate = await projects.updateEditorProject(alice.id, equalRevisionProject.id, {
    draft: { script: "legacy no-logo caller" },
  });
  ok(
    (legacyDraftUpdate as unknown as { draftRevision?: number } | null)?.draftRevision === 3
      && legacyDraftUpdate?.draft?.script === "legacy no-logo caller"
      && legacyDraftUpdate?.draft?.logoOverlay === undefined,
    "revision-less draft caller succeeds and atomically advances the revision",
  );
  let lateIssuedRevisionThreeError: unknown;
  try {
    await updateWithRevision(alice.id, equalRevisionProject.id, {
      draft: { script: "late issued revision three" },
      draftRevision: 3,
    });
  } catch (error) {
    lateIssuedRevisionThreeError = error;
  }
  ok(
    (lateIssuedRevisionThreeError as { code?: string })?.code === "stale_revision",
    "a revision issued before the legacy write cannot overwrite that write",
  );
  const metadataOnly = await projects.updateEditorProject(alice.id, equalRevisionProject.id, {
    title: "Metadata only",
    touchLastOpened: true,
  });
  ok(
    (metadataOnly as unknown as { draftRevision?: number } | null)?.draftRevision === 3
      && metadataOnly?.draft?.script === "legacy no-logo caller",
    "revision-less metadata-only updates do not advance the draft revision",
  );

  const concurrentLegacyProject = await projects.createEditorProject(alice.id, {
    title: "Concurrent legacy writes",
    draft: { script: "initial" },
  });
  const concurrentLegacyResults = await Promise.allSettled([
    projects.updateEditorProject(alice.id, concurrentLegacyProject.id, {
      draft: { script: "legacy concurrent one" },
    }),
    projects.updateEditorProject(alice.id, concurrentLegacyProject.id, {
      draft: { script: "legacy concurrent two" },
    }),
  ]);
  const afterConcurrentLegacy = await projects.getEditorProject(alice.id, concurrentLegacyProject.id);
  ok(
    concurrentLegacyResults.every((result) => result.status === "fulfilled")
      && (afterConcurrentLegacy as unknown as { draftRevision?: number } | null)?.draftRevision === 2
      && ["legacy concurrent one", "legacy concurrent two"].includes(afterConcurrentLegacy?.draft?.script ?? ""),
    "concurrent revision-less draft writes each atomically advance the revision",
  );

  ok(typeof patchEditorProjectForUser === "function", "PATCH contract exposes a directly testable authenticated-user seam");
  if (patchEditorProjectForUser) {
    const apiProject = await projects.createEditorProject(alice.id, {
      title: "API revision ordering",
      draft: { script: "initial" },
    });
    const apiB = await patchEditorProjectForUser(alice.id, apiProject.id, {
      draft: { script: "API B" },
      draftRevision: 2,
    });
    const apiBPayload = await apiB.json() as Record<string, unknown>;
    ok(
      apiB.status === 200
        && ((apiBPayload.project as Record<string, unknown> | undefined)?.draftRevision === 2),
      "PATCH accepts and returns a newer draft revision",
    );
    const apiLegacy = await patchEditorProjectForUser(alice.id, apiProject.id, {
      draft: { script: "API legacy newer" },
    });
    const apiLegacyPayload = await apiLegacy.json() as Record<string, unknown>;
    ok(
      apiLegacy.status === 200
        && ((apiLegacyPayload.project as Record<string, unknown> | undefined)?.draftRevision === 3),
      "revision-less PATCH preserves its success response and advances the revision",
    );
    const apiLateIssued = await patchEditorProjectForUser(alice.id, apiProject.id, {
      draft: { script: "API late issued revision three" },
      draftRevision: 3,
    });
    const apiLatePayload = await apiLateIssued.json() as Record<string, unknown>;
    ok(
      apiLateIssued.status === 409
        && apiLatePayload.error === "stale_revision"
        && ((apiLatePayload.project as Record<string, unknown> | undefined)?.draftRevision === 3),
      "PATCH returns stale for a revision issued before a legacy write",
    );
    const apiFinal = await projects.getEditorProject(alice.id, apiProject.id);
    ok(apiFinal?.draft?.script === "API legacy newer", "PATCH-level late request leaves the legacy write durable");

    for (const invalidExpectedRevision of [-1, 1.5]) {
      const invalidExpectedProject = await projects.createEditorProject(alice.id, {
        title: `Invalid expected revision ${invalidExpectedRevision}`,
        draft: { script: "initial" },
      });
      await updateWithRevision(alice.id, invalidExpectedProject.id, {
        draft: { script: "server-two" },
        draftRevision: 2,
      });
      const invalidExpectedResponse = await patchEditorProjectForUser(
        alice.id,
        invalidExpectedProject.id,
        {
          draft: { script: "must-not-write" },
          draftRevision: 3,
          expectedDraftRevision: invalidExpectedRevision,
        },
      );
      const invalidExpectedPayload = await invalidExpectedResponse.json() as Record<string, unknown>;
      const afterInvalidExpected = await projects.getEditorProject(alice.id, invalidExpectedProject.id);
      ok(
        invalidExpectedResponse.status === 400
          && invalidExpectedPayload.error === "invalid_draft_revision"
          && afterInvalidExpected?.draftRevision === 2
          && afterInvalidExpected.draft.script === "server-two",
        `PATCH rejects expected revision ${invalidExpectedRevision} without a write`,
      );
    }

    const futureExpectedProject = await projects.createEditorProject(alice.id, {
      title: "Future expected revision",
      draft: { script: "initial" },
    });
    await updateWithRevision(alice.id, futureExpectedProject.id, {
      draft: { script: "server-two" },
      draftRevision: 2,
    });
    const futureExpectedResponse = await patchEditorProjectForUser(alice.id, futureExpectedProject.id, {
      draft: { script: "must-not-write" },
      draftRevision: 4,
      expectedDraftRevision: 3,
    });
    const futureExpectedPayload = await futureExpectedResponse.json() as Record<string, unknown>;
    const afterFutureExpected = await projects.getEditorProject(alice.id, futureExpectedProject.id);
    ok(
      futureExpectedResponse.status === 409
        && futureExpectedPayload.error === "stale_revision"
        && ((futureExpectedPayload.project as Record<string, unknown> | undefined)?.draftRevision === 2)
        && afterFutureExpected?.draftRevision === 2
        && afterFutureExpected.draft.script === "server-two",
      "PATCH rejects a greater-than-current expected revision without a write",
    );

    for (const [label, invalidBody] of [
      ["null", null],
      ["array", []],
      ["string", "draft"],
      ["number", 42],
    ] as const) {
      let response: Response | null = null;
      try {
        response = await patchEditorProjectForUser(alice.id, apiProject.id, invalidBody);
      } catch {
        response = null;
      }
      const payload = response ? await response.json() as Record<string, unknown> : null;
      ok(
        response?.status === 400 && payload?.error === "no_fields",
        `PATCH ${label} JSON returns 400 no_fields`,
      );
    }
  }

  const job = await jobs.createVideoJob(alice.id, { script: "hello", previewMode: true }, undefined, { projectId: p.id });
  const jobRow = await prisma.videoJob.findUnique({ where: { id: job.id } });
  ok(jobRow?.projectId === p.id, "createVideoJob stores optional projectId");
  ok(jobRow?.type === "create", "createVideoJob defaults to create type");

  await projects.updateEditorProject(alice.id, p.id, { activeJobId: job.id, status: "rendering" });
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: "processing" } });
  await jobs.finishJob(job.id, { version: 2, mode: "preview", videoUrl: "/api/renders/base.mp4" });
  const afterFinish = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(afterFinish?.activeJobId === job.id && afterFinish?.status === "post", "finishJob moves preview project to post");

  const exportJob = await jobs.createVideoJob(
    alice.id,
    { mode: "export", sourceJobId: job.id },
    undefined,
    { projectId: p.id, type: "export" },
  );
  await projects.updateEditorProject(alice.id, p.id, { activeExportJobId: exportJob.id, status: "exporting" });
  await prisma.videoJob.update({ where: { id: exportJob.id }, data: { status: "processing" } });
  await jobs.finishJob(exportJob.id, { version: 2, mode: "export", sourceJobId: job.id, videoUrl: "/api/renders/final.mp4", videoId: "video_export_1" });
  const afterExport = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(
    afterExport?.activeJobId === job.id &&
    afterExport?.activeExportJobId === exportJob.id &&
    afterExport?.latestVideoId === "video_export_1" &&
    afterExport?.status === "exported",
    "finishJob moves export project to exported without replacing preview job",
  );

  const failedExport = await jobs.createVideoJob(
    alice.id,
    { mode: "export", sourceJobId: job.id },
    undefined,
    { projectId: p.id, type: "export" },
  );
  await projects.updateEditorProject(alice.id, p.id, { activeExportJobId: failedExport.id, status: "exporting" });
  await prisma.videoJob.update({ where: { id: failedExport.id }, data: { status: "processing" } });
  await jobs.failJob(failedExport.id, "export failed");
  const afterExportFail = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(afterExportFail?.activeJobId === job.id && afterExportFail?.status === "post", "failJob returns export project to post without clearing preview job");

  const failedJob = await jobs.createVideoJob(alice.id, { script: "boom", previewMode: true }, undefined, { projectId: p.id });
  await projects.updateEditorProject(alice.id, p.id, { activeJobId: failedJob.id, status: "rendering" });
  await prisma.videoJob.update({ where: { id: failedJob.id }, data: { status: "processing" } });
  await jobs.failJob(failedJob.id, "expected failure");
  const afterFail = await prisma.editorProject.findUnique({ where: { id: p.id } });
  ok(afterFail?.status === "draft", "failJob clears rendering project back to draft");

  const archived = await projects.archiveEditorProject(alice.id, p.id);
  ok(archived, "archive succeeds for owner");
  ok(
    !(await projects.listEditorProjects(alice.id)).some((project) => project.id === p.id),
    "archived projects are hidden by default",
  );
  ok(
    (await projects.listEditorProjects(alice.id, { includeArchived: true })).some((project) => project.id === p.id),
    "includeArchived returns archived projects",
  );

  let archivedDenied = false;
  try { await projects.assertEditorProjectOwner(alice.id, p.id); } catch { archivedDenied = true; }
  ok(archivedDenied, "archived projects cannot be used for new jobs/videos");

  const usageAfterAll = await prisma.user.findUnique({ where: { id: alice.id } });
  ok(usageAfterAll?.usageCount === 7 && usageAfterAll?.minutesUsed === 12, "project update/archive/job metadata does not mutate quota counters");

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} EDITOR-PROJECT CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
