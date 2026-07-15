const HISTORY_STATE_KEY = "__heroEditorConflict";
const HISTORY_STATE_TOKEN = "hero-editor-conflict-v2";
// Chromium dispatches a queued same-document traversal in a later task. This bounded
// grace lets an already requested user Back win before cleanup owns a traversal.
const CLEANUP_POP_GRACE_MS = 120;

let historyOwnerSequence = 0;

type HistoryOwnerLifecycle = {
  activeOwners: number;
  generation: number;
};

const historyOwnerLifecycles = new Map<string, HistoryOwnerLifecycle>();

function historyOwnerLifecycle(owner: string): HistoryOwnerLifecycle {
  const current = historyOwnerLifecycles.get(owner);
  if (current) return current;
  const created = { activeOwners: 0, generation: 0 };
  historyOwnerLifecycles.set(owner, created);
  return created;
}

type BlockingHistoryMarker = {
  token: typeof HISTORY_STATE_TOKEN;
  owner: string;
  kind: "object" | "value";
  hadPreviousTag?: boolean;
  previousTag?: unknown;
  originalState?: unknown;
};

function blockingHistoryMarker(value: unknown): BlockingHistoryMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>)[HISTORY_STATE_KEY];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const candidate = marker as Partial<BlockingHistoryMarker>;
  if (
    candidate.token !== HISTORY_STATE_TOKEN
    || typeof candidate.owner !== "string"
    || (candidate.kind !== "object" && candidate.kind !== "value")
  ) return null;
  return candidate as BlockingHistoryMarker;
}

