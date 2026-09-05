import type { BrandProfileSeed } from "@/lib/brand-profile-seed";
import type { BrandSetupRequest, BrandSetupResult } from "@/lib/brand-setup";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type BrandSetupDraft = { userId: string; profileId: string | null; projectId: string | null; expectedRevision: number | null; payload: BrandProfileSeed; savedAt: number };
const prefix = "hero:brand-setup:v1:";
export const brandSetupDraftKey = (userId: string, profileId: string | null, projectId: string | null) => `${prefix}${userId}:draft:${projectId ? `project:${projectId}` : profileId ?? "new"}`;

/** Check persisted browser data before hydrating the form. A corrupt or old
 * record must not crash the page or overwrite a valid server-loaded draft. */
function validPayload(value: unknown): value is BrandProfileSeed {
  if (!value || typeof value !== "object") return false;
  const p = value as BrandProfileSeed;
  return p.schemaVersion === 1 && [p.name, p.niche, p.audience, p.script?.tone, p.voice?.provider, p.visual?.personality, p.visual?.primaryVisualFormatId, p.visual?.visualNotes].every((v) => typeof v === "string")
    && Array.isArray(p.script?.bannedWords) && p.script.bannedWords.every((v) => typeof v === "string")
    && Array.isArray(p.visual?.palette) && p.visual.palette.every((v) => typeof v === "string")
    && [p.script.ctaStyle, p.script.language, p.visual.defaultTreatment].every((v) => typeof v === "string")
    && [p.script.styleId, p.voice.voiceId, p.subtitle?.presetId, p.brandMark?.assetId].every((v) => v === null || typeof v === "string")
    && !!p.subtitle?.config && !Array.isArray(p.subtitle.config) && typeof p.subtitle.config === "object"
    && Object.values(p.subtitle.config).every((v) => v === null || ["string", "boolean", "number"].includes(typeof v))
    && typeof p.brandMark?.enabled === "boolean" && typeof p.brandMark.position === "string"
    && Number.isFinite(p.brandMark.sizePct) && Number.isFinite(p.brandMark.opacity)
    && ["adaptive", "locked"].includes(p.visual.treatmentPolicy) && ["defined", "none"].includes(p.visual.languageMode);
}

export function readBrandSetupDraft(storage: StorageLike, userId: string, profileId: string | null, projectId: string | null): BrandSetupDraft | null {
  try {
    const value = JSON.parse(storage.getItem(brandSetupDraftKey(userId, profileId, projectId)) || "null") as BrandSetupDraft | null;
    return value?.userId === userId && value.profileId === profileId && value.projectId === projectId && validPayload(value.payload)
      && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() + 60_000 && Date.now() - value.savedAt < 7 * 86400000
      && (value.expectedRevision === null || Number.isInteger(value.expectedRevision) && value.expectedRevision > 0) ? value : null;
  } catch { return null; }
}
export function writeBrandSetupDraft(storage: StorageLike, draft: BrandSetupDraft): boolean {
  try { storage.setItem(brandSetupDraftKey(draft.userId, draft.profileId, draft.projectId), JSON.stringify(draft)); return true; } catch { return false; }
}
export function clearBrandSetupDraft(storage: StorageLike, userId: string, profileId: string | null, projectId: string | null) {
  try { storage.removeItem(brandSetupDraftKey(userId, profileId, projectId)); } catch {}
}
export function writeBrandSetupRequest(storage: StorageLike, userId: string, request: BrandSetupRequest): boolean {
  try { storage.setItem(`${prefix}${userId}:request`, JSON.stringify(request)); return true; } catch { return false; }
}
export function readBrandSetupRequest(storage: StorageLike, userId: string): BrandSetupRequest | null {
  try {
    const request = JSON.parse(storage.getItem(`${prefix}${userId}:request`) || "null") as BrandSetupRequest | null;
    return request && typeof request.requestId === "string" && /^[0-9a-f-]{36}$/i.test(request.requestId) && ["save", "create-clip", "use-brand"].includes(request.action)
      && (request.action === "use-brand" ? typeof request.profileId === "string" && typeof request.revisionId === "string" : validPayload(request.payload)) ? request : null;
  } catch { return null; }
}
export function clearBrandSetupRequest(storage: StorageLike, userId: string) {
  try { storage.removeItem(`${prefix}${userId}:request`); } catch {}
}

export function isBrandSetupResult(value: unknown): value is BrandSetupResult {
  if (!value || typeof value !== "object") return false;
  const r = value as BrandSetupResult;
  return typeof r.profileId === "string" && !!r.profileId && typeof r.revisionId === "string" && !!r.revisionId
    && Number.isInteger(r.revision) && r.revision > 0 && (r.projectId === null || typeof r.projectId === "string" && !!r.projectId);
}
export function writeBrandSetupReceipt(storage: StorageLike, userId: string, result: BrandSetupResult): boolean {
  try { storage.setItem(`${prefix}${userId}:receipt`, JSON.stringify({ result, savedAt: Date.now() })); return true; } catch { return false; }
}
export function readBrandSetupReceipt(storage: StorageLike, userId: string): BrandSetupResult | null {
  try { const value = JSON.parse(storage.getItem(`${prefix}${userId}:receipt`) || "null"); return value && Date.now() - value.savedAt < 7 * 86400000 && isBrandSetupResult(value.result) ? value.result : null; } catch { return null; }
}
export function clearBrandSetupReceipt(storage: StorageLike, userId: string) {
  try { storage.removeItem(`${prefix}${userId}:receipt`); } catch {}
}
