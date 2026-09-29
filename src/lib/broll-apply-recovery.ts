/** Browser journal for one unresolved, account-scoped B-roll VideoJob operation. */
export type PendingBrollApply = {
  version: 1;
  accountId: string;
  projectId: string;
  sourceJobId: string;
  idempotencyKey: string;
  jobId: string | null;
  draftEdits: [number, Record<string, string | number | boolean>][];
  windowEdits: Record<string, string | number | boolean>[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PendingBrollRead =
  | { kind: "empty" | "corrupt" | "unavailable" }
  | { kind: "found"; operation: PendingBrollApply };

const PREFIX = "editor-v2-broll-apply:";
export function brollApplyKey(accountId: string, projectId: string): string {
  return `${PREFIX}${accountId}:${projectId}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEdits(value: unknown): value is Record<string, string | number | boolean>[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000
    && value.every((entry) => record(entry)
      && Number.isSafeInteger(entry.index) && (entry.index as number) >= 0
      && Object.values(entry).every((field) => field === undefined || typeof field === "string"
        || typeof field === "boolean" || (typeof field === "number" && Number.isFinite(field))));
}

function parse(value: unknown, accountId: string, projectId: string): PendingBrollApply | null {
  if (!record(value) || value.version !== 1 || value.accountId !== accountId
    || value.projectId !== projectId || typeof value.sourceJobId !== "string"
    || !value.sourceJobId || typeof value.idempotencyKey !== "string"
    || !/^editor-v2-broll-rerender-[a-f0-9-]{36}$/.test(value.idempotencyKey)
    || !(value.jobId === null || (typeof value.jobId === "string" && value.jobId.length > 0))
    || !validEdits(value.windowEdits) || !Array.isArray(value.draftEdits)
    || !validEdits(value.draftEdits.map((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2 || !record(entry[1])) return null;
      return { index: entry[0], ...entry[1] };
    }))) return null;
  return value as PendingBrollApply;
}

export function readPendingBrollApply(
  storage: StorageLike | null, accountId: string, projectId: string,
): PendingBrollRead {
  if (!storage) return { kind: "unavailable" };
  try {
    const raw = storage.getItem(brollApplyKey(accountId, projectId));
    if (raw === null) return { kind: "empty" };
    const operation = parse(JSON.parse(raw), accountId, projectId);
    return operation ? { kind: "found", operation } : { kind: "corrupt" };
  } catch { return { kind: "unavailable" }; }
}

export function writePendingBrollApply(storage: StorageLike | null, operation: PendingBrollApply): boolean {
  if (!storage || !parse(operation, operation.accountId, operation.projectId)) return false;
  try {
    storage.setItem(brollApplyKey(operation.accountId, operation.projectId), JSON.stringify(operation));
    return true;
  } catch { return false; }
}

export function clearPendingBrollApply(storage: StorageLike | null, operation: PendingBrollApply): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(brollApplyKey(operation.accountId, operation.projectId));
    return true;
  } catch { return false; }
}
