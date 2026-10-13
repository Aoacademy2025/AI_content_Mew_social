/** Server-authored original window policy. Client projections are informative, never authority. */
export type ExternalMediaSlot = { index: number; owner: "presenter" | "broll"; required: boolean; originalSrc: string };
export type ExternalMediaPlan = { source: "external"; version: 1; slots: ExternalMediaSlot[] };
export type ExternalWindowState = { index: number; owner: "presenter" | "broll"; required: boolean; state: "presenter" | "unfilled" | "ready" | "pending" | "failed"; importError?: string };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function mediaWindows(config: unknown): Record<string, unknown>[] {
  const bg = record(config).bgVideos;
  return Array.isArray(bg) ? bg.map(record) : [];
}
export function externalMediaPlan(config: unknown): ExternalMediaPlan | null {
  const plan = record(record(config).externalMedia);
  return plan.source === "external" && plan.version === 1 && Array.isArray(plan.slots) ? plan as ExternalMediaPlan : null;
}
/** Called only when building the root preview, after the existing planner/config builder. */
export function authorExternalMediaPlan(config: Record<string, unknown>, presenterRanges?: { startMs: number; endMs: number }[]) {
  const bgVideos = mediaWindows(config);
  const slots = bgVideos.map((w, index): ExternalMediaSlot => {
    const midpoint = (Number(w.start) + Number(w.end)) * 500;
    const presenter = presenterRanges?.some(r => midpoint >= r.startMs && midpoint < r.endMs) ?? false;
    return { index, owner: presenter ? "presenter" : "broll", required: !presenter, originalSrc: typeof w.src === "string" ? w.src : "" };
  });
  return { ...config, bgVideos, externalMedia: { source: "external" as const, version: 1 as const, slots } };
}
export function externalWindowStates(rootConfig: unknown, effectiveConfig: unknown): ExternalWindowState[] {
  const plan = externalMediaPlan(rootConfig);
  if (!plan) return [];
  const bg = mediaWindows(effectiveConfig);
  return plan.slots.map(slot => {
    const w = bg[slot.index];
    const filled = !!w && w.brollEnabled !== false && typeof w.src === "string"
      && /^\/api\/(stocks|renders)\/[\w.-]+\.mp4$/.test(w.src) && w.src !== slot.originalSrc;
    return { index: slot.index, owner: filled ? "broll" : slot.owner, required: slot.required, state: filled ? "ready" : slot.required ? "unfilled" : "presenter" };
  });
}
/** Empty faceless backgrounds never become presenter-owned merely because they are disabled. */
export function previewWindowOwner(preview: { config: unknown; avatarModel?: string | null; cutawayPersonRanges?: { start: number; end: number }[] }, index: number): "presenter" | "broll" {
  const w = mediaWindows(preview.config)[index];
  if (!w || preview.avatarModel !== "upload-cutaway") return "broll";
  const slot = externalMediaPlan(preview.config)?.slots.find(s => s.index === index);
  if (slot?.required) return "broll";
  if (typeof w.brollEnabled === "boolean") return w.brollEnabled ? "broll" : "presenter";
  if (slot) return w.src === slot.originalSrc ? slot.owner : "broll";
  const midpoint = (Number(w.start) + Number(w.end)) / 2;
  return preview.cutawayPersonRanges?.some(r => midpoint >= r.start && midpoint < r.end) ? "presenter" : "broll";
}

/** Protect the actual planned opening presenter span, including any capped subwindows. */
export function isPresenterHookWindow(preview: Parameters<typeof previewWindowOwner>[0], layout: unknown, index: number): boolean {
  if (layout === "fillYourself" || preview.avatarModel !== "upload-cutaway") return false;
  const slots = externalMediaPlan(preview.config)?.slots;
  if (slots) return slots.some(s => s.index === index) && slots.filter(s => s.index <= index).every(s => s.owner === "presenter");
  return index === 0 && previewWindowOwner(preview, index) === "presenter";
}
