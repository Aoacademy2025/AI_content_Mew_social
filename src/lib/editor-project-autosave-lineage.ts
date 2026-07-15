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

function readStrictEnvelope(
  value: unknown,
  requiredKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const envelope = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      envelope[key] = descriptor.value;
    }
    return requiredKeys.every((key) => Object.hasOwn(envelope, key)) ? envelope : null;
  } catch {
    return null;
  }
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
  const envelope = readStrictEnvelope(input, ["projectId", "revision", "draft"]);
  if (!envelope) return null;
  return createCandidate(envelope.projectId, envelope.revision, envelope.draft);
}

export function createEditorProjectAutosaveSnapshot(input: {
  projectId: string;
  expectedDraftRevision: number;
  revision: number;
  draft: unknown;
}): EditorProjectAutosaveSnapshot | null {
  const envelope = readStrictEnvelope(input, [
    "projectId",
    "expectedDraftRevision",
    "revision",
    "draft",
  ]);
  if (!envelope) return null;
  if (
    !isDraftRevision(envelope.expectedDraftRevision)
    || !isDraftRevision(envelope.revision)
    || envelope.revision <= envelope.expectedDraftRevision
  ) return null;

  const candidate = createCandidate(envelope.projectId, envelope.revision, envelope.draft);
  if (!candidate) return null;
  return Object.freeze({
    ...candidate,
    expectedDraftRevision: envelope.expectedDraftRevision,
  });
}

function normalizeCandidateEnvelope(
  envelope: Record<string, unknown>,
  label: string,
): EditorProjectAutosaveCandidate {
  const candidate = createCandidate(envelope.projectId, envelope.revision, envelope.draft);
  if (!candidate || candidate.projectId !== envelope.projectId) {
    if (!isDraftRevision(envelope.revision)) {
      throw new Error(`${label} has an invalid revision`);
    }
    throw new Error(`${label} has an invalid project id or draft`);
  }
  if (candidate.fingerprint !== envelope.fingerprint) {
    throw new Error(`${label} has an invalid draft fingerprint`);
  }
  return candidate;
}

function normalizeCandidate(
  value: EditorProjectAutosaveCandidate,
  label: string,
): EditorProjectAutosaveCandidate {
  const envelope = readStrictEnvelope(value, ["projectId", "revision", "draft", "fingerprint"]);
  if (!envelope) throw new Error(`${label} must be an autosave candidate`);
  return normalizeCandidateEnvelope(envelope, label);
}

function normalizeSnapshot(
  value: EditorProjectAutosaveSnapshot,
  label: string,
): EditorProjectAutosaveSnapshot {
  const envelope = readStrictEnvelope(value, [
    "projectId",
    "expectedDraftRevision",
    "revision",
    "draft",
    "fingerprint",
  ]);
  if (!envelope) throw new Error(`${label} must be an autosave snapshot`);
  const candidate = normalizeCandidateEnvelope(envelope, label);
  if (
    !isDraftRevision(envelope.expectedDraftRevision)
    || candidate.revision <= envelope.expectedDraftRevision
  ) {
    throw new Error(`${label} has an invalid expected revision`);
  }
  return Object.freeze({
    ...candidate,
    expectedDraftRevision: envelope.expectedDraftRevision,
  });
}

function assertSameProject(
  candidate: EditorProjectAutosaveCandidate,
  projectId: string,
): void {
  if (candidate.projectId !== projectId) {
    throw new Error("autosave observation project mismatch");
  }
}

function assertIssuedRevision(issuedRevision: unknown, candidateRevision: number): void {
  if (!isDraftRevision(issuedRevision) || issuedRevision !== candidateRevision) {
    throw new Error("issued map key disagrees with candidate revision");
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
  const envelope = readStrictEnvelope(input, ["attempt", "confirmed", "issued", "observed"]);
  if (!envelope) throw new Error("autosave observation input is required");
  const attempt = normalizeSnapshot(
    envelope.attempt as EditorProjectAutosaveSnapshot,
    "attempt",
  );
  const confirmed = normalizeCandidate(
    envelope.confirmed as EditorProjectAutosaveCandidate,
    "confirmed",
  );
  const observed = normalizeCandidate(
    envelope.observed as EditorProjectAutosaveCandidate,
    "observed",
  );
  const issued = envelope.issued as ReadonlyMap<number, EditorProjectAutosaveCandidate>;

  const projectId = attempt.projectId;
  assertSameProject(confirmed, projectId);
  assertSameProject(observed, projectId);

  const issuedSnapshot = new Map<number, EditorProjectAutosaveCandidate>();
  for (const [issuedRevision, issuedCandidateValue] of issued) {
    if (issuedSnapshot.has(issuedRevision)) {
      throw new Error("duplicate issued revision");
    }
    const issuedCandidate = normalizeCandidate(issuedCandidateValue, "issued candidate");
    assertIssuedRevision(issuedRevision, issuedCandidate.revision);
    assertSameProject(issuedCandidate, projectId);
    issuedSnapshot.set(issuedRevision, issuedCandidate);
  }

  if (sameCandidate(observed, attempt)) {
    return { kind: "saved", confirmed: observed };
  }
  if (sameCandidate(observed, confirmed)) {
    return { kind: "retry", confirmed };
  }
  const knownIssued = issuedSnapshot.get(observed.revision);
  if (knownIssued && sameCandidate(observed, knownIssued)) {
    return { kind: "retry", confirmed: knownIssued };
  }
  return { kind: "conflict", server: observed };
}
