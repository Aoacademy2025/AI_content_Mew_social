import type { VideoJobPreviewData } from "@/lib/mcp/video-job";

export type EditorExportCardLen = "sentence" | "1" | "2" | "3" | "4";

export type EditorExportSubtitleConfig = {
  preset: string;
  effect: string;
  fontFamily: string;
  bold: boolean;
  fontWeight?: 400 | 600 | 900;
  fontSize: number;
  textColor: string;
  accentColor: string;
  shadow: boolean;
  outline: boolean;
  outlineSize: number;
  verticalPos: number;
};

export type EditorExportCaptionOverrides = Record<number, {
  textColor?: string;
  accentColor?: string;
}>;

export type EditorExportDraft = {
  version: 1;
  captions: VideoJobPreviewData["captions"];
  originalCaptions: VideoJobPreviewData["captions"];
  subtitleConfig: EditorExportSubtitleConfig;
  cardLen: EditorExportCardLen;
  captionOverrides: EditorExportCaptionOverrides;
};

export type EditorExportSnapshot = EditorExportDraft & {
  videoUrl: string;
  preview: VideoJobPreviewData;
};

/** The narrow, validated subset of a failed export input that the editor may resume. */
export type FailedEditorExportRecovery = {
  sourceJobId: string;
  editSnapshot: EditorExportSnapshot;
};

const CARD_LENS = new Set<EditorExportCardLen>(["sentence", "1", "2", "3", "4"]);
const FONT_WEIGHTS = new Set([400, 600, 900]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function normalizeCaptions(value: unknown): VideoJobPreviewData["captions"] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const captions: VideoJobPreviewData["captions"] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (!item) return null;
    const text = boundedString(item.text, 4_000);
    const startMs = finiteNumber(item.startMs, 0, 86_400_000);
    const endMs = finiteNumber(item.endMs, 0, 86_400_000);
    const tag = item.tag === undefined ? undefined : boundedString(item.tag, 80);
    if (text === null || startMs === null || endMs === null || endMs < startMs || tag === null) {
      return null;
    }
    captions.push({ text, startMs, endMs, ...(tag === undefined ? {} : { tag }) });
  }
  return captions;
}

function normalizeSubtitleConfig(value: unknown): EditorExportSubtitleConfig | null {
  const input = record(value);
  if (!input) return null;
  const preset = boundedString(input.preset, 80);
  const effect = boundedString(input.effect, 80);
  const fontFamily = boundedString(input.fontFamily, 200);
  const fontSize = finiteNumber(input.fontSize, 1, 1_000);
  const textColor = boundedString(input.textColor, 64);
  const accentColor = boundedString(input.accentColor, 64);
  const outlineSize = finiteNumber(input.outlineSize, 0, 100);
  const verticalPos = finiteNumber(input.verticalPos, 0, 100);
  const fontWeight = input.fontWeight === undefined ? undefined : Number(input.fontWeight);
  if (
    preset === null
    || effect === null
    || fontFamily === null
    || fontSize === null
    || textColor === null
    || accentColor === null
    || outlineSize === null
    || verticalPos === null
    || typeof input.bold !== "boolean"
    || typeof input.shadow !== "boolean"
    || typeof input.outline !== "boolean"
    || (fontWeight !== undefined && !FONT_WEIGHTS.has(fontWeight))
  ) return null;
  return {
    preset,
    effect,
    fontFamily,
    bold: input.bold,
    ...(fontWeight === undefined ? {} : { fontWeight: fontWeight as 400 | 600 | 900 }),
    fontSize,
    textColor,
    accentColor,
    shadow: input.shadow,
    outline: input.outline,
    outlineSize,
    verticalPos,
  };
}