export function createBlockingDialogHistory(input: {
  history: Pick<History, "state" | "pushState" | "replaceState" | "back">;
  addPopStateListener: (listener: () => void) => () => void;
}): {
  activate(): () => void;
} {
  let owner = `${HISTORY_STATE_TOKEN}:${++historyOwnerSequence}`;
  let ownerLifecycle = historyOwnerLifecycle(owner);
  let activeOwners = 0;
  let active = false;
  let removePopStateListener: (() => void) | null = null;
  let removeStrandedTagListener: (() => void) | null = null;
  let cleanupPopTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let pendingPop = false;
  let cleanupPopObserved = false;
  let ownedUrl: string | null = null;

  const readState = (): unknown => {
    try {
      return input.history.state;
    } catch {
      return null;
    }
  };

  const isOwnedState = (value: unknown): boolean => blockingHistoryMarker(value)?.owner === owner;

  const readUrl = (): string | null => {
    try {
      return typeof location === "undefined" ? null : location.href;
    } catch {
      return null;
    }
  };

  const isOwnedSameUrlState = (value: unknown): boolean => {
    if (!isOwnedState(value)) return false;
    const currentUrl = readUrl();
    return ownedUrl === null || currentUrl === null || currentUrl === ownedUrl;
  };

  const taggedState = (currentState: unknown): Record<string, unknown> => {
    if (currentState && typeof currentState === "object" && !Array.isArray(currentState)) {
      const currentObject = currentState as Record<string, unknown>;
      const hadPreviousTag = Object.prototype.hasOwnProperty.call(currentObject, HISTORY_STATE_KEY);
      return {
        ...currentObject,
        [HISTORY_STATE_KEY]: {
          token: HISTORY_STATE_TOKEN,
          owner,
          kind: "object",
          hadPreviousTag,
          previousTag: hadPreviousTag ? currentObject[HISTORY_STATE_KEY] : undefined,
        } satisfies BlockingHistoryMarker,
      };
    }
    return {
      [HISTORY_STATE_KEY]: {
        token: HISTORY_STATE_TOKEN,
        owner,
        kind: "value",
        originalState: currentState,
      } satisfies BlockingHistoryMarker,
    };
  };

  const pushBlockingEntry = (): void => {
    const currentState = readState();
    const currentMarker = blockingHistoryMarker(currentState);
    if (currentMarker) {
      owner = currentMarker.owner;
      ownerLifecycle = historyOwnerLifecycle(owner);
      ownedUrl = readUrl();
      return;
    }
    try {
      input.history.pushState(taggedState(currentState), "");
      ownedUrl = readUrl();
    } catch {
      // Some embedded browsers restrict History. The dialog remains controlled/open.
    }
  };

  const restoreOwnedState = (currentState: unknown): unknown => {
    const marker = blockingHistoryMarker(currentState);
    if (!marker || marker.owner !== owner) return currentState;
    if (marker.kind === "value") return marker.originalState;
    const restored = { ...(currentState as Record<string, unknown>) };
    if (marker.hadPreviousTag) restored[HISTORY_STATE_KEY] = marker.previousTag;
    else delete restored[HISTORY_STATE_KEY];
    return restored;
  };

  const replaceOwnedTagInPlace = (): boolean => {
    const currentState = readState();
    if (!isOwnedSameUrlState(currentState)) return false;
    try {
      input.history.replaceState(restoreOwnedState(currentState), "");
      return true;
    } catch {
      return false;
    }
  };

  const handlePopState = (): void => {
    if (active) pushBlockingEntry();
  };

  const removeStrandedListener = (): void => {
    try {
      removeStrandedTagListener?.();
    } catch {
      // Listener cleanup is best-effort and never changes navigation state.
    }
    removeStrandedTagListener = null;
  };

  const clearCleanupPopTimer = (): void => {
    if (cleanupPopTimer === null) return;
    clearTimeout(cleanupPopTimer);
    cleanupPopTimer = null;
  };

  const cancelPendingCleanup = (): void => {
    generation += 1;
    clearCleanupPopTimer();
    pendingPop = false;
    cleanupPopObserved = false;
    removeStrandedListener();
  };

  const watchForStrandedTag = (): void => {
    if (removeStrandedTagListener) return;
    const strandedGeneration = ++generation;
    const strandedOwnerGeneration = ++ownerLifecycle.generation;
    try {
      removeStrandedTagListener = input.addPopStateListener(() => {
        if (
          generation !== strandedGeneration
          || ownerLifecycle.generation !== strandedOwnerGeneration
        ) {
          removeStrandedListener();
          return;
        }
        if (!isOwnedSameUrlState(readState())) return;
        if (replaceOwnedTagInPlace()) {
          removeStrandedListener();
          historyOwnerLifecycles.delete(owner);
        }
      });
    } catch {
      removeStrandedTagListener = null;
    }
  };

  const popCurrentOwnedGuard = (): void => {
    if (pendingPop || !isOwnedSameUrlState(readState())) return;

    pendingPop = true;
    cleanupPopObserved = false;
    const cleanupGeneration = ++generation;
    const cleanupOwnerGeneration = ++ownerLifecycle.generation;
    try {
      removeStrandedTagListener = input.addPopStateListener(() => {
        if (
          generation !== cleanupGeneration
          || ownerLifecycle.generation !== cleanupOwnerGeneration
        ) {
          clearCleanupPopTimer();
          pendingPop = false;
          removeStrandedListener();
          return;
        }
        cleanupPopObserved = true;
        clearCleanupPopTimer();
        pendingPop = false;
        if (isOwnedSameUrlState(readState())) replaceOwnedTagInPlace();
        removeStrandedListener();
        historyOwnerLifecycles.delete(owner);
      });
    } catch {
      pendingPop = false;
      removeStrandedTagListener = null;
      return;
    }

    cleanupPopTimer = setTimeout(() => {
      cleanupPopTimer = null;
      if (
        generation !== cleanupGeneration
        || ownerLifecycle.generation !== cleanupOwnerGeneration
      ) {
        pendingPop = false;
        removeStrandedListener();
        return;
      }
      if (
        active
        || activeOwners > 0
        || ownerLifecycle.activeOwners > 0
        || !pendingPop
        || cleanupPopObserved
        || !isOwnedSameUrlState(readState())
      ) {
        pendingPop = false;
        removeStrandedListener();
        if (!active && activeOwners === 0) watchForStrandedTag();
        return;
      }
      try {
        input.history.back();
      } catch {
        pendingPop = false;
        replaceOwnedTagInPlace();
        removeStrandedListener();
        historyOwnerLifecycles.delete(owner);
      }
    }, CLEANUP_POP_GRACE_MS);
  };

  return {
    activate() {
      activeOwners += 1;
      if (activeOwners === 1) {
        active = true;
        cancelPendingCleanup();
        try {
          removePopStateListener = input.addPopStateListener(handlePopState);
        } catch {
          removePopStateListener = null;
        }
        pushBlockingEntry();
      }
      const activationOwnerLifecycle = ownerLifecycle;
      activationOwnerLifecycle.activeOwners += 1;
      activationOwnerLifecycle.generation += 1;

      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
        activeOwners = Math.max(0, activeOwners - 1);
        activationOwnerLifecycle.activeOwners = Math.max(0, activationOwnerLifecycle.activeOwners - 1);
        activationOwnerLifecycle.generation += 1;
        if (activeOwners > 0) return;

        active = false;
        try {
          removePopStateListener?.();
        } catch {
          // Listener cleanup is best-effort and must not resolve the dialog.
        }
        removePopStateListener = null;

        if (activationOwnerLifecycle.activeOwners > 0) return;

        if (isOwnedSameUrlState(readState())) popCurrentOwnedGuard();
        else watchForStrandedTag();
      };
    },
  };
}
