export type MobileSheetSize = "medium" | "large";

export type SheetDragMotion = {
  distanceY: number;
  velocityY: number;
};

export type SheetDragSample = {
  y: number;
  atMs: number;
};

export type SheetDragSession = {
  startY: number;
  lastY: number;
  lastAtMs: number;
  velocityY: number;
};

export type MobileSheetHistoryAdapter = {
  getState(): unknown;
  getUrl(): string;
  pushState(state: Record<string, unknown>, url: string): void;
  back(): void;
  schedule(task: () => void): void;
  onNextPopState?(task: () => void): void;
};

export type MobileSheetCloseAction = "history" | "direct" | "ignored";

export type MobileSheetCoordinator = {
  register(ownerId: string): void;
  unregister(ownerId: string): void;
  isActive(ownerId: string): boolean;
  requestClose(ownerId: string): MobileSheetCloseAction;
  handlePopState(): string | null;
};

export const MOBILE_SHEET_HISTORY_KEY = "__heroAiMobileSheet";
const RELEASE_VELOCITY_FRESH_MS = 80;

export function createSheetDragSession({ y, atMs }: SheetDragSample): SheetDragSession {
  return {
    startY: y,
    lastY: y,
    lastAtMs: atMs,
    velocityY: 0,
  };
}

export function moveSheetDragSession(
  session: SheetDragSession,
  { y, atMs }: SheetDragSample,
): SheetDragSession {
  const elapsed = atMs - session.lastAtMs;
  return {
    ...session,
    lastY: y,
    lastAtMs: atMs,
    velocityY: elapsed > 0 ? (y - session.lastY) / elapsed : session.velocityY,
  };
}

export function releaseSheetDragSession(
  session: SheetDragSession,
  { y, atMs }: SheetDragSample,
): SheetDragMotion {
  const elapsed = atMs - session.lastAtMs;
  const releaseDelta = y - session.lastY;
  let velocityY = 0;
  if (elapsed > 0 && releaseDelta !== 0) {
    velocityY = releaseDelta / elapsed;
  } else if (elapsed >= 0 && elapsed <= RELEASE_VELOCITY_FRESH_MS) {
    velocityY = session.velocityY;
  }
  return { distanceY: y - session.startY, velocityY };
}

export function createMobileSheetCoordinator(
  adapter: MobileSheetHistoryAdapter,
  token: string,
): MobileSheetCoordinator {
  const owners: string[] = [];
  let historyPopPending = false;

  function currentEntryIsSheet() {
    const state = adapter.getState();
    return !!state
      && typeof state === "object"
      && (state as Record<string, unknown>)[MOBILE_SHEET_HISTORY_KEY] === token;
  }

  function ensureHistoryEntry() {
    if (currentEntryIsSheet()) return;
    const state = adapter.getState();
    const preservedState = state && typeof state === "object"
      ? state as Record<string, unknown>
      : {};
    adapter.pushState(
      { ...preservedState, [MOBILE_SHEET_HISTORY_KEY]: token },
      adapter.getUrl(),
    );
  }

  function consumeHistoryEntry() {
    if (!currentEntryIsSheet() || historyPopPending) return false;
    historyPopPending = true;
    adapter.onNextPopState?.(() => { historyPopPending = false; });
    adapter.back();
    return true;
  }

  function activeOwner() {
    return owners.at(-1) ?? null;
  }

  return {
    register(ownerId) {
      const previousIndex = owners.indexOf(ownerId);
      if (previousIndex >= 0) owners.splice(previousIndex, 1);
      owners.push(ownerId);
      ensureHistoryEntry();
    },
    unregister(ownerId) {
      const index = owners.indexOf(ownerId);
      if (index >= 0) owners.splice(index, 1);
      adapter.schedule(() => {
        if (owners.length === 0) consumeHistoryEntry();
        else ensureHistoryEntry();
      });
    },
    isActive(ownerId) {
      return activeOwner() === ownerId;
    },
    requestClose(ownerId) {
      if (activeOwner() !== ownerId) return "ignored";
      return consumeHistoryEntry() ? "history" : "direct";
    },
    handlePopState() {
      historyPopPending = false;
      return activeOwner();
    },
  };
}

export function shouldDismissSheetDrag({
  distanceY,
  velocityY,
}: SheetDragMotion): boolean {
  if (!Number.isFinite(distanceY) || !Number.isFinite(velocityY)) return false;
  if (distanceY < 0) return false;
  return distanceY >= 96 || velocityY >= 0.65;
}

export function clampSheetDragTranslation(distanceY: number): number {
  return Number.isFinite(distanceY) ? Math.max(0, distanceY) : 0;
}
