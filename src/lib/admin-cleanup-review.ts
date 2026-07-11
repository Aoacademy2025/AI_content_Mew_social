export type AdminCleanupSelection = Readonly<{
  olderThanDays: number;
  includeStocks: boolean;
  includeTmp: boolean;
}>;

export type AdminCleanupReviewRequest<T> =
  | {
    current: boolean;
    ok: true;
    selection: AdminCleanupSelection;
    value: T;
  }
  | {
    current: boolean;
    ok: false;
    selection: AdminCleanupSelection;
    error: unknown;
  };

function copySelection(selection: AdminCleanupSelection): AdminCleanupSelection {
  return {
    olderThanDays: selection.olderThanDays,
    includeStocks: selection.includeStocks,
    includeTmp: selection.includeTmp,
  };
}

export function adminCleanupSelectionsEqual(
  left: AdminCleanupSelection,
  right: AdminCleanupSelection,
): boolean {
  return left.olderThanDays === right.olderThanDays &&
    left.includeStocks === right.includeStocks &&
    left.includeTmp === right.includeTmp;
}

export function createAdminCleanupReviewCoordinator(initial: AdminCleanupSelection) {
  let selected = copySelection(initial);
  let requestId = 0;

  return {
    setSelection(next: AdminCleanupSelection): void {
      if (adminCleanupSelectionsEqual(selected, next)) return;
      selected = copySelection(next);
      requestId++;
    },

    getSelection(): AdminCleanupSelection {
      return copySelection(selected);
    },

    invalidate(): void {
      requestId++;
    },

    async request<T>(
      load: (selection: AdminCleanupSelection) => Promise<T>,
    ): Promise<AdminCleanupReviewRequest<T>> {
      const selection = copySelection(selected);
      const ownRequestId = ++requestId;
      try {
        const value = await load(selection);
        return {
          current: ownRequestId === requestId && adminCleanupSelectionsEqual(selection, selected),
          ok: true,
          selection,
          value,
        };
      } catch (error) {
        return {
          current: ownRequestId === requestId && adminCleanupSelectionsEqual(selection, selected),
          ok: false,
          selection,
          error,
        };
      }
    },
  };
}
