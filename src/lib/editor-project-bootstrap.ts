import {
  parseEditorProjectRecoveryJournal,
  type EditorProjectDraft,
  type EditorProjectRecoveryJournalV1,
} from "./editor-project-recovery-journal";

const MAX_DRAFT_REVISION = 2_147_483_647;
const LEGACY_DRAFT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export type EditorProjectBootstrapDecision =
  | { kind: "server" }
  | { kind: "resume-local"; journal: EditorProjectRecoveryJournalV1 }
  | {
      kind: "conflict";
      local: { draft: EditorProjectDraft; editedAt: string | null; trusted: boolean };
    }
  | { kind: "locked-error"; code: "server_behind" | "missing_recovery" };

function assertDraftRevision(value: number, field: "serverRevision" | "revisionWatermark"): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DRAFT_REVISION) {
    throw new RangeError(`${field} must be a non-negative draft revision`);
  }
}

function materializeLegacyDraft(value: unknown, projectId: string): EditorProjectDraft | null {
  const journal = parseEditorProjectRecoveryJournal({
    version: 1,
    projectId,
    baseRevision: 0,
    editedAt: LEGACY_DRAFT_TIMESTAMP,
    draft: value,
  }, projectId);
  return journal && Object.keys(journal.draft).length > 0 ? journal.draft : null;
}

export function decideEditorProjectBootstrap(input: {
  projectId: string;
  serverRevision: number;
  revisionWatermark: number;
  journal: EditorProjectRecoveryJournalV1 | null;
  legacyLocalDraft?: unknown;
}): EditorProjectBootstrapDecision {
  assertDraftRevision(input.serverRevision, "serverRevision");
  assertDraftRevision(input.revisionWatermark, "revisionWatermark");
  const journal = parseEditorProjectRecoveryJournal(input.journal, input.projectId);
  if (input.journal !== null && !journal) {
    throw new TypeError("journal must be a trusted project recovery journal");
  }
  if (input.serverRevision < input.revisionWatermark) {
    return { kind: "locked-error", code: journal ? "server_behind" : "missing_recovery" };
  }
  if (journal && input.serverRevision === journal.baseRevision) {
    return { kind: "resume-local", journal };
  }
  if (journal && input.serverRevision > journal.baseRevision) {
    return {
      kind: "conflict",
      local: { draft: journal.draft, editedAt: journal.editedAt, trusted: true },
    };
  }
  const legacyDraft = materializeLegacyDraft(input.legacyLocalDraft, input.projectId);
  if (legacyDraft) {
    return {
      kind: "conflict",
      local: { draft: legacyDraft, editedAt: null, trusted: false },
    };
  }
  return { kind: "server" };
}

type GenericDecisionStateKey<Key> = Key extends string
  ? Lowercase<Key> extends `${string}${"dirty" | "retry" | "default"}${string}` ? Key : never
  : never;
type AssertNoGenericDecisionState<Key extends never> = Key;
type EditorProjectBootstrapInputHasNoGenericState = AssertNoGenericDecisionState<
  GenericDecisionStateKey<keyof Parameters<typeof decideEditorProjectBootstrap>[0]>
>;

export type EditorProjectBootstrapProject = {
  id: string;
  draftRevision: number;
  draft?: unknown;
  [key: string]: unknown;
};

export type EditorProjectBootstrapOutcome =
  | { kind: "server"; project: EditorProjectBootstrapProject }
  | {
      kind: "local";
      project: EditorProjectBootstrapProject;
      draft: Record<string, unknown>;
    }
  | { kind: "error"; recoveryDraft: Record<string, unknown> | null }
  | { kind: "missing" };

export function isEditorProjectRecoveryDraft(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

export async function resolveEditorProjectBootstrap(input: {
  projectId: string;
  localDraft?: unknown;
  localDirty?: boolean;
  readLocalDraft?: () => unknown;
  isLocalDirty?: () => boolean;
  revisionWatermark: number;
  loadProject: () => Promise<{ status: number; project?: unknown }>;
}): Promise<EditorProjectBootstrapOutcome> {
  const readRecoveryDraft = () => {
    const value = input.readLocalDraft ? input.readLocalDraft() : input.localDraft;
    return isEditorProjectRecoveryDraft(value) ? value : null;
  };
  let response: { status: number; project?: unknown };
  try {
    response = await input.loadProject();
  } catch {
    return { kind: "error", recoveryDraft: readRecoveryDraft() };
  }
  const recoveryDraft = readRecoveryDraft();
  if (response.status === 404) return { kind: "missing" };
  if (response.status < 200 || response.status >= 300) {
    return { kind: "error", recoveryDraft };
  }

  const value = response.project;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", recoveryDraft };
  }
  const project = value as EditorProjectBootstrapProject;
  if (
    project.id !== input.projectId
    || !Number.isInteger(project.draftRevision)
    || project.draftRevision < 0
  ) {
    return { kind: "error", recoveryDraft };
  }

  const localDirty = input.isLocalDirty ? input.isLocalDirty() : input.localDirty === true;
  if (project.draftRevision < input.revisionWatermark || localDirty) {
    return recoveryDraft
      ? { kind: "local", project, draft: recoveryDraft }
      : { kind: "error", recoveryDraft: null };
  }
  return { kind: "server", project };
}