function normalizeCaptionOverrides(
  value: unknown,
  captionCount: number,
): EditorExportCaptionOverrides | null {
  const input = record(value);
  if (!input || Object.keys(input).length > captionCount) return null;
  const overrides: EditorExportCaptionOverrides = {};
  for (const [rawIndex, candidate] of Object.entries(input)) {
    const index = Number(rawIndex);
    const item = record(candidate);
    if (!Number.isInteger(index) || index < 0 || index >= captionCount || !item) return null;
    const textColor = item.textColor === undefined ? undefined : boundedString(item.textColor, 64);
    const accentColor = item.accentColor === undefined ? undefined : boundedString(item.accentColor, 64);
    if (textColor === null || accentColor === null) return null;
    overrides[index] = {
      ...(textColor === undefined ? {} : { textColor }),
      ...(accentColor === undefined ? {} : { accentColor }),
    };
  }
  return overrides;
}

/** Normalize the browser-owned, compact editor state before it crosses the durable job seam. */
export function normalizeEditorExportDraft(value: unknown): EditorExportDraft | null {
  const input = record(value);
  if (!input || input.version !== 1 || !CARD_LENS.has(input.cardLen as EditorExportCardLen)) return null;
  const captions = normalizeCaptions(input.captions);
  const originalCaptions = normalizeCaptions(input.originalCaptions);
  const subtitleConfig = normalizeSubtitleConfig(input.subtitleConfig);
  if (!captions || !originalCaptions || !subtitleConfig) return null;
  const captionOverrides = normalizeCaptionOverrides(input.captionOverrides, captions.length);
  if (!captionOverrides) return null;
  return {
    version: 1,
    captions,
    originalCaptions,
    subtitleConfig,
    cardLen: input.cardLen as EditorExportCardLen,
    captionOverrides,
  };
}

export function createEditorExportSnapshot(input: {
  draft: unknown;
  sourcePreview: VideoJobPreviewData;
  videoUrl: unknown;
}): EditorExportSnapshot | null {
  const draft = normalizeEditorExportDraft(input.draft);
  const videoUrl = boundedString(input.videoUrl, 20_000);
  if (!draft || !videoUrl) return null;
  return {
    ...draft,
    videoUrl,
    preview: {
      ...input.sourcePreview,
      captions: draft.captions,
    },
  };
}

/** Tolerant reader for completed export rows. Invalid/newer snapshots fall back to legacy resume. */
export function parseEditorExportSnapshot(value: unknown): EditorExportSnapshot | null {
  const input = record(value);
  if (!input) return null;
  const draft = normalizeEditorExportDraft(input);
  const preview = record(input.preview);
  const videoUrl = boundedString(input.videoUrl, 20_000);
  const previewCaptions = normalizeCaptions(preview?.captions);
  if (
    !draft
    || !preview
    || !videoUrl
    || !previewCaptions
    || !record(preview.config)
    || boundedString(preview.voiceUrl, 20_000) === null
    || finiteNumber(preview.audioDurationMs, 0, 86_400_000) === null
  ) return null;
  return {
    ...draft,
    videoUrl,
    preview: {
      ...preview as unknown as VideoJobPreviewData,
      captions: previewCaptions,
      config: { ...preview.config as Record<string, unknown> },
      voiceUrl: preview.voiceUrl as string,
      audioDurationMs: preview.audioDurationMs as number,
    },
  };
}

/**
 * Read the durable editor state from a terminal export's private input payload.
 * Callers expose only this validated projection; the full input can contain render config
 * and must never be returned by the job polling API.
 */
export function parseFailedEditorExportRecovery(
  inputJson: string | null | undefined,
): FailedEditorExportRecovery | null {
  if (!inputJson) return null;
  try {
    const input = record(JSON.parse(inputJson));
    if (!input || input.mode !== "export") return null;
    const sourceJobId = boundedString(input.sourceJobId, 120);
    const editSnapshot = parseEditorExportSnapshot(input.editSnapshot);
    if (!sourceJobId || !editSnapshot) return null;
    return { sourceJobId, editSnapshot };
  } catch {
    return null;
  }
}
