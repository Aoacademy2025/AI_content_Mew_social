export type PendingBrollSceneReroll = {
  version: 1;
  videoJobId: string;
  sceneIndex: number;
  requestId: string;
  createdAt: string;
};

type RerollStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "brand-visual-scene-reroll";
const MAX_AGE_MS = 24 * 60 * 60_000;
const JOB_ID = /^[A-Za-z0-9_-]{8,120}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(videoJobId: string, sceneIndex: number): string {
  return `${KEY_PREFIX}:${videoJobId}:${sceneIndex}`;
}

export function readPendingBrollSceneReroll(
  storage: RerollStorage,
  videoJobId: string,
  sceneIndex: number,
  now = new Date(),
): PendingBrollSceneReroll | null {
  const key = storageKey(videoJobId, sceneIndex);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingBrollSceneReroll>;
    const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
    const valid = value.version === 1
      && value.videoJobId === videoJobId
      && JOB_ID.test(videoJobId)
      && value.sceneIndex === sceneIndex
      && Number.isInteger(sceneIndex)
      && sceneIndex >= 0
      && typeof value.requestId === "string"
      && REQUEST_ID.test(value.requestId)
      && Number.isFinite(createdAt)
      && createdAt <= now.getTime() + 60_000
      && now.getTime() - createdAt <= MAX_AGE_MS;
    if (!valid) {
      storage.removeItem(key);
      return null;
    }
    return value as PendingBrollSceneReroll;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writePendingBrollSceneReroll(
  storage: RerollStorage,
  operation: PendingBrollSceneReroll,
): void {
  storage.setItem(
    storageKey(operation.videoJobId, operation.sceneIndex),
    JSON.stringify(operation),
  );
}

export function clearPendingBrollSceneReroll(
  storage: RerollStorage,
  videoJobId: string,
  sceneIndex: number,
  requestId: string,
): void {
  const current = readPendingBrollSceneReroll(storage, videoJobId, sceneIndex);
  if (current?.requestId === requestId) {
    storage.removeItem(storageKey(videoJobId, sceneIndex));
  }
}
