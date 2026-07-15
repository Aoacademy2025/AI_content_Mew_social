import {
  materializeEditorProjectDraft,
  type EditorProjectDraft,
} from "./editor-project-recovery-journal";

const MAX_DRAFT_REVISION = 2_147_483_647;

export type EditorProjectAutosaveCandidate = {
  projectId: string;
  revision: number;
  draft: EditorProjectDraft;
  fingerprint: string;
};

export type EditorProjectAutosaveSnapshot = EditorProjectAutosaveCandidate & {
  expectedDraftRevision: number;
};

export type EditorProjectAutosaveObservationDecision =
  | { kind: "saved"; confirmed: EditorProjectAutosaveCandidate }
  | { kind: "retry"; confirmed: EditorProjectAutosaveCandidate }
  | { kind: "conflict"; server: EditorProjectAutosaveCandidate };

function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const projectId = value.trim();
  return projectId || null;
}

function isDraftRevision(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DRAFT_REVISION;
}

function serializeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(object[key])}`)
    .join(",")}}`;
}

function freezeJsonGraph(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonGraph(item);
  } else {
    for (const key of Object.keys(value)) {
      freezeJsonGraph((value as Record<string, unknown>)[key]);
    }
  }
  Object.freeze(value);
}

function createCandidate(
  projectIdValue: unknown,
  revisionValue: unknown,
  draftValue: unknown,
): EditorProjectAutosaveCandidate | null {
  const projectId = normalizeProjectId(projectIdValue);
  if (!projectId || !isDraftRevision(revisionValue)) return null;
  const draft = materializeEditorProjectDraft(draftValue);
  if (!draft) return null;

  const fingerprint = serializeCanonicalJson(draft);
  freezeJsonGraph(draft);
  return Object.freeze({
    projectId,
    revision: revisionValue,
    draft,
    fingerprint,
  });
}

export function createEditorProjectAutosaveCandidate(input: {
  projectId: string;
  revision: number;
  draft: unknown;
}): EditorProjectAutosaveCandidate | null {
  if (!input || typeof input !== "object") return null;
  return createCandidate(input.projectId, input.revision, input.draft);
}

export function createEditorProjectAutosaveSnapshot(input: {
  projectId: string;
  expectedDraftRevision: number;
  revision: number;
  draft: unknown;
}): EditorProjectAutosaveSnapshot | null {
  if (!input || typeof input !== "object") return null;
  if (
    !isDraftRevision(input.expectedDraftRevision)
    || !isDraftRevision(input.revision)
    || input.revision <= input.expectedDraftRevision
  ) return null;

  const candidate = createCandidate(input.projectId, input.revision, input.draft);
  if (!candidate) return null;
  return Object.freeze({
    ...candidate,
    expectedDraftRevision: input.expectedDraftRevision,
  });
}

function assertCandidate(
  value: EditorProjectAutosaveCandidate,
  label: string,
): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an autosave candidate`);
  }
  const projectId = normalizeProjectId(value.projectId);
  if (!projectId || projectId !== value.projectId) {
    throw new Error(`${label} has an invalid project id`);
  }
  if (!isDraftRevision(value.revision)) {
    throw new Error(`${label} has an invalid revision`);
  }
  const draft = materializeEditorProjectDraft(value.draft);
  if (!draft || serializeCanonicalJson(draft) !== value.fingerprint) {
    throw new Error(`${label} has an invalid draft fingerprint`);
  }
}

function sameCandidate(
  left: EditorProjectAutosaveCandidate,
  right: EditorProjectAutosaveCandidate,
): boolean {
  return left.revision === right.revision && left.fingerprint === right.fingerprint;
}

export function decideEditorProjectAutosaveObservation(input: {
  attempt: EditorProjectAutosaveSnapshot;
  confirmed: EditorProjectAutosaveCandidate;
  issued: ReadonlyMap<number, EditorProjectAutosaveCandidate>;
  observed: EditorProjectAutosaveCandidate;
}): EditorProjectAutosaveObservationDecision {
  if (!input || typeof input !== "object") {
    throw new Error("autosave observation input is required");
  }
  assertCandidate(input.attempt, "attempt");
  assertCandidate(input.confirmed, "confirmed");
  assertCandidate(input.observed, "observed");
  if (
    !isDraftRevision(input.attempt.expectedDraftRevision)
    || input.attempt.revision <= input.attempt.expectedDraftRevision
  ) {
    throw new Error("attempt has an invalid expected revision");
  }

  const projectId = input.attempt.projectId;
  if (input.confirmed.projectId !== projectId || input.observed.projectId !== projectId) {
    throw new Error("autosave observation project mismatch");
  }

  for (const [issuedRevision, issuedCandidate] of input.issued) {
    assertCandidate(issuedCandidate, "issued candidate");
    if (issuedRevision !== issuedCandidate.revision) {
      throw new Error("issued map key disagrees with candidate revision");
    }
    if (issuedCandidate.projectId !== projectId) {
      throw new Error("autosave observation project mismatch");
    }
  }

  if (sameCandidate(input.observed, input.attempt)) {
    return { kind: "saved", confirmed: input.observed };
  }
  if (sameCandidate(input.observed, input.confirmed)) {
    return { kind: "retry", confirmed: input.confirmed };
  }
  const knownIssued = input.issued.get(input.observed.revision);
  if (knownIssued && sameCandidate(input.observed, knownIssued)) {
    return { kind: "retry", confirmed: knownIssued };
  }
  return { kind: "conflict", server: input.observed };
}
