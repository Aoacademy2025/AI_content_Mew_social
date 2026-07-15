export type EditorRecoveryFocusTarget = {
  isConnected: boolean;
  disabled?: boolean;
  focus(options?: FocusOptions): void;
  closest(selector: string): unknown;
  getAttribute?(name: string): string | null;
};

type ScheduleMacrotask = (callback: () => void) => () => void;

function isUsableEditorFocusTarget(target: EditorRecoveryFocusTarget | null): target is EditorRecoveryFocusTarget {
  if (!target?.isConnected || target.disabled) return false;
  try {
    if (target.getAttribute?.("aria-disabled") === "true") return false;
    if (target.closest('[inert], [aria-hidden="true"]')) return false;
  } catch {
    return false;
  }
  return true;
}

function focusWithoutScroll(target: EditorRecoveryFocusTarget | null): boolean {
  if (!target) return false;
  try {
    target.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

export function createEditorRecoveryFocusLifecycle(input: {
  getActiveElement: () => EditorRecoveryFocusTarget | null;
  getHeading: () => EditorRecoveryFocusTarget | null;
  getFallback: () => EditorRecoveryFocusTarget | null;
  scheduleMacrotask?: ScheduleMacrotask;
}): {
  open(): void;
  close(): void;
  dispose(): void;
} {
  const scheduleMacrotask = input.scheduleMacrotask ?? ((callback: () => void) => {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  });
  let previouslyFocused: EditorRecoveryFocusTarget | null = null;
  let cancelScheduledRestore: (() => void) | null = null;

  const cancelRestore = (): void => {
    try {
      cancelScheduledRestore?.();
    } catch {
      // A pending restore still re-checks whether its target is usable.
    }
    cancelScheduledRestore = null;
  };

  return {
    open() {
      cancelRestore();
      const heading = input.getHeading();
      const activeElement = input.getActiveElement();
      if (activeElement && activeElement !== heading) previouslyFocused = activeElement;
      focusWithoutScroll(heading);
    },
    close() {
      cancelRestore();
      const preferredTarget = previouslyFocused;
      try {
        cancelScheduledRestore = scheduleMacrotask(() => {
          cancelScheduledRestore = null;
          if (
            isUsableEditorFocusTarget(preferredTarget)
            && focusWithoutScroll(preferredTarget)
          ) {
            previouslyFocused = null;
            return;
          }
          const fallback = input.getFallback();
          if (isUsableEditorFocusTarget(fallback)) focusWithoutScroll(fallback);
          previouslyFocused = null;
        });
      } catch {
        previouslyFocused = null;
      }
    },
    dispose() {
      cancelRestore();
      previouslyFocused = null;
    },
  };
}
