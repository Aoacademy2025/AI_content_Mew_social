const JOURNAL_PREFIX = "editor-v2-recovery:";

export type EditorProjectDraft = Record<string, unknown>;

export type EditorProjectRecoveryJournalV1 = {
  version: 1;
  projectId: string;
  baseRevision: number;
  editedAt: string;
  draft: EditorProjectDraft;
};

export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function editorProjectRecoveryKey(projectId: string): string {
  const id = projectId.trim();
  if (!id) throw new Error("projectId is required");
  return `${JOURNAL_PREFIX}${id}`;
}

export function parseEditorProjectRecoveryJournal(
  value: unknown,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<EditorProjectRecoveryJournalV1>;
  if (candidate.version !== 1 || candidate.projectId !== projectId) return null;
  if (!Number.isInteger(candidate.baseRevision) || candidate.baseRevision! < 0) return null;
  if (
    typeof candidate.editedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.editedAt))
  ) return null;
  if (!candidate.draft || typeof candidate.draft !== "object" || Array.isArray(candidate.draft)) {
    return null;
  }
  return candidate as EditorProjectRecoveryJournalV1;
}

export function readEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(editorProjectRecoveryKey(projectId));
    if (value === null) return null;
    return parseEditorProjectRecoveryJournal(JSON.parse(value), projectId);
  } catch {
    return null;
  }
}

export function writeEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  journal: EditorProjectRecoveryJournalV1,
): boolean {
  if (!storage) return false;
  try {
    const parsed = parseEditorProjectRecoveryJournal(journal, journal.projectId);
    if (!parsed) return false;
    storage.setItem(editorProjectRecoveryKey(journal.projectId), JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function clearEditorProjectRecoveryJournal(
  storage: RecoveryStorage | null,
  projectId: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(editorProjectRecoveryKey(projectId));
  } catch {
    // Clearing recovery is best-effort in unavailable or restricted storage.
  }
}
