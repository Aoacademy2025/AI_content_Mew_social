const JOURNAL_PREFIX = "editor-v2-recovery:";
const MAX_DRAFT_REVISION = 2_147_483_647;
const INVALID_JSON_VALUE = Symbol("invalid-editor-project-json-value");

export type EditorProjectDraft = Record<string, unknown>;

export type EditorProjectRecoveryJournalV1 = {
  version: 1;
  projectId: string;
  baseRevision: number;
  editedAt: string;
  draft: EditorProjectDraft;
};

export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownEnumerableDataValue(value: object, key: string): unknown | typeof INVALID_JSON_VALUE {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return INVALID_JSON_VALUE;
  }
  return descriptor.value;
}

function materializeJsonValue(
  value: unknown,
  activeObjects: Set<object>,
): unknown | typeof INVALID_JSON_VALUE {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  if (typeof value !== "object") return INVALID_JSON_VALUE;

  if (activeObjects.has(value)) return INVALID_JSON_VALUE;
  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID_JSON_VALUE;
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1
        || keys.some((key) => typeof key === "symbol")
      ) return INVALID_JSON_VALUE;

      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = ownEnumerableDataValue(value, String(index));
        if (item === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        const clonedItem = materializeJsonValue(item, activeObjects);
        if (clonedItem === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        clone.push(clonedItem);
      }
      return clone;
    }

    if (!isPlainObject(value)) return INVALID_JSON_VALUE;
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return INVALID_JSON_VALUE;
      const item = ownEnumerableDataValue(value, key);
      if (item === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      const clonedItem = materializeJsonValue(item, activeObjects);
      if (clonedItem === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: clonedItem,
        writable: true,
      });
    }
    return clone;
  } finally {
    activeObjects.delete(value);
  }
}

export function materializeEditorProjectDraft(value: unknown): EditorProjectDraft | null {
  try {
    if (!isPlainObject(value)) return null;
    const materialized = materializeJsonValue(value, new Set());
    return materialized === INVALID_JSON_VALUE ? null : materialized as EditorProjectDraft;
  } catch {
    return null;
  }
}

function isDraftRevision(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DRAFT_REVISION;
}

function isCanonicalEditedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(value).toISOString() === value;
}

export function editorProjectRecoveryKey(projectId: string): string {
  const id = projectId.trim();
  if (!id) throw new Error("projectId is required");
  return `${JOURNAL_PREFIX}${id}`;
}

export function parseEditorProjectRecoveryJournal(
  value: unknown,
  projectId: string,
): EditorProjectRecoveryJournalV1 | null {
  try {
    if (!isPlainObject(value)) return null;
    const version = ownEnumerableDataValue(value, "version");
    const candidateProjectId = ownEnumerableDataValue(value, "projectId");
    const baseRevision = ownEnumerableDataValue(value, "baseRevision");
    const editedAt = ownEnumerableDataValue(value, "editedAt");
    const draftValue = ownEnumerableDataValue(value, "draft");
    if (version !== 1 || candidateProjectId !== projectId) return null;
    if (!isDraftRevision(baseRevision) || !isCanonicalEditedAt(editedAt)) return null;
    if (draftValue === INVALID_JSON_VALUE) return null;
    const draft = materializeEditorProjectDraft(draftValue);
    if (!draft) return null;
    return {
      version: 1,
      projectId: candidateProjectId,
      baseRevision,
      editedAt,
      draft,
    };
  } catch {
    return null;
  }
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
    if (!journal || typeof journal !== "object") return false;
    const projectId = ownEnumerableDataValue(journal, "projectId");
    if (typeof projectId !== "string") return false;
    const parsed = parseEditorProjectRecoveryJournal(journal, projectId);
    if (!parsed) return false;
    storage.setItem(editorProjectRecoveryKey(parsed.projectId), JSON.stringify(parsed));
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
