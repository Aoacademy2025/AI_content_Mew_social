// Run with: npx tsx scripts/verify-editor-projects.ts
// Spins a throwaway SQLite DB and verifies EditorProject ownership/persistence contracts.
import assert from "node:assert/strict";
import { execSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "editorprojects-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
const brandRoot = join(dir, "brand-assets");
process.env.BRAND_ASSET_ROOT = brandRoot;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else { passed++; console.log("ok:", msg); }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

type RetirementWorkerOutcome =
  | { kind: "returned"; value: boolean }
  | { kind: "brand-error"; code: string; status: number }
  | { kind: "unexpected-error"; message: string };

function startRetirementWorker(userId: string, assetId: string) {
  const child = fork(
    join(process.cwd(), "scripts/editor-project-brand-asset-retirement-worker.ts"),
    [userId, assetId],
    {
      env: process.env,
      execArgv: ["--import", "tsx"],
      silent: true,
    },
  );
  const ready = deferred<void>();
  const invoking = deferred<void>();
  const result = deferred<RetirementWorkerOutcome>();
  let stderr = "";
  let receivedResult = false;
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    const error = new Error("retirement worker timed out");
    ready.reject(error);
    invoking.reject(error);
    result.reject(error);
  }, 15_000);
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const event = (message as { event?: unknown }).event;
    if (event === "ready") ready.resolve();
    if (event === "invoking") invoking.resolve();
    if (event === "result") {
      receivedResult = true;
      const { event: _event, ...outcome } = message as RetirementWorkerOutcome & { event: "result" };
      result.resolve(outcome as RetirementWorkerOutcome);
    }
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!receivedResult) {
        const error = new Error(
          `retirement worker exited before result (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
        );
        ready.reject(error);
        invoking.reject(error);
        result.reject(error);
      }
      resolve();
    });
  });
  child.once("error", (error) => {
    clearTimeout(timeout);
    ready.reject(error);
    invoking.reject(error);
    result.reject(error);
  });
  return {
    ready: ready.promise,
    invoking: invoking.promise,
    result: result.promise,
    closed,
    async cleanup(): Promise<void> {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve();
        }, 1_000);
        void closed.then(() => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    },
  };
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const projects = await import("../src/lib/editor-projects");
  const brandAssets = await import("../src/lib/brand-assets.server");
  const jobs = await import("../src/lib/mcp/video-job");
  const projectPatch = await import("../src/lib/editor-project-patch");
  const lifecycleVerification = await import(
    "../src/lib/editor-project-brand-asset-verification.server"
  );
  const updateWithRevision = projects.updateEditorProject as unknown as (
    userId: string,
    projectId: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  const hasCode = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
  const patchEditorProjectForUser = (
    projectPatch as typeof projectPatch & {
      patchEditorProjectForUser?: (
        userId: string,
        projectId: string,
        body: unknown,
      ) => Promise<Response>;
    }
  ).patchEditorProjectForUser;

  async function createBrandAssetFixture(input: {
    userId: string;
    projectId: string;
    label: string;
    fileKind?: "regular" | "missing" | "directory" | "symlink";
  }) {
    const storageKey = `${input.userId}/${input.label}.webp`;
    const filePath = join(brandRoot, storageKey);
    mkdirSync(join(brandRoot, input.userId), { recursive: true });
    if (input.fileKind === "directory") {
      mkdirSync(filePath, { recursive: true });
    } else if (input.fileKind === "symlink") {
      const target = join(brandRoot, input.userId, `${input.label}-target.webp`);
      writeFileSync(target, "private-logo-target");
      symlinkSync(target, filePath);
    } else if (input.fileKind !== "missing") {
      writeFileSync(filePath, "private-logo");
    }
    return prisma.brandAsset.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        storageKey,
        originalName: `${input.label}.webp`,
        mimeType: "image/webp",
        sizeBytes: 12,
        width: 64,
        height: 32,
      },
    });
  }

  const logoDraft = (assetId: string, script: string) => ({
    script,
    logoOverlay: {
      enabled: true,
      assetId,
      position: "top-right",
      sizePct: 18,
      opacity: 0.9,
    },
  });

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

  const concurrentExplicitProject = await projects.createEditorProject(alice.id, {
    title: "Concurrent explicit choices",
    draft: { script: "initial" },
  });
  await updateWithRevision(alice.id, concurrentExplicitProject.id, {
    draft: { script: "server-four" },
    draftRevision: 4,
  });
  let releaseConcurrentExplicitWrites!: () => void;
  const concurrentExplicitStart = new Promise<void>((resolve) => {
    releaseConcurrentExplicitWrites = resolve;
  });
  const concurrentExplicitInputs = [
    { draft: { script: "explicit-five" }, draftRevision: 5, expectedDraftRevision: 4 },
    { draft: { script: "explicit-six" }, draftRevision: 6, expectedDraftRevision: 4 },
  ] as const;
  const concurrentExplicitWrites = concurrentExplicitInputs.map(async (input) => {
    await concurrentExplicitStart;
    return updateWithRevision(alice.id, concurrentExplicitProject.id, input);
  });
  releaseConcurrentExplicitWrites();
  const concurrentExplicitResults = await Promise.allSettled(concurrentExplicitWrites);
  const concurrentExplicitSuccesses = concurrentExplicitResults.filter(
    (result): result is PromiseFulfilledResult<Record<string, unknown> | null> => result.status === "fulfilled",
  );
  const concurrentExplicitStaleResults = concurrentExplicitResults.filter(
    (result) => result.status === "rejected"
      && (result.reason as { code?: string })?.code === "stale_revision",
  );
  const concurrentExplicitWinner = concurrentExplicitSuccesses[0]?.value;
  const afterConcurrentExplicit = await projects.getEditorProject(alice.id, concurrentExplicitProject.id);
  ok(
    concurrentExplicitSuccesses.length === 1
      && concurrentExplicitStaleResults.length === 1
      && afterConcurrentExplicit?.draftRevision === concurrentExplicitWinner?.draftRevision
      && afterConcurrentExplicit?.draft.script
        === (concurrentExplicitWinner?.draft as { script?: string } | undefined)?.script,
    "concurrent explicit choices have one winner and persist exactly that result",
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
  const equalRevisionWinner = await projects.getEditorProject(alice.id, equalRevisionProject.id);
  const losingDraft = {
    script: equalRevisionWinner?.draft.script === "same revision first"
      ? "same revision second"
      : "same revision first",
  };
  await assert.rejects(
    updateWithRevision(alice.id, equalRevisionProject.id, {
      draft: losingDraft,
      draftRevision: 2,
      expectedDraftRevision: 0,
    }),
    hasCode("stale_revision"),
  );
  const observedWinner = await projects.getEditorProject(alice.id, equalRevisionProject.id);
  assert.equal(observedWinner?.draftRevision, 1);
  const retryAfterConflict = await updateWithRevision(alice.id, equalRevisionProject.id, {
    draft: { script: "retry after explicit observation" },
    draftRevision: 2,
    expectedDraftRevision: observedWinner.draftRevision,
  });
  ok(
    retryAfterConflict?.draftRevision === 2
      && (retryAfterConflict.draft as { script?: string } | undefined)?.script === "retry after explicit observation",
    "a losing draft cannot advance until the winner is explicitly observed",
  );

  const legacyDraftUpdate = await projects.updateEditorProject(alice.id, equalRevisionProject.id, {
    draft: { script: "legacy no-logo caller" },
  });
  ok(
    (legacyDraftUpdate as unknown as { draftRevision?: number } | null)?.draftRevision === 3
      && legacyDraftUpdate?.draft?.script === "legacy no-logo caller"
      && legacyDraftUpdate?.draft?.logoOverlay === undefined,
    "legacy revision-only compatibility: revision-less draft caller succeeds and atomically advances the revision",
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

    const bundledStaleProject = await projects.createEditorProject(alice.id, {
      title: "Bundled current title",
      status: "draft",
      draft: { script: "initial" },
    });
    await updateWithRevision(alice.id, bundledStaleProject.id, {
      draft: { script: "bundled current draft" },
      draftRevision: 3,
    });
    const bundledStaleResponse = await patchEditorProjectForUser(alice.id, bundledStaleProject.id, {
      title: "stale title must not write",
      status: "rendering",
      draft: { script: "stale draft must not write" },
      draftRevision: 4,
      expectedDraftRevision: 2,
    });
    const bundledStalePayload = await bundledStaleResponse.json() as Record<string, unknown>;
    const bundledStaleCurrent = bundledStalePayload.project as Record<string, unknown> | undefined;
    const afterBundledStale = await projects.getEditorProject(alice.id, bundledStaleProject.id);
    ok(
      bundledStaleResponse.status === 409
        && bundledStalePayload.error === "stale_revision"
        && bundledStaleCurrent?.draftRevision === 3
        && (bundledStaleCurrent?.draft as { script?: string } | undefined)?.script === "bundled current draft"
        && bundledStaleCurrent?.title === "Bundled current title"
        && bundledStaleCurrent?.status === "draft"
        && afterBundledStale?.draftRevision === 3
        && afterBundledStale.draft.script === "bundled current draft"
        && afterBundledStale.title === "Bundled current title"
        && afterBundledStale.status === "draft",
      "stale explicit PATCH rejects its bundled draft and metadata atomically",
    );

    const missingExplicitResponse = await patchEditorProjectForUser(alice.id, "missing-explicit-project", {
      draft: { script: "missing" },
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    const missingExplicitPayload = await missingExplicitResponse.json() as Record<string, unknown>;
    ok(
      missingExplicitResponse.status === 404 && missingExplicitPayload.error === "not_found",
      "explicit PATCH returns 404 for a nonexistent project",
    );

    const crossUserExplicitResponse = await patchEditorProjectForUser(bob.id, bundledStaleProject.id, {
      draft: { script: "cross-user" },
      draftRevision: 4,
      expectedDraftRevision: 3,
    });
    const crossUserExplicitPayload = await crossUserExplicitResponse.json() as Record<string, unknown>;
    ok(
      crossUserExplicitResponse.status === 404 && crossUserExplicitPayload.error === "not_found",
      "explicit PATCH returns 404 for a cross-user project",
    );

    const invalidExpectedRevisionCases: Array<{
      label: string;
      expectedDraftRevision: unknown;
      draftRevision: number;
    }> = [
      { label: "string", expectedDraftRevision: "2", draftRevision: 3 },
      { label: "null", expectedDraftRevision: null, draftRevision: 3 },
      { label: "NaN", expectedDraftRevision: Number.NaN, draftRevision: 3 },
      { label: "infinity", expectedDraftRevision: Number.POSITIVE_INFINITY, draftRevision: 3 },
      { label: "fraction", expectedDraftRevision: 1.5, draftRevision: 3 },
      { label: "negative", expectedDraftRevision: -1, draftRevision: 3 },
      {
        label: "maximum plus one",
        expectedDraftRevision: projects.MAX_EDITOR_PROJECT_DRAFT_REVISION + 1,
        draftRevision: 3,
      },
      { label: "unsafe integer", expectedDraftRevision: Number.MAX_SAFE_INTEGER + 1, draftRevision: 3 },
      { label: "draft revision equal to expected", expectedDraftRevision: 2, draftRevision: 2 },
      { label: "draft revision lower than expected", expectedDraftRevision: 2, draftRevision: 1 },
    ];
    for (const invalidCase of invalidExpectedRevisionCases) {
      const invalidExpectedProject = await projects.createEditorProject(alice.id, {
        title: `Invalid expected revision: ${invalidCase.label}`,
        status: "draft",
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
          title: "must-not-write title",
          status: "rendering",
          draft: { script: "must-not-write" },
          draftRevision: invalidCase.draftRevision,
          expectedDraftRevision: invalidCase.expectedDraftRevision,
        },
      );
      const invalidExpectedPayload = await invalidExpectedResponse.json() as Record<string, unknown>;
      const afterInvalidExpected = await projects.getEditorProject(alice.id, invalidExpectedProject.id);
      ok(
        invalidExpectedResponse.status === 400
          && invalidExpectedPayload.error === "invalid_draft_revision"
          && afterInvalidExpected?.draftRevision === 2
          && afterInvalidExpected.draft.script === "server-two"
          && afterInvalidExpected.title === `Invalid expected revision: ${invalidCase.label}`
          && afterInvalidExpected.status === "draft",
        `PATCH rejects invalid expected revision (${invalidCase.label}) without a write`,
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

    async function assertUnavailableResponse(response: Response, rawAssetId: string): Promise<void> {
      const payload = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 422);
      assert.equal(payload.error, "brand_asset_unavailable");
      assert.equal(payload.message, "ไม่พบไฟล์โลโก้ กรุณาอัปโหลดใหม่");
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "project"), false);
      assert.equal(JSON.stringify(payload).includes(rawAssetId), false, "unavailable response hides raw asset ids");
    }

    const noncanonicalProject = await projects.createEditorProject(alice.id, {
      title: "Reject noncanonical Logo id",
      draft: { script: "canonical base" },
    });
    const noncanonicalAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: noncanonicalProject.id,
      label: "noncanonical-id",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, noncanonicalAsset.id), true);
    const noncanonicalAssetBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: noncanonicalAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    const rawNoncanonicalAssetId = ` ${noncanonicalAsset.id} `;
    const noncanonicalDraft = logoDraft(rawNoncanonicalAssetId, "must not persist raw id");
    const noncanonicalUpdateResponse = await patchEditorProjectForUser(
      alice.id,
      noncanonicalProject.id,
      {
        draft: noncanonicalDraft,
        draftRevision: 1,
        expectedDraftRevision: 0,
      },
    );
    await assertUnavailableResponse(noncanonicalUpdateResponse, noncanonicalAsset.id);
    assert.deepEqual(
      await projects.getEditorProject(alice.id, noncanonicalProject.id),
      noncanonicalProject,
      "noncanonical Logo id cannot mutate the project or its exact draft candidate",
    );
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: noncanonicalAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      noncanonicalAssetBefore,
      "noncanonical Logo id cannot restore or advance lifecycle state",
    );
    const projectCountBeforeNoncanonicalCreate = await prisma.editorProject.count({
      where: { userId: alice.id },
    });
    await assert.rejects(
      projects.createEditorProject(alice.id, {
        title: "Reject noncanonical Logo create",
        draft: noncanonicalDraft,
      }),
      hasCode("brand_asset_unavailable"),
    );
    assert.equal(
      await prisma.editorProject.count({ where: { userId: alice.id } }),
      projectCountBeforeNoncanonicalCreate,
      "noncanonical Logo id prevents project creation",
    );
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: noncanonicalAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      noncanonicalAssetBefore,
      "noncanonical create cannot restore or advance lifecycle state",
    );

    const activeUpdateProject = await projects.createEditorProject(alice.id, {
      title: "Active Logo update",
      draft: { script: "active base" },
    });
    const activeUpdateAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: activeUpdateProject.id,
      label: "active-update",
    });
    const activeUpdateBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: activeUpdateAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    assert.equal(activeUpdateBefore.retiredAt, null);
    const activeUpdateResponse = await patchEditorProjectForUser(alice.id, activeUpdateProject.id, {
      draft: logoDraft(activeUpdateAsset.id, "active update accepted"),
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    const activeUpdatePayload = await activeUpdateResponse.json() as {
      project?: { draft?: { logoOverlay?: { assetId?: string } } };
    };
    assert.equal(activeUpdateResponse.status, 200);
    assert.equal(activeUpdatePayload.project?.draft?.logoOverlay?.assetId, activeUpdateAsset.id);
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: activeUpdateAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      { retiredAt: null, lifecycleRevision: activeUpdateBefore.lifecycleRevision + 1 },
      "draft update claims an already-active Logo lifecycle",
    );

    const activeCreateAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: activeUpdateProject.id,
      label: "active-create",
    });
    const activeCreateBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: activeCreateAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    assert.equal(activeCreateBefore.retiredAt, null);
    const activeCreateProject = await projects.createEditorProject(alice.id, {
      title: "Active Logo create",
      draft: logoDraft(activeCreateAsset.id, "active create accepted"),
    });
    assert.equal(activeCreateProject.draft.logoOverlay.assetId, activeCreateAsset.id);
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: activeCreateAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      { retiredAt: null, lifecycleRevision: activeCreateBefore.lifecycleRevision + 1 },
      "project create claims an already-active Logo lifecycle",
    );

    await lifecycleVerification.observeEditorProjectBrandAssetVerificationStep(
      "after-asset-prepare",
    );
    await lifecycleVerification.observeEditorProjectBrandAssetVerificationStep(
      "after-project-cas",
    );

    const retirementWinsProject = await projects.createEditorProject(alice.id, {
      title: "Real retirement wins",
      draft: { script: "retirement winner base" },
    });
    const retirementWinsAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: retirementWinsProject.id,
      label: "real-retirement-wins",
    });
    const retirementPrepareReached = deferred<void>();
    const allowRetirementWinnerProject = deferred<void>();
    const retirementWinsPatch = lifecycleVerification
      .runWithEditorProjectBrandAssetVerificationBarrier(
        async (step) => {
          if (step !== "after-asset-prepare") return;
          retirementPrepareReached.resolve();
          await allowRetirementWinnerProject.promise;
        },
        () => patchEditorProjectForUser(alice.id, retirementWinsProject.id, {
          draft: logoDraft(retirementWinsAsset.id, "retirement won before project tx"),
          draftRevision: 1,
          expectedDraftRevision: 0,
        }),
      );
    await withTimeout(retirementPrepareReached.promise, "retirement-winner prepare barrier");
    const retirementWinnerWorker = startRetirementWorker(alice.id, retirementWinsAsset.id);
    let retirementWinnerOutcome: RetirementWorkerOutcome | undefined;
    let retirementWinnerError: unknown;
    try {
      await retirementWinnerWorker.ready;
      await retirementWinnerWorker.invoking;
      retirementWinnerOutcome = await retirementWinnerWorker.result;
    } catch (error) {
      retirementWinnerError = error;
    } finally {
      allowRetirementWinnerProject.resolve();
    }
    const retirementWinsResponse = await retirementWinsPatch;
    await retirementWinnerWorker.cleanup();
    if (retirementWinnerError) throw retirementWinnerError;
    assert.deepEqual(
      retirementWinnerOutcome,
      { kind: "returned", value: true },
      "independent real retirement commits while project recovery is paused after preparation",
    );
    const retirementWinsPayload = await retirementWinsResponse.json() as Record<string, unknown>;
    assert.equal(retirementWinsResponse.status, 409);
    assert.equal(retirementWinsPayload.error, "brand_asset_lifecycle_conflict");
    assert.equal(Object.prototype.hasOwnProperty.call(retirementWinsPayload, "project"), false);
    assert.deepEqual(
      await projects.getEditorProject(alice.id, retirementWinsProject.id),
      retirementWinsProject,
      "retirement winner prevents the prepared project write from committing",
    );
    const retirementWinnerAsset = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: retirementWinsAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    assert.ok(retirementWinnerAsset.retiredAt);
    assert.equal(retirementWinnerAsset.lifecycleRevision, 1);

    const recoveryWinsProject = await projects.createEditorProject(alice.id, {
      title: "Real recovery wins",
      draft: { script: "recovery winner base" },
    });
    const recoveryWinsAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: recoveryWinsProject.id,
      label: "real-recovery-wins",
    });
    const recoveryCasReached = deferred<void>();
    const allowRecoveryWinner = deferred<void>();
    const recoveryWinsPatch = lifecycleVerification
      .runWithEditorProjectBrandAssetVerificationBarrier(
        async (step) => {
          if (step !== "after-project-cas") return;
          recoveryCasReached.resolve();
          await allowRecoveryWinner.promise;
        },
        () => patchEditorProjectForUser(alice.id, recoveryWinsProject.id, {
          draft: logoDraft(recoveryWinsAsset.id, "recovery commits active reference"),
          draftRevision: 1,
          expectedDraftRevision: 0,
        }),
      );
    await withTimeout(recoveryCasReached.promise, "recovery-winner CAS barrier");
    const recoveryLoserWorker = startRetirementWorker(alice.id, recoveryWinsAsset.id);
    let recoveryLoserOutcome: RetirementWorkerOutcome | undefined;
    let recoveryRaceError: unknown;
    let recoveryWorkerSettled = false;
    void recoveryLoserWorker.result.then(
      () => { recoveryWorkerSettled = true; },
      () => { recoveryWorkerSettled = true; },
    );
    try {
      await recoveryLoserWorker.ready;
      await recoveryLoserWorker.invoking;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        recoveryWorkerSettled,
        false,
        "independent real retirement remains pending while project CAS owns the write transaction",
      );
    } catch (error) {
      recoveryRaceError = error;
    } finally {
      allowRecoveryWinner.resolve();
    }
    const recoveryWinsResponse = await recoveryWinsPatch;
    try {
      recoveryLoserOutcome = await recoveryLoserWorker.result;
    } catch (error) {
      recoveryRaceError ??= error;
    }
    await recoveryLoserWorker.cleanup();
    if (recoveryRaceError) throw recoveryRaceError;
    assert.equal(recoveryWinsResponse.status, 200);
    assert.deepEqual(
      recoveryLoserOutcome,
      { kind: "brand-error", code: "asset_in_use", status: 409 },
      "independent real retirement observes the committed project reference and loses explicitly",
    );
    const recoveryWinnerProject = await projects.getEditorProject(alice.id, recoveryWinsProject.id);
    assert.equal(recoveryWinnerProject?.draft.logoOverlay.assetId, recoveryWinsAsset.id);
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: recoveryWinsAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      { retiredAt: null, lifecycleRevision: 1 },
      "recovery winner leaves an active lifecycle-claimed Logo referenced by the committed project",
    );

    const recoveryProject = await projects.createEditorProject(alice.id, {
      title: "Recover retired logo",
      draft: { script: "initial" },
    });
    await updateWithRevision(alice.id, recoveryProject.id, {
      draft: { script: "confirmed base" },
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    const recoveryAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: recoveryProject.id,
      label: "recover-retired",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, recoveryAsset.id), true);
    const retiredBeforeRecovery = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: recoveryAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    assert.ok(retiredBeforeRecovery.retiredAt);
    const recoveredResponse = await patchEditorProjectForUser(alice.id, recoveryProject.id, {
      draft: logoDraft(recoveryAsset.id, "stale local with logo"),
      draftRevision: 2,
      expectedDraftRevision: 1,
    });
    assert.equal(recoveredResponse.status, 200);
    const recoveredPayload = await recoveredResponse.json() as { project?: { draft?: { logoOverlay?: { assetId?: string } } } };
    assert.equal(recoveredPayload.project?.draft?.logoOverlay?.assetId, recoveryAsset.id);
    const restored = await prisma.brandAsset.findUniqueOrThrow({ where: { id: recoveryAsset.id } });
    assert.equal(restored.retiredAt, null, "accepted local choice restores its retained logo");
    assert.equal(
      restored.lifecycleRevision,
      retiredBeforeRecovery.lifecycleRevision + 1,
      "accepted local choice advances the lifecycle revision exactly once",
    );
    assert.equal(
      (await projects.getEditorProject(alice.id, recoveryProject.id))?.draft.logoOverlay.assetId,
      recoveryAsset.id,
    );
    assert.ok(await brandAssets.getBrandAssetPath(alice.id, recoveryAsset.id));
    await projects.updateEditorProject(alice.id, recoveryProject.id, {
      title: "Metadata does not claim Logo",
      touchLastOpened: true,
    });
    assert.equal(
      (await prisma.brandAsset.findUniqueOrThrow({ where: { id: recoveryAsset.id } })).lifecycleRevision,
      restored.lifecycleRevision,
      "metadata-only PATCHes do not advance Logo lifecycle state",
    );

    const missingRowProject = await projects.createEditorProject(alice.id, {
      title: "Missing Logo row",
      draft: { script: "confirmed" },
    });
    const missingAssetId = "task3-missing-logo-row";
    const missingRowResponse = await patchEditorProjectForUser(alice.id, missingRowProject.id, {
      draft: logoDraft(missingAssetId, "must not persist missing row"),
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    await assertUnavailableResponse(missingRowResponse, missingAssetId);
    assert.deepEqual(
      await projects.getEditorProject(alice.id, missingRowProject.id),
      missingRowProject,
      "missing Logo row leaves the project unchanged",
    );

    for (const fileKind of ["missing", "directory", "symlink"] as const) {
      const unavailableProject = await projects.createEditorProject(alice.id, {
        title: `Unavailable Logo ${fileKind}`,
        draft: { script: "confirmed" },
      });
      const unavailableAsset = await createBrandAssetFixture({
        userId: alice.id,
        projectId: unavailableProject.id,
        label: `unavailable-${fileKind}`,
        fileKind,
      });
      const beforeUnavailable = await prisma.brandAsset.findUniqueOrThrow({
        where: { id: unavailableAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      });
      const unavailableResponse = await patchEditorProjectForUser(alice.id, unavailableProject.id, {
        draft: logoDraft(unavailableAsset.id, `must not persist ${fileKind}`),
        draftRevision: 1,
        expectedDraftRevision: 0,
      });
      await assertUnavailableResponse(unavailableResponse, unavailableAsset.id);
      assert.deepEqual(
        await prisma.brandAsset.findUniqueOrThrow({
          where: { id: unavailableAsset.id },
          select: { retiredAt: true, lifecycleRevision: true },
        }),
        beforeUnavailable,
        `${fileKind} Logo validation leaves lifecycle state unchanged`,
      );
      assert.equal(
        (await projects.getEditorProject(alice.id, unavailableProject.id))?.draft.script,
        "confirmed",
        `${fileKind} Logo validation leaves the project unchanged`,
      );
    }

    const crossOwnerProject = await projects.createEditorProject(alice.id, {
      title: "Cross-owner Logo",
      draft: { script: "confirmed" },
    });
    const bobAssetProject = await projects.createEditorProject(bob.id, {
      title: "Bob Logo owner",
      draft: { script: "bob confirmed" },
    });
    const crossOwnerAsset = await createBrandAssetFixture({
      userId: bob.id,
      projectId: bobAssetProject.id,
      label: "cross-owner",
    });
    const crossOwnerBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: crossOwnerAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    const crossOwnerResponse = await patchEditorProjectForUser(alice.id, crossOwnerProject.id, {
      draft: logoDraft(crossOwnerAsset.id, "must not persist cross-owner"),
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    await assertUnavailableResponse(crossOwnerResponse, crossOwnerAsset.id);
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: crossOwnerAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      crossOwnerBefore,
      "cross-owner validation cannot mutate the other owner's asset",
    );

    const staleAssetProject = await projects.createEditorProject(alice.id, {
      title: "Stale project must not recover Logo",
      draft: { script: "initial" },
    });
    await updateWithRevision(alice.id, staleAssetProject.id, {
      draft: { script: "server winner" },
      draftRevision: 1,
      expectedDraftRevision: 0,
    });
    const staleAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: staleAssetProject.id,
      label: "stale-project",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, staleAsset.id), true);
    const staleAssetBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: staleAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    const staleAssetResponse = await patchEditorProjectForUser(alice.id, staleAssetProject.id, {
      draft: logoDraft(staleAsset.id, "stale local loser"),
      draftRevision: 2,
      expectedDraftRevision: 0,
    });
    const staleAssetPayload = await staleAssetResponse.json() as Record<string, unknown>;
    assert.equal(staleAssetResponse.status, 409);
    assert.equal(staleAssetPayload.error, "stale_revision");
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: staleAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      staleAssetBefore,
      "a stale project CAS leaves retiredAt and lifecycleRevision unchanged",
    );
    assert.equal(
      (await projects.getEditorProject(alice.id, staleAssetProject.id))?.draft.script,
      "server winner",
    );

    const barrierProject = await projects.createEditorProject(alice.id, {
      title: "Lifecycle barrier",
      draft: { script: "confirmed" },
    });
    const barrierAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: barrierProject.id,
      label: "lifecycle-barrier",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, barrierAsset.id), true);
    const barrierProjectBefore = await projects.getEditorProject(alice.id, barrierProject.id);
    const barrierAssetBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: barrierAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER task3_retirement_wins_after_project_cas
      AFTER UPDATE OF draftJson ON EditorProject
      WHEN NEW.id = '${barrierProject.id}'
      BEGIN
        UPDATE BrandAsset
        SET retiredAt = CURRENT_TIMESTAMP,
            lifecycleRevision = lifecycleRevision + 1
        WHERE id = '${barrierAsset.id}';
      END
    `);
    let barrierResponse: Response;
    try {
      barrierResponse = await patchEditorProjectForUser(alice.id, barrierProject.id, {
        draft: logoDraft(barrierAsset.id, "recovery loses controlled barrier"),
        draftRevision: 1,
        expectedDraftRevision: 0,
      });
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS task3_retirement_wins_after_project_cas");
    }
    const barrierPayload = await barrierResponse.json() as Record<string, unknown>;
    assert.equal(barrierResponse.status, 409);
    assert.equal(barrierPayload.error, "brand_asset_lifecycle_conflict");
    assert.equal(Object.prototype.hasOwnProperty.call(barrierPayload, "project"), false);
    assert.deepEqual(
      await projects.getEditorProject(alice.id, barrierProject.id),
      barrierProjectBefore,
      "a failed asset CAS rolls back the project write",
    );
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: barrierAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      barrierAssetBefore,
      "the controlled lifecycle barrier is rolled back with the transaction",
    );

    const createRecoveryAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: recoveryProject.id,
      label: "create-recovery",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, createRecoveryAsset.id), true);
    const createdWithRecoveredLogo = await projects.createEditorProject(alice.id, {
      title: "Create with retained Logo",
      draft: logoDraft(createRecoveryAsset.id, "created with retained logo"),
    });
    assert.equal(createdWithRecoveredLogo.draft.logoOverlay.assetId, createRecoveryAsset.id);
    assert.equal(
      (await prisma.brandAsset.findUniqueOrThrow({ where: { id: createRecoveryAsset.id } })).retiredAt,
      null,
      "draft-bearing create restores its retained logo",
    );

    const createMissingCount = await prisma.editorProject.count({ where: { userId: alice.id } });
    await assert.rejects(
      projects.createEditorProject(alice.id, {
        title: "Create missing Logo",
        draft: logoDraft("task3-create-missing-logo", "must not create"),
      }),
      hasCode("brand_asset_unavailable"),
    );
    assert.equal(
      await prisma.editorProject.count({ where: { userId: alice.id } }),
      createMissingCount,
      "unavailable Logo validation prevents project creation",
    );

    const createBarrierAsset = await createBrandAssetFixture({
      userId: alice.id,
      projectId: recoveryProject.id,
      label: "create-barrier",
    });
    assert.equal(await brandAssets.deleteBrandAssetIfUnreferenced(alice.id, createBarrierAsset.id), true);
    const createBarrierBefore = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: createBarrierAsset.id },
      select: { retiredAt: true, lifecycleRevision: true },
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER task3_create_lifecycle_barrier
      AFTER INSERT ON EditorProject
      WHEN NEW.title = 'Create lifecycle barrier'
      BEGIN
        UPDATE BrandAsset
        SET lifecycleRevision = lifecycleRevision + 1
        WHERE id = '${createBarrierAsset.id}';
      END
    `);
    try {
      await assert.rejects(
        projects.createEditorProject(alice.id, {
          title: "Create lifecycle barrier",
          draft: logoDraft(createBarrierAsset.id, "must roll back create"),
        }),
        hasCode("brand_asset_lifecycle_conflict"),
      );
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS task3_create_lifecycle_barrier");
    }
    assert.equal(
      await prisma.editorProject.count({ where: { title: "Create lifecycle barrier" } }),
      0,
      "failed create asset CAS rolls back the project row",
    );
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: createBarrierAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      createBarrierBefore,
      "failed create asset CAS rolls back the controlled lifecycle change",
    );
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
