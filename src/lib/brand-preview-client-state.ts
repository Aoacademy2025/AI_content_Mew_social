export type PendingBrandPreviewOperation =
  | {
      version: 2;
      kind: "preview";
      userId: string;
      requestId: string;
      surface: PendingBrandPreviewSurface;
      createdAt: string;
      autoResumeAttemptedAt?: string;
    }
  | {
      version: 1;
      kind: "reroll";
      userId: string;
      requestId: string;
      batchId: string;
      itemId: string;
      createdAt: string;
      autoResumeAttemptedAt?: string;
    };

export type PendingBrandPreviewSurface = {
  profileId: string | null;
  payloadJson: string;
  projectId: string | null;
  preflightId: string | null;
  videoJobId: string | null;
};

type PreviewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY_PREFIX = "brand-look-preview-operation";
const MAX_AGE_MS = 24 * 60 * 60_000;
const REQUEST_ID = /^[a-z0-9_-]{8,100}$/iu;

function validNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Boolean(value.trim()));
}

function validPreviewSurface(value: unknown): value is PendingBrandPreviewSurface {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const surface = value as Partial<PendingBrandPreviewSurface>;
  if (
    !validNullableId(surface.profileId)
    || !validNullableId(surface.projectId)
    || !validNullableId(surface.preflightId)
    || !validNullableId(surface.videoJobId)
    || typeof surface.payloadJson !== "string"
    || surface.payloadJson.length < 2
    || surface.payloadJson.length > 50_000
  ) return false;
  try {
    const payload = JSON.parse(surface.payloadJson) as unknown;
    return Boolean(payload && typeof payload === "object" && !Array.isArray(payload));
  } catch {
    return false;
  }
}

/** Exact UI surface identity for replay. The raw payload remains local-only;
 * the compact key is used solely to prevent one draft from adopting another
 * draft's request id. */
export function brandPreviewSurfaceKey(surface: PendingBrandPreviewSurface): string {
  const value = JSON.stringify(surface);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `preview-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function key(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export function readPendingBrandPreviewOperation(
  storage: PreviewStorage,
  userId: string,
  now = new Date(),
): PendingBrandPreviewOperation | null {
  try {
    const raw = storage.getItem(key(userId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingBrandPreviewOperation>;
    const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
    const common = value.userId === userId
      && typeof value.requestId === "string"
      && REQUEST_ID.test(value.requestId)
      && Number.isFinite(createdAt)
      && createdAt <= now.getTime() + 60_000
      && now.getTime() - createdAt <= MAX_AGE_MS;
    const autoResumeAttemptedAt = typeof value.autoResumeAttemptedAt === "string"
      ? Date.parse(value.autoResumeAttemptedAt)
      : null;
    const validAutoResumeMarker = value.autoResumeAttemptedAt === undefined || (
      autoResumeAttemptedAt !== null
      && Number.isFinite(autoResumeAttemptedAt)
      && autoResumeAttemptedAt >= createdAt
      && autoResumeAttemptedAt <= now.getTime() + 60_000
    );
    const valid = common && validAutoResumeMarker && (
      (value.kind === "preview" && value.version === 2 && validPreviewSurface(value.surface))
      || (
        value.kind === "reroll"
        && value.version === 1
        && typeof value.batchId === "string"
        && Boolean(value.batchId.trim())
        && typeof value.itemId === "string"
        && Boolean(value.itemId.trim())
      )
    );
    if (!valid) {
      storage.removeItem(key(userId));
      return null;
    }
    return value as PendingBrandPreviewOperation;
  } catch {
    return null;
  }
}

/** A reload may resume an ambiguous paid request once using its durable request
 * id. A persisted marker prevents every later mount from starting it again. */
export function pendingBrandPreviewCanAutoResume(
  operation: PendingBrandPreviewOperation,
): boolean {
  return operation.autoResumeAttemptedAt === undefined;
}

export function markPendingBrandPreviewAutoResumeAttempt(
  operation: PendingBrandPreviewOperation,
  attemptedAt = new Date(),
): PendingBrandPreviewOperation {
  return { ...operation, autoResumeAttemptedAt: attemptedAt.toISOString() };
}

export function writePendingBrandPreviewOperation(
  storage: PreviewStorage,
  operation: PendingBrandPreviewOperation,
): void {
  storage.setItem(key(operation.userId), JSON.stringify(operation));
}

export function clearPendingBrandPreviewOperation(
  storage: PreviewStorage,
  userId: string,
  requestId: string,
): void {
  const current = readPendingBrandPreviewOperation(storage, userId);
  if (current?.requestId === requestId) storage.removeItem(key(userId));
}
