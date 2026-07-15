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
}): {
  activate(): () => void;
} {
  let activeOwners = 0;
  let active = false;
  let removePopStateListener: (() => void) | null = null;

  const readState = (): unknown => {
    try {
      return input.history.state;
    } catch {
      return null;
    }
  };

  const pushBlockingEntry = (): void => {
    if (isBlockingDialogState(readState())) return;
    try {
      input.history.pushState({ [HISTORY_STATE_KEY]: HISTORY_STATE_TOKEN }, "");
    } catch {
      // Some embedded browsers restrict History. The dialog remains controlled/open.
    }
  };

  const handlePopState = (): void => {
    if (active) pushBlockingEntry();
  };

  return {
    activate() {
      activeOwners += 1;
      if (activeOwners === 1) {
        active = true;
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

        if (!isBlockingDialogState(readState())) return;
        try {
          input.history.back();
        } catch {
          // Resolution must continue even when a browser refuses history traversal.
        }
      };
    },
  };
}
