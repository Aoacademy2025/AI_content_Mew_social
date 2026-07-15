// Run with: npx tsx scripts/verify-editor-project-recovery.ts
import assert from "node:assert/strict";
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
  assert.deepEqual(parseEditorProjectRecoveryJournal(journal, projectId), journal);

  const invalidJournals: Array<[string, unknown, string]> = [
    ["null", null, projectId],
    ["array", [], projectId],
    ["mismatched project", journal, "project-b"],
    ["unsupported version", { ...journal, version: 2 }, projectId],
    ["negative revision", { ...journal, baseRevision: -1 }, projectId],
    ["fractional revision", { ...journal, baseRevision: 1.5 }, projectId],
    ["invalid date", { ...journal, editedAt: "not-a-date" }, projectId],
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
  assert.deepEqual(
    decideEditorProjectBootstrap({
      projectId,
      serverRevision: 5,
      revisionWatermark: 5,
      journal: mismatchedJournal,
    }),
    { kind: "server" },
    "the pure boundary revalidates project scope before trusting a journal",
  );

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

  console.log("editor-project-recovery: all checks passed");
}

main();
