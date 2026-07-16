const HISTORY_STATE_KEY = "__heroEditorConflict";
const HISTORY_STATE_TOKEN = "hero-editor-conflict-v2";

let historyOwnerSequence = 0;

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
  let activeOwners = 0;
  let active = false;
  let removePopStateListener: (() => void) | null = null;
  let removeStrandedTagListener: (() => void) | null = null;

  const readState = (): unknown => {
    try {
      return input.history.state;
    } catch {
      return null;
    }
  };

  const isOwnedState = (value: unknown): boolean => blockingHistoryMarker(value)?.owner === owner;

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
      return;
    }
    try {
      input.history.pushState(taggedState(currentState), "");
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
    if (!isOwnedState(currentState)) return false;
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

  const watchForStrandedTag = (): void => {
    if (removeStrandedTagListener) return;
    try {
      removeStrandedTagListener = input.addPopStateListener(() => {
        if (!isOwnedState(readState())) return;
        if (replaceOwnedTagInPlace()) removeStrandedListener();
      });
    } catch {
      removeStrandedTagListener = null;
    }
  };

  return {
    activate() {
      activeOwners += 1;
      if (activeOwners === 1) {
        active = true;
        removeStrandedListener();
        try {
          removePopStateListener = input.addPopStateListener(handlePopState);
        } catch {
          removePopStateListener = null;
        }
        pushBlockingEntry();
      }

      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
        activeOwners = Math.max(0, activeOwners - 1);
        if (activeOwners > 0) return;

        active = false;
        try {
          removePopStateListener?.();
        } catch {
          // Listener cleanup is best-effort and must not resolve the dialog.
        }
        removePopStateListener = null;

        if (!replaceOwnedTagInPlace()) watchForStrandedTag();
      };
    },
  };
}
