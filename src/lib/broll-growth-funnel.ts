export type BrollGrowthEdit = {
  index?: unknown;
  start?: unknown;
  end?: unknown;
  startSec?: unknown;
  endSec?: unknown;
  src?: unknown;
  enabled?: unknown;
  replacementKind?: unknown;
  kind?: unknown;
};

export type BrollGrowthSummary = {
  editCount: number;
  replacementCount: number;
  boundaryChangeCount: number;
  visibilityChangeCount: number;
  stockReplacementCount: number;
  uploadReplacementCount: number;
  aiReplacementCount: number;
};

const EMPTY_SUMMARY: BrollGrowthSummary = {
  editCount: 0,
  replacementCount: 0,
  boundaryChangeCount: 0,
  visibilityChangeCount: 0,
  stockReplacementCount: 0,
  uploadReplacementCount: 0,
  aiReplacementCount: 0,
};

/**
 * Aggregate-only product telemetry for the B-roll edit funnel. Asset paths, job IDs,
 * keywords and other creator content are deliberately absent from the return type.
 */
export function summarizeBrollGrowthEdits(edits: readonly BrollGrowthEdit[]): BrollGrowthSummary {
  const summary = { ...EMPTY_SUMMARY, editCount: edits.length };
  for (const edit of edits) {
    const replacement = typeof edit.src === "string" && edit.src.length > 0;
    if (replacement) summary.replacementCount += 1;
    if (
      typeof edit.start === "number"
      || typeof edit.end === "number"
      || typeof edit.startSec === "number"
      || typeof edit.endSec === "number"
    ) summary.boundaryChangeCount += 1;
    if (typeof edit.enabled === "boolean") summary.visibilityChangeCount += 1;

    const kind = edit.replacementKind ?? edit.kind;
    if (!replacement) continue;
    if (kind === "stock") summary.stockReplacementCount += 1;
    else if (kind === "upload") summary.uploadReplacementCount += 1;
    else if (kind === "ai") summary.aiReplacementCount += 1;
  }
  return summary;
}

export function brollExportCompletionProperties(source: {
  type?: string | null;
  inputJson?: string | null;
}): BrollGrowthSummary | null {
  if (source.type !== "broll-rerender") return null;
  try {
    const input = JSON.parse(source.inputJson ?? "null") as { windowEdits?: unknown } | null;
    return summarizeBrollGrowthEdits(Array.isArray(input?.windowEdits) ? input.windowEdits : []);
  } catch {
    return { ...EMPTY_SUMMARY };
  }
}
