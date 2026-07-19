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

function assertReturnsNullWithoutThrow(label: string, operation: () => unknown): void {
  let result: unknown = Symbol("operation did not complete");
  assert.doesNotThrow(() => {
    result = operation();
  }, `${label} does not throw`);
  assert.equal(result, null, `${label} fails closed with null`);
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

  const hostileDraftProxy = new Proxy<Record<string, unknown>>({}, {
    getPrototypeOf() {
      throw new Error("hostile draft proxy");
    },
  });
  assertReturnsNullWithoutThrow(
    "hostile proxy draft materialization",
    () => materializeEditorProjectDraft(hostileDraftProxy),
  );
  assertReturnsNullWithoutThrow(
    "hostile proxy candidate draft",
    () => createEditorProjectAutosaveCandidate({
      projectId,
      revision: 1,
      draft: hostileDraftProxy,
    }),
  );
  assertReturnsNullWithoutThrow(
    "hostile proxy snapshot draft",
    () => createEditorProjectAutosaveSnapshot({
      projectId,
      expectedDraftRevision: 0,
      revision: 1,
      draft: hostileDraftProxy,
    }),
  );
  const revokedDraft = Proxy.revocable<Record<string, unknown>>({}, {});
  revokedDraft.revoke();
  assertReturnsNullWithoutThrow(
    "revoked proxy draft materialization",
    () => materializeEditorProjectDraft(revokedDraft.proxy),
  );
  assertReturnsNullWithoutThrow(
    "revoked proxy candidate draft",
    () => createEditorProjectAutosaveCandidate({
      projectId,
      revision: 1,
      draft: revokedDraft.proxy,
    }),
  );
  assertReturnsNullWithoutThrow(
    "revoked proxy snapshot draft",
    () => createEditorProjectAutosaveSnapshot({
      projectId,
      expectedDraftRevision: 0,
      revision: 1,
      draft: revokedDraft.proxy,
    }),
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

  const candidateEnvelope = { projectId, revision: 1, draft: { script: "candidate" } };
  for (const key of ["projectId", "revision", "draft"] as const) {
    let getterReads = 0;
    const accessorEnvelope = { ...candidateEnvelope };
    const fieldValue = accessorEnvelope[key];
    Object.defineProperty(accessorEnvelope, key, {
      enumerable: true,
      get() {
        getterReads += 1;
        return fieldValue;
      },
    });
    assertReturnsNullWithoutThrow(
      `candidate envelope ${key} accessor`,
      () => createEditorProjectAutosaveCandidate(accessorEnvelope),
    );
    assert.equal(getterReads, 0, `candidate envelope ${key} getter is never invoked`);
  }
  const inheritedCandidateEnvelope = Object.assign(Object.create({ projectId }), {
    revision: 1,
    draft: {},
  }) as Parameters<typeof createEditorProjectAutosaveCandidate>[0];
  assertReturnsNullWithoutThrow(
    "inherited candidate envelope field",
    () => createEditorProjectAutosaveCandidate(inheritedCandidateEnvelope),
  );
  const nonEnumerableCandidateEnvelope = { ...candidateEnvelope };
  Object.defineProperty(nonEnumerableCandidateEnvelope, "projectId", {
    enumerable: false,
    value: projectId,
  });
  assertReturnsNullWithoutThrow(
    "non-enumerable candidate envelope field",
    () => createEditorProjectAutosaveCandidate(nonEnumerableCandidateEnvelope),
  );
  const hostileCandidateEnvelope = new Proxy(candidateEnvelope, {
    getOwnPropertyDescriptor() {
      throw new Error("hostile candidate envelope proxy");
    },
  });
  assertReturnsNullWithoutThrow(
    "hostile candidate envelope proxy",
    () => createEditorProjectAutosaveCandidate(hostileCandidateEnvelope),
  );
  const revokedCandidateEnvelope = Proxy.revocable(candidateEnvelope, {});
  revokedCandidateEnvelope.revoke();
  assertReturnsNullWithoutThrow(
    "revoked candidate envelope proxy",
    () => createEditorProjectAutosaveCandidate(revokedCandidateEnvelope.proxy),
  );

  const snapshotEnvelope = {
    projectId,
    expectedDraftRevision: 0,
    revision: 1,
    draft: { script: "snapshot" },
  };
  for (
    const key of ["projectId", "expectedDraftRevision", "revision", "draft"] as const
  ) {
    let getterReads = 0;
    const accessorEnvelope = { ...snapshotEnvelope };
    const fieldValue = accessorEnvelope[key];
    Object.defineProperty(accessorEnvelope, key, {
      enumerable: true,
      get() {
        getterReads += 1;
        return fieldValue;
      },
    });
    assertReturnsNullWithoutThrow(
      `snapshot envelope ${key} accessor`,
      () => createEditorProjectAutosaveSnapshot(accessorEnvelope),
    );
    assert.equal(getterReads, 0, `snapshot envelope ${key} getter is never invoked`);
  }
  const inheritedSnapshotEnvelope = Object.assign(
    Object.create({ expectedDraftRevision: 0 }),
    { projectId, revision: 1, draft: {} },
  ) as Parameters<typeof createEditorProjectAutosaveSnapshot>[0];
  assertReturnsNullWithoutThrow(
    "inherited snapshot envelope field",
    () => createEditorProjectAutosaveSnapshot(inheritedSnapshotEnvelope),
  );
  const nonEnumerableSnapshotEnvelope = { ...snapshotEnvelope };
  Object.defineProperty(nonEnumerableSnapshotEnvelope, "expectedDraftRevision", {
    enumerable: false,
    value: 0,
  });
  assertReturnsNullWithoutThrow(
    "non-enumerable snapshot envelope field",
    () => createEditorProjectAutosaveSnapshot(nonEnumerableSnapshotEnvelope),
  );
  const hostileSnapshotEnvelope = new Proxy(snapshotEnvelope, {
    ownKeys() {
      throw new Error("hostile snapshot envelope proxy");
    },
  });
  assertReturnsNullWithoutThrow(
    "hostile snapshot envelope proxy",
    () => createEditorProjectAutosaveSnapshot(hostileSnapshotEnvelope),
  );
  const revokedSnapshotEnvelope = Proxy.revocable(snapshotEnvelope, {});
  revokedSnapshotEnvelope.revoke();
  assertReturnsNullWithoutThrow(
    "revoked snapshot envelope proxy",
    () => createEditorProjectAutosaveSnapshot(revokedSnapshotEnvelope.proxy),
  );

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

  const frozenCandidate = candidate(projectId, 3, {
    nested: { clips: [{ name: "frozen" }] },
  });
  assert.equal(Object.isFrozen(frozenCandidate), true, "candidate DTO is frozen");
  assert.equal(Object.isFrozen(frozenCandidate.draft), true, "candidate draft is frozen");
  const frozenNested = frozenCandidate.draft.nested as { clips: Array<{ name: string }> };
  assert.equal(Object.isFrozen(frozenNested), true, "nested candidate object is frozen");
  assert.equal(Object.isFrozen(frozenNested.clips), true, "nested candidate array is frozen");
  assert.equal(Object.isFrozen(frozenNested.clips[0]), true, "object inside candidate array is frozen");
  const frozenSnapshot = snapshot(projectId, 2, 3, {
    nested: { clips: [{ name: "frozen" }] },
  });
  assert.equal(Object.isFrozen(frozenSnapshot), true, "snapshot DTO is frozen");

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

  const otherProjectRev1A = candidate("project-b", 1, { script: "A" });
  class SplitIssuedMap extends Map<number, EditorProjectAutosaveCandidate> {
    getCalls = 0;

    override get(key: number): EditorProjectAutosaveCandidate | undefined {
      this.getCalls += 1;
      return key === 1 ? otherProjectRev1A : undefined;
    }
  }
  const splitIssued = new SplitIssuedMap([[1, rev1A]]);
  let splitDecision: ReturnType<typeof decideEditorProjectAutosaveObservation> | null = null;
  assert.doesNotThrow(() => {
    splitDecision = decideEditorProjectAutosaveObservation({
      attempt: attemptRev2B,
      confirmed: rev0,
      issued: splitIssued,
      observed: rev1A,
    });
  }, "caller-controlled issued get cannot replace an iterated candidate");
  assert.equal(splitIssued.getCalls, 0, "decision never calls the caller-controlled issued get");
  assert.deepEqual(splitDecision, { kind: "retry", confirmed: rev1A });

  class ThrowingGetIssuedMap extends Map<number, EditorProjectAutosaveCandidate> {
    getCalls = 0;

    override get(): EditorProjectAutosaveCandidate | undefined {
      this.getCalls += 1;
      throw new Error("hostile issued get");
    }
  }
  const throwingGetIssued = new ThrowingGetIssuedMap([[1, rev1A]]);
  assert.doesNotThrow(() => decideEditorProjectAutosaveObservation({
    attempt: attemptRev2B,
    confirmed: rev0,
    issued: throwingGetIssued,
    observed: rev1A,
  }), "a hostile unused issued get cannot affect the decision");
  assert.equal(throwingGetIssued.getCalls, 0, "hostile issued get is never invoked");

  class DuplicateIssuedMap extends Map<number, EditorProjectAutosaveCandidate> {
    override *[Symbol.iterator](): MapIterator<[number, EditorProjectAutosaveCandidate]> {
      yield [1, rev1A];
      yield [1, rev1B];
    }
  }
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: attemptRev2B,
      confirmed: rev0,
      issued: new DuplicateIssuedMap(),
      observed: rev1A,
    }),
    /duplicate.*issued/i,
    "duplicate keys from a hostile issued iterator are rejected",
  );

  class ThrowingIteratorIssuedMap extends Map<number, EditorProjectAutosaveCandidate> {
    override [Symbol.iterator](): MapIterator<[number, EditorProjectAutosaveCandidate]> {
      throw new Error("hostile issued iterator");
    }
  }
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: attemptRev2B,
      confirmed: rev0,
      issued: new ThrowingIteratorIssuedMap(),
      observed: rev1A,
    }),
    /hostile issued iterator/,
    "hostile issued iteration fails closed through the decision API",
  );
  assert.throws(
    () => decideEditorProjectAutosaveObservation({
      attempt: attemptRev2B,
      confirmed: rev0,
      issued: new Map([[1, otherProjectRev1A]]),
      observed: rev1A,
    }),
    /project/i,
    "an iterated issued candidate from another project is rejected",
  );

  const callerOwnedDraft = {
    timeline: [{ settings: { voice: "before" } }],
  };
  const callerOwnedFingerprint = candidate(projectId, 1, callerOwnedDraft).fingerprint;
  const callerOwnedObserved: EditorProjectAutosaveCandidate = {
    projectId,
    revision: 1,
    draft: callerOwnedDraft,
    fingerprint: callerOwnedFingerprint,
  };
  const normalizedSavedDecision = decideEditorProjectAutosaveObservation({
    attempt: snapshot(projectId, 0, 1, {
      timeline: [{ settings: { voice: "before" } }],
    }),
    confirmed: rev0,
    issued: new Map([[1, callerOwnedObserved]]),
    observed: callerOwnedObserved,
  });
  assert.equal(normalizedSavedDecision.kind, "saved");
  if (normalizedSavedDecision.kind !== "saved") throw new Error("expected saved decision");
  assert.notEqual(
    normalizedSavedDecision.confirmed,
    callerOwnedObserved,
    "decision output never aliases the caller-owned observed candidate",
  );
  assert.notEqual(
    normalizedSavedDecision.confirmed.draft,
    callerOwnedDraft,
    "decision output never aliases the caller-owned observed draft",
  );
  callerOwnedDraft.timeline[0].settings.voice = "after";
  callerOwnedDraft.timeline.push({ settings: { voice: "added" } });
  assert.deepEqual(normalizedSavedDecision.confirmed.draft, {
    timeline: [{ settings: { voice: "before" } }],
  }, "caller mutation after the decision cannot change its output");
  assert.equal(Object.isFrozen(normalizedSavedDecision.confirmed), true);
  assert.equal(Object.isFrozen(normalizedSavedDecision.confirmed.draft), true);
  const normalizedTimeline = normalizedSavedDecision.confirmed.draft.timeline as Array<{
    settings: { voice: string };
  }>;
  assert.equal(Object.isFrozen(normalizedTimeline), true);
  assert.equal(Object.isFrozen(normalizedTimeline[0]), true);
  assert.equal(Object.isFrozen(normalizedTimeline[0].settings), true);
  assert.equal(
    candidate(projectId, 1, normalizedSavedDecision.confirmed.draft).fingerprint,
    normalizedSavedDecision.confirmed.fingerprint,
    "normalized output fingerprint remains consistent with its frozen draft",
  );

  const mutableConfirmedDraft = { nested: { script: "base" } };
  const mutableConfirmed: EditorProjectAutosaveCandidate = {
    projectId,
    revision: 0,
    draft: mutableConfirmedDraft,
    fingerprint: candidate(projectId, 0, mutableConfirmedDraft).fingerprint,
  };
  const normalizedConfirmedDecision = decideEditorProjectAutosaveObservation({
    attempt: attemptRev1A,
    confirmed: mutableConfirmed,
    issued: new Map([[1, rev1A]]),
    observed: { ...mutableConfirmed, draft: { nested: { script: "base" } } },
  });
  assert.equal(normalizedConfirmedDecision.kind, "retry");
  if (normalizedConfirmedDecision.kind !== "retry") throw new Error("expected retry decision");
  assert.notEqual(
    normalizedConfirmedDecision.confirmed,
    mutableConfirmed,
    "confirmed retry output is a normalized DTO",
  );

  const mutableIssuedDraft = { nested: { script: "issued" } };
  const mutableIssued: EditorProjectAutosaveCandidate = {
    projectId,
    revision: 1,
    draft: mutableIssuedDraft,
    fingerprint: candidate(projectId, 1, mutableIssuedDraft).fingerprint,
  };
  const normalizedIssuedDecision = decideEditorProjectAutosaveObservation({
    attempt: snapshot(projectId, 1, 2, { nested: { script: "attempt" } }),
    confirmed: rev0,
    issued: new Map([[1, mutableIssued]]),
    observed: { ...mutableIssued, draft: { nested: { script: "issued" } } },
  });
  assert.equal(normalizedIssuedDecision.kind, "retry");
  if (normalizedIssuedDecision.kind !== "retry") throw new Error("expected retry decision");
  assert.notEqual(
    normalizedIssuedDecision.confirmed,
    mutableIssued,
    "issued retry output is a normalized DTO",
  );

  const mutableConflictDraft = { nested: { script: "server" } };
  const mutableConflict: EditorProjectAutosaveCandidate = {
    projectId,
    revision: 3,
    draft: mutableConflictDraft,
    fingerprint: candidate(projectId, 3, mutableConflictDraft).fingerprint,
  };
  const normalizedConflictDecision = decideEditorProjectAutosaveObservation({
    attempt: attemptRev1A,
    confirmed: rev0,
    issued: new Map([[1, rev1A]]),
    observed: mutableConflict,
  });
  assert.equal(normalizedConflictDecision.kind, "conflict");
  if (normalizedConflictDecision.kind !== "conflict") {
    throw new Error("expected conflict decision");
  }
  assert.notEqual(
    normalizedConflictDecision.server,
    mutableConflict,
    "conflict server output is a normalized DTO",
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
