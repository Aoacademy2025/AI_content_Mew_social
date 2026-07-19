// Run with: npx tsx scripts/verify-editor-project-recovery.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clearEditorProjectRecoveryJournal,
  editorProjectRecoveryKey,
  parseEditorProjectRecoveryJournal,
  readEditorProjectRecoveryJournal,
  writeEditorProjectRecoveryJournal,
  type EditorProjectRecoveryJournalV1,
  type RecoveryStorage,
} from "../src/lib/editor-project-recovery-journal";
import { decideEditorProjectBootstrap } from "../src/lib/editor-project-bootstrap";

type StorageCall = [operation: "get" | "set" | "remove", key: string];

function recordingStorage() {
  const values = new Map<string, string>();
  const calls: StorageCall[] = [];
  const storage: RecoveryStorage = {
    getItem(key) {
      calls.push(["get", key]);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(["set", key]);
      values.set(key, value);
    },
    removeItem(key) {
      calls.push(["remove", key]);
      values.delete(key);
    },
  };
  return { calls, storage, values };
}

function main(): void {
  const maxDraftRevision = 2_147_483_647;
  const projectId = "project-a";
  const localDraft = { script: "local-user-edit" };
  const journal: EditorProjectRecoveryJournalV1 = {
    version: 1,
    projectId,
    baseRevision: 4,
    editedAt: "2026-07-15T10:00:00.000Z",
    draft: localDraft,
  };

  assert.equal(editorProjectRecoveryKey(projectId), "editor-v2-recovery:project-a");
  assert.equal(editorProjectRecoveryKey("  project-a  "), "editor-v2-recovery:project-a");
  assert.throws(() => editorProjectRecoveryKey("   "), /projectId is required/);
  const parsedJournal = parseEditorProjectRecoveryJournal(journal, projectId);
  assert.deepEqual(parsedJournal, journal);
  assert.notEqual(parsedJournal, journal, "parsing materializes a new journal DTO");
  assert.notEqual(parsedJournal?.draft, journal.draft, "parsing never returns the input draft alias");

  const nestedInput = {
    version: 1 as const,
    projectId,
    baseRevision: 4,
    editedAt: "2026-07-15T10:00:00.000Z",
    draft: {
      timeline: [null, true, "clip", 12, { settings: [false, 1.5] }],
      dictionary: Object.assign(Object.create(null) as Record<string, unknown>, { voice: "mew" }),
    },
  };
  const nestedParsed = parseEditorProjectRecoveryJournal(nestedInput, projectId);
  assert.deepEqual(nestedParsed, {
    version: 1,
    projectId,
    baseRevision: 4,
    editedAt: "2026-07-15T10:00:00.000Z",
    draft: {
      timeline: [null, true, "clip", 12, { settings: [false, 1.5] }],
      dictionary: { voice: "mew" },
    },
  });
  assert.notEqual(nestedParsed?.draft.timeline, nestedInput.draft.timeline);
  assert.notEqual(
    (nestedParsed?.draft.timeline as unknown[])[4],
    nestedInput.draft.timeline[4],
    "nested objects are independently materialized",
  );
  (nestedInput.draft.timeline[4] as { settings: unknown[] }).settings[0] = true;
  assert.deepEqual(
    ((nestedParsed?.draft.timeline as Array<unknown>)[4] as { settings: unknown[] }).settings,
    [false, 1.5],
    "mutating untrusted input cannot change the parsed DTO",
  );

  const protoDraft = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}') as Record<
    string,
    unknown
  >;
  const protoParsed = parseEditorProjectRecoveryJournal({ ...journal, draft: protoDraft }, projectId);
  assert.ok(protoParsed);
  assert.equal(Object.getPrototypeOf(protoParsed.draft), Object.prototype);
  assert.equal(Object.hasOwn(protoParsed.draft, "__proto__"), true);
  assert.deepEqual(protoParsed.draft.__proto__, { polluted: true });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "cloning cannot pollute prototypes");

  const invalidJournals: Array<[string, unknown, string]> = [
    ["null", null, projectId],
    ["array", [], projectId],
    ["mismatched project", journal, "project-b"],
    ["unsupported version", { ...journal, version: 2 }, projectId],
    ["negative revision", { ...journal, baseRevision: -1 }, projectId],
    ["fractional revision", { ...journal, baseRevision: 1.5 }, projectId],
    ["revision above repository maximum", { ...journal, baseRevision: maxDraftRevision + 1 }, projectId],
    ["unsafe revision", { ...journal, baseRevision: Number.MAX_SAFE_INTEGER + 1 }, projectId],
    ["NaN revision", { ...journal, baseRevision: Number.NaN }, projectId],
    ["infinite revision", { ...journal, baseRevision: Number.POSITIVE_INFINITY }, projectId],
    ["invalid date", { ...journal, editedAt: "not-a-date" }, projectId],
    ["rolled-over calendar date", { ...journal, editedAt: "2026-02-30T10:00:00.000Z" }, projectId],
    ["locale date", { ...journal, editedAt: "July 15, 2026 10:00:00 UTC" }, projectId],
    ["offset date", { ...journal, editedAt: "2026-07-15T17:00:00.000+07:00" }, projectId],
    ["timestamp without milliseconds", { ...journal, editedAt: "2026-07-15T10:00:00Z" }, projectId],
    ["array draft", { ...journal, draft: [] }, projectId],
    ["missing draft", { ...journal, draft: null }, projectId],
  ];
  for (const [label, value, requestedProjectId] of invalidJournals) {
    assert.equal(
      parseEditorProjectRecoveryJournal(value, requestedProjectId),
      null,
      `${label} is not a trusted recovery journal`,
    );
  }

  const inheritedJournal = Object.assign(Object.create({ version: 1 }), {
    projectId,
    baseRevision: 4,
    editedAt: journal.editedAt,
    draft: { script: "inherited-version" },
  });
  assert.equal(
    parseEditorProjectRecoveryJournal(inheritedJournal, projectId),
    null,
    "journal fields must be own data properties",
  );

  let journalAccessorReads = 0;
  const accessorJournal = { ...journal } as Record<string, unknown>;
  Object.defineProperty(accessorJournal, "draft", {
    enumerable: true,
    get() {
      journalAccessorReads += 1;
      return { script: "accessor" };
    },
  });
  assert.equal(parseEditorProjectRecoveryJournal(accessorJournal, projectId), null);
  assert.equal(journalAccessorReads, 0, "journal accessors are rejected without invocation");

  const nonEnumerableJournal = { ...journal };
  Object.defineProperty(nonEnumerableJournal, "version", { value: 1, enumerable: false });
  assert.equal(
    parseEditorProjectRecoveryJournal(nonEnumerableJournal, projectId),
    null,
    "journal fields must be enumerable JSON data",
  );

  class JournalInstance {
    version = 1 as const;
    projectId = projectId;
    baseRevision = 4;
    editedAt = journal.editedAt;
    draft = { script: "class-journal" };
  }
  assert.equal(parseEditorProjectRecoveryJournal(new JournalInstance(), projectId), null);

  class DraftInstance {
    script = "class-draft";
  }
  class ArrayInstance extends Array<unknown> {}
  const cyclicDraft: Record<string, unknown> = {};
  cyclicDraft.self = cyclicDraft;
  const symbolKeyDraft = { script: "symbol-key" } as Record<PropertyKey, unknown>;
  symbolKeyDraft[Symbol("hidden")] = "hidden";
  const sparseArray = new Array(2);
  sparseArray[0] = "clip";
  const extendedArray = ["clip"] as unknown[] & { extra?: string };
  extendedArray.extra = "not-json-array-data";
  let nestedAccessorReads = 0;
  const nestedAccessorDraft: Record<string, unknown> = {};
  Object.defineProperty(nestedAccessorDraft, "script", {
    enumerable: true,
    get() {
      nestedAccessorReads += 1;
      return "accessor";
    },
  });
  const unsupportedDrafts: Array<[string, Record<string, unknown>]> = [
    ["undefined", { value: undefined }],
    ["function", { value: () => "not-json" }],
    ["symbol", { value: Symbol("not-json") }],
    ["bigint", { value: 1n }],
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["negative infinity", { value: Number.NEGATIVE_INFINITY }],
    ["Date", { value: new Date(journal.editedAt) }],
    ["Map", { value: new Map([["script", "map"]]) }],
    ["Set", { value: new Set(["set"]) }],
    ["class instance", { value: new DraftInstance() }],
    ["array subclass", { value: new ArrayInstance("clip") }],
    ["cycle", cyclicDraft],
    ["symbol key", symbolKeyDraft as Record<string, unknown>],
    ["sparse array", { value: sparseArray }],
    ["extended array", { value: extendedArray }],
    ["nested accessor", nestedAccessorDraft],
  ];
  for (const [label, draft] of unsupportedDrafts) {
    assert.equal(
      parseEditorProjectRecoveryJournal({ ...journal, draft }, projectId),
      null,
      `${label} is not a JSON-safe recovery draft`,
    );
  }
  assert.equal(nestedAccessorReads, 0, "nested accessors are rejected without invocation");

  const recorded = recordingStorage();
  assert.equal(writeEditorProjectRecoveryJournal(recorded.storage, journal), true);
  assert.deepEqual(readEditorProjectRecoveryJournal(recorded.storage, projectId), journal);
  clearEditorProjectRecoveryJournal(recorded.storage, projectId);
  assert.deepEqual(recorded.calls, [
    ["set", "editor-v2-recovery:project-a"],
    ["get", "editor-v2-recovery:project-a"],
    ["remove", "editor-v2-recovery:project-a"],
  ]);
  assert.equal(recorded.values.size, 0, "clear removes the only project-scoped journal key");

  const writeIsolation = recordingStorage();
  const writeInput = {
    ...journal,
    draft: { nested: { script: "before-write-mutation" } },
  };
  assert.equal(writeEditorProjectRecoveryJournal(writeIsolation.storage, writeInput), true);
  writeInput.draft.nested.script = "after-write-mutation";
  assert.deepEqual(readEditorProjectRecoveryJournal(writeIsolation.storage, projectId)?.draft, {
    nested: { script: "before-write-mutation" },
  });

  const corruptStorage = recordingStorage();
  corruptStorage.values.set(editorProjectRecoveryKey(projectId), "{broken-json");
  assert.equal(readEditorProjectRecoveryJournal(corruptStorage.storage, projectId), null);
  corruptStorage.values.set(
    editorProjectRecoveryKey(projectId),
    JSON.stringify({ ...journal, projectId: "project-b" }),
  );
  assert.equal(
    readEditorProjectRecoveryJournal(corruptStorage.storage, projectId),
    null,
    "a journal stored under another project's key is not trusted",
  );

  const throwingStorage: RecoveryStorage = {
    getItem() { throw new Error("private mode read"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("private mode clear"); },
  };
  assert.equal(readEditorProjectRecoveryJournal(throwingStorage, projectId), null);
  assert.equal(writeEditorProjectRecoveryJournal(throwingStorage, journal), false);
  assert.doesNotThrow(() => clearEditorProjectRecoveryJournal(throwingStorage, projectId));
  assert.equal(readEditorProjectRecoveryJournal(null, projectId), null);
  assert.equal(writeEditorProjectRecoveryJournal(null, journal), false);
  assert.doesNotThrow(() => clearEditorProjectRecoveryJournal(null, projectId));

  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 4,
      revisionWatermark: 4,
      journal,
    }),
    { kind: "resume-local", journal },
  );

  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 5,
      revisionWatermark: 5,
      journal,
    }),
    {
      kind: "conflict",
      local: { draft: localDraft, editedAt: journal.editedAt, trusted: true },
    },
  );

  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 3,
      revisionWatermark: 4,
      journal: null,
    }),
    { kind: "locked-error", code: "missing_recovery" },
  );
  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 3,
      revisionWatermark: 4,
      journal,
    }),
    { kind: "locked-error", code: "server_behind" },
  );
  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: journal.baseRevision,
      revisionWatermark: journal.baseRevision + 1,
      journal,
    }),
    { kind: "locked-error", code: "server_behind" },
    "watermark lock takes precedence over an equal journal base revision",
  );

  const decisionJournal = {
    ...journal,
    draft: { nested: { script: "decision-input" } },
  };
  const resumeDecision = decideEditorProjectBootstrap({
    projectId,
    serverRevision: 4,
    revisionWatermark: 4,
    journal: decisionJournal,
  });
  decisionJournal.draft.nested.script = "mutated-after-decision";
  assert.equal(resumeDecision.kind, "resume-local");
  assert.deepEqual(resumeDecision.journal.draft, { nested: { script: "decision-input" } });

  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 5,
      revisionWatermark: 5,
      journal: null,
      legacyLocalDraft: { script: "legacy-local-edit" },
    }),
    {
      kind: "conflict",
      local: { draft: { script: "legacy-local-edit" }, editedAt: null, trusted: false },
    },
    "a usable legacy candidate is surfaced as a conflict, never selected",
  );

  for (const invalidLegacyDraft of [null, {}, [], "corrupt", 7]) {
    assert.deepEqual(
      decideEditorProjectBootstrap({
        projectId,
        serverRevision: 5,
        revisionWatermark: 5,
        journal: null,
        legacyLocalDraft: invalidLegacyDraft,
      }),
      { kind: "server" },
      "an invalid legacy value cannot fabricate a recovery candidate",
    );
  }

  const mismatchedJournal = { ...journal, projectId: "project-b" };
  assert.throws(
    () => decideEditorProjectBootstrap({
      projectId,
      serverRevision: 5,
      revisionWatermark: 5,
      journal: mismatchedJournal,
    }),
    /journal/,
    "a supplied invalid journal fails closed instead of selecting server data",
  );

  const invalidDecisionRevisions = [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maxDraftRevision + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const invalidRevision of invalidDecisionRevisions) {
    assert.throws(
      () => decideEditorProjectBootstrap({
        projectId,
        serverRevision: invalidRevision,
        revisionWatermark: 4,
        journal: null,
      }),
      /serverRevision/,
      `invalid server revision ${String(invalidRevision)} fails closed`,
    );
    assert.throws(
      () => decideEditorProjectBootstrap({
        projectId,
        serverRevision: 4,
        revisionWatermark: invalidRevision,
        journal: null,
      }),
      /revisionWatermark/,
      `invalid revision watermark ${String(invalidRevision)} fails closed`,
    );
  }
  assert.throws(
    () => decideEditorProjectBootstrap({
      projectId,
      serverRevision: 4,
      revisionWatermark: 4,
      journal: { ...journal, baseRevision: maxDraftRevision + 1 },
    }),
    /journal/,
    "an invalid supplied base revision fails closed",
  );

  const legacyInput = { nested: { script: "legacy-decision-input" } };
  const legacyDecision = decideEditorProjectBootstrap({
    projectId,
    serverRevision: 5,
    revisionWatermark: 5,
    journal: null,
    legacyLocalDraft: legacyInput,
  });
  legacyInput.nested.script = "mutated-after-decision";
  assert.equal(legacyDecision.kind, "conflict");
  assert.deepEqual(legacyDecision.local.draft, {
    nested: { script: "legacy-decision-input" },
  });

  for (const invalidLegacyDraft of unsupportedDrafts.map(([, draft]) => draft)) {
    assert.deepEqual(
      decideEditorProjectBootstrap({
        projectId,
        serverRevision: 5,
        revisionWatermark: 5,
        journal: null,
        legacyLocalDraft: invalidLegacyDraft,
      }),
      { kind: "server" },
      "an unsupported legacy graph cannot become a conflict candidate",
    );
  }

  const decisionWithIrrelevantInputs = decideEditorProjectBootstrap({
    projectId,
    serverRevision: 5,
    revisionWatermark: 5,
    journal: null,
    retry: true,
    localDirty: true,
    defaultDraft: { script: "programmatic-default" },
  } as Parameters<typeof decideEditorProjectBootstrap>[0]);
  assert.deepEqual(
    decisionWithIrrelevantInputs,
    { kind: "server" },
    "retry, dirty, and programmatic defaults cannot influence the pure decision",
  );

  const bootstrapSource = readFileSync("src/lib/editor-project-bootstrap.ts", "utf8");
  const pureDecisionStart = bootstrapSource.indexOf("export function decideEditorProjectBootstrap");
  const pureDecisionBody = bootstrapSource.indexOf("): EditorProjectBootstrapDecision", pureDecisionStart);
  assert.ok(pureDecisionStart >= 0 && pureDecisionBody > pureDecisionStart);
  const pureDecisionSignature = bootstrapSource.slice(pureDecisionStart, pureDecisionBody);
  assert.doesNotMatch(
    pureDecisionSignature,
    /dirty|retry|default/i,
    "the pure decision type cannot acquire generic dirty, retry, or default inputs",
  );

  console.log("editor-project-recovery: all checks passed");
}

main();
