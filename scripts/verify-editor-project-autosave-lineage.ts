// Run with: npx tsx scripts/verify-editor-project-autosave-lineage.ts
import assert from "node:assert/strict";
import {
  createEditorProjectAutosaveCandidate,
  createEditorProjectAutosaveSnapshot,
  decideEditorProjectAutosaveObservation,
  type EditorProjectAutosaveCandidate,
  type EditorProjectAutosaveSnapshot,
} from "../src/lib/editor-project-autosave-lineage";
import { materializeEditorProjectDraft } from "../src/lib/editor-project-recovery-journal";

function candidate(
  projectId: string,
  revision: number,
  draft: unknown,
): EditorProjectAutosaveCandidate {
  const value = createEditorProjectAutosaveCandidate({ projectId, revision, draft });
  assert.ok(value, `expected revision ${revision} candidate to be valid`);
  return value;
}

function snapshot(
  projectId: string,
  expectedDraftRevision: number,
  revision: number,
  draft: unknown,
): EditorProjectAutosaveSnapshot {
  const value = createEditorProjectAutosaveSnapshot({
    projectId,
    expectedDraftRevision,
    revision,
    draft,
  });
  assert.ok(value, `expected revision ${revision} snapshot to be valid`);
  return value;
}

function main(): void {
  const projectId = "project-a";
  const reorderedA = candidate(projectId, 1, {
    title: "same",
    nested: { z: 3, a: 1 },
  });
  const reorderedB = candidate(projectId, 1, {
    nested: { a: 1, z: 3 },
    title: "same",
  });
  assert.equal(
    reorderedA.fingerprint,
    reorderedB.fingerprint,
    "object insertion order does not affect a draft fingerprint",
  );
  assert.notEqual(
    candidate(projectId, 1, { clips: ["intro", "outro"] }).fingerprint,
    candidate(projectId, 1, { clips: ["outro", "intro"] }).fingerprint,
    "array order remains significant",
  );

  const mutableInput = {
    timeline: [{ settings: { voice: "before", speed: 1 } }],
  };
  const immutableCandidate = candidate(projectId, 2, mutableInput);
  mutableInput.timeline[0].settings.voice = "after";
  mutableInput.timeline.push({ settings: { voice: "added", speed: 2 } });
  assert.deepEqual(immutableCandidate.draft, {
    timeline: [{ settings: { voice: "before", speed: 1 } }],
  }, "candidate drafts do not alias nested constructor input");
  assert.equal(
    immutableCandidate.fingerprint,
    candidate(projectId, 2, {
      timeline: [{ settings: { voice: "before", speed: 1 } }],
    }).fingerprint,
    "input mutation cannot change the candidate fingerprint",
  );

  const nullPrototypeDraft = Object.assign(Object.create(null) as Record<string, unknown>, {
    safe: "value",
  });
  assert.deepEqual(materializeEditorProjectDraft(nullPrototypeDraft), { safe: "value" });

  class DraftInstance {
    script = "class-instance";
  }
  const inheritedDraft = Object.assign(Object.create({ inherited: true }), { own: "value" });
  const cyclicDraft: Record<string, unknown> = {};
  cyclicDraft.self = cyclicDraft;
  const sparseArray = new Array(2);
  sparseArray[0] = "clip";
  const extendedArray = ["clip"] as unknown[] & { extra?: string };
  extendedArray.extra = "not-json-array-data";
  const symbolKeyDraft = { value: "safe" } as Record<PropertyKey, unknown>;
  symbolKeyDraft[Symbol("hidden")] = "hidden";
  let accessorReads = 0;
  const accessorValue: Record<string, unknown> = {};
  Object.defineProperty(accessorValue, "script", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "unsafe";
    },
  });
  const unsafeDrafts: Array<[string, unknown]> = [
    ["accessor", accessorValue],
    ["inherited properties", inheritedDraft],
    ["class instance", { value: new DraftInstance() }],
    ["cycle", cyclicDraft],
    ["sparse array", { value: sparseArray }],
    ["extended array", { value: extendedArray }],
    ["symbol value", { value: Symbol("unsafe") }],
    ["symbol key", symbolKeyDraft],
    ["undefined", { value: undefined }],
    ["bigint", { value: 1n }],
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["negative infinity", { value: Number.NEGATIVE_INFINITY }],
  ];
  for (const [label, draft] of unsafeDrafts) {
    assert.equal(
      materializeEditorProjectDraft(draft),
      null,
      `${label} is rejected by strict draft materialization`,
    );
    assert.equal(
      createEditorProjectAutosaveCandidate({ projectId, revision: 1, draft }),
      null,
      `${label} cannot be fingerprinted as an autosave candidate`,
    );
  }
  assert.equal(accessorReads, 0, "accessors are rejected without invocation");

  const invalidRevisions = [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    2_147_483_648,
  ];
  assert.equal(
    createEditorProjectAutosaveCandidate({ projectId: "   ", revision: 1, draft: {} }),
    null,
    "blank project ids are rejected",
  );
  for (const revision of invalidRevisions) {
    assert.equal(
      createEditorProjectAutosaveCandidate({ projectId, revision, draft: {} }),
      null,
      `candidate revision ${String(revision)} is rejected`,
    );
    assert.equal(
      createEditorProjectAutosaveSnapshot({
        projectId,
        expectedDraftRevision: 0,
        revision,
        draft: {},
      }),
      null,
      `snapshot revision ${String(revision)} is rejected`,
    );
  }
  assert.equal(
    createEditorProjectAutosaveSnapshot({
      projectId,
      expectedDraftRevision: 2,
      revision: 2,
      draft: {},
    }),
    null,
    "an attempt revision must be above its expected revision",
  );

  const rev0 = candidate(projectId, 0, { script: "base" });
  const rev1A = candidate(projectId, 1, { script: "A" });
  const rev1B = candidate(projectId, 1, { script: "B" });
  const rev2B = candidate(projectId, 2, { script: "B" });
  const attemptRev1A = snapshot(projectId, 0, 1, { script: "A" });
  const attemptRev1B = snapshot(projectId, 0, 1, { script: "B" });
  const attemptRev2B = snapshot(projectId, 1, 2, { script: "B" });

  assert.deepEqual(
    decideEditorProjectAutosaveObservation({
      attempt: attemptRev1A,
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: rev1A,
    }),
    { kind: "saved", confirmed: rev1A },
  );
  assert.deepEqual(
    decideEditorProjectAutosaveObservation({
      attempt: attemptRev1A,
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: rev0,
    }),
    { kind: "retry", confirmed: rev0 },
  );
  const divergentRev0 = candidate(projectId, 0, { script: "divergent-base" });
  assert.deepEqual(
    decideEditorProjectAutosaveObservation({
      attempt: attemptRev1A,
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: divergentRev0,
    }),
    { kind: "conflict", server: divergentRev0 },
    "a confirmed revision match without a fingerprint match does not prove lineage",
  );
  assert.deepEqual(
    decideEditorProjectAutosaveObservation({
      attempt: attemptRev2B,
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: rev1A,
    }),
    { kind: "retry", confirmed: rev1A },
  );
  assert.deepEqual(
    decideEditorProjectAutosaveObservation({
      attempt: attemptRev1B,
      confirmed: rev0,
      issued: new Map([[1, rev1B]]),
      observed: rev1A,
    }),
    { kind: "conflict", server: rev1A },
    "a revision match without a fingerprint match never proves issued lineage",
  );

  const otherProject = candidate("project-b", 0, { script: "base" });
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: attemptRev1A,
      confirmed: otherProject,
      issued: new Map([[1, rev1A]]),
      observed: rev1A,
    }),
    /project/i,
    "decision inputs must all belong to one project",
  );
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: { ...attemptRev1A, revision: -1 },
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: rev1A,
    }),
    /revision/i,
    "invalid decision revisions are rejected",
  );
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: { ...attemptRev1A, expectedDraftRevision: 1 },
      confirmed: rev0,
      issued: new Map([[1, rev1A]]),
      observed: rev1A,
    }),
    /revision/i,
    "a decision attempt must be above its expected revision",
  );
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: attemptRev1A,
      confirmed: rev0,
      issued: new Map([[2, rev1A]]),
      observed: rev1A,
    }),
    /issued.*revision/i,
    "issued map keys must equal their candidate revisions",
  );

  console.log("editor project autosave lineage verification passed");
}

main();
