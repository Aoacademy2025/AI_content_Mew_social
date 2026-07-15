const HISTORY_STATE_KEY = "__heroEditorConflict";
const HISTORY_STATE_TOKEN = "hero-editor-conflict-v1";

function isBlockingDialogState(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && (value as Record<string, unknown>)[HISTORY_STATE_KEY] === HISTORY_STATE_TOKEN;
}

export function createBlockingDialogHistory(input: {
  history: Pick<History, "state" | "pushState" | "back">;
  addPopStateListener: (listener: () => void) => () => void;
  scheduleMacrotask?: (callback: () => void) => () => void;
}): {
  activate(): () => void;
} {
  let activeOwners = 0;
  let active = false;
  let removePopStateListener: (() => void) | null = null;
  let removeStrandedTagListener: (() => void) | null = null;
  let cancelScheduledTraversal: (() => void) | null = null;

  const scheduleMacrotask = input.scheduleMacrotask ?? ((callback: () => void) => {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  });

  const readState = (): unknown => {
    try {
      return input.history.state;
    } catch {
      return null;
    }
  };

  const pushBlockingEntry = (): void => {
    const currentState = readState();
    if (isBlockingDialogState(currentState)) return;
    try {
      const nextState = currentState
        && typeof currentState === "object"
        && !Array.isArray(currentState)
        ? { ...currentState, [HISTORY_STATE_KEY]: HISTORY_STATE_TOKEN }
        : { [HISTORY_STATE_KEY]: HISTORY_STATE_TOKEN };
      input.history.pushState(nextState, "");
    } catch {
      // Some embedded browsers restrict History. The dialog remains controlled/open.
    }
  };

  const handlePopState = (): void => {
    if (active) pushBlockingEntry();
  };

  const removeStrandedListener = (): void => {
    try {
      removeStrandedTagListener?.();
    } catch {
      // A stale listener is safer than changing the current navigation entry.
    }
    removeStrandedTagListener = null;
  };

  const scheduleOwnedTagConsumption = (): void => {
    try {
      cancelScheduledTraversal?.();
    } catch {
      // A cancelled cleanup will still re-check ownership before traversing.
    }
    cancelScheduledTraversal = null;
    try {
      cancelScheduledTraversal = scheduleMacrotask(() => {
        cancelScheduledTraversal = null;
        if (active || activeOwners > 0 || !isBlockingDialogState(readState())) return;
        try {
          input.history.back();
        } catch {
          // Resolution must continue even when a browser refuses history traversal.
        }
      });
    } catch {
      // Scheduling failure cannot resolve or dismiss the conflict surface.
    }
  };

  const watchForStrandedTag = (): void => {
    if (removeStrandedTagListener) return;
    try {
      removeStrandedTagListener = input.addPopStateListener(() => {
        const landedOnOwnedTag = isBlockingDialogState(readState());
        removeStrandedListener();
        if (landedOnOwnedTag) scheduleOwnedTagConsumption();
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
          cancelScheduledTraversal?.();
        } catch {
          // The scheduled callback still verifies that this blocker is inactive.
        }
        cancelScheduledTraversal = null;
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

        if (isBlockingDialogState(readState())) scheduleOwnedTagConsumption();
        else watchForStrandedTag();
      };
    },
  };
}
