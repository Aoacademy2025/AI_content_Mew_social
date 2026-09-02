import type { BrandPayload } from "./types";

/** Everything that decides which already-generated images a Brand Look Preview
 * can reuse — and therefore how many images it charges for. */
export type BrandPreviewSource = {
  /** The saved Brand Profile being edited, or null for an unsaved Project Look. */
  profileId: string | null;
  /** The clip this look was promoted from, when the wizard carried it in. */
  projectId: string | null;
  preflightId: string | null;
};

/** The single reuse lineage that the quote and the generate call must share.
 * Quoting a different lineage than generation uses is what let the panel
 * disclose six credits for work that charged less (audit 2026-09-02, F1/F2). */
export function brandPreviewLineage(source: BrandPreviewSource): {
  projectId?: string;
  preflightId?: string;
  profileId?: string;
  useDraft?: boolean;
} {
  return {
    ...(source.projectId
      ? {
          projectId: source.projectId,
          ...(source.preflightId ? { preflightId: source.preflightId } : {}),
        }
      : {}),
    // A saved profile always previews the draft the creator is looking at; the
    // generate call saves that draft first, so both read the same payload.
    ...(source.profileId ? { profileId: source.profileId, useDraft: true } : {}),
  };
}

/** Body for POST /api/brand-library/preview-quote. */
export function brandPreviewQuoteBody(
  source: BrandPreviewSource,
  payload: BrandPayload,
): Record<string, unknown> {
  return { payload, ...brandPreviewLineage(source) };
}

/** Endpoint and body for the generate call, built from the same lineage the
 * quote disclosed. The profile id travels in the path, so it is dropped from
 * the body; the saved draft is the payload, so it is not re-sent. */
export function brandPreviewGenerateRequest(
  source: BrandPreviewSource,
  payload: BrandPayload,
): { endpoint: string; body: Record<string, unknown> } {
  const { profileId, ...lineage } = brandPreviewLineage(source);
  return profileId
    ? { endpoint: `/api/brand-library/${profileId}/preview`, body: { ...lineage } }
    : { endpoint: "/api/brand-library/preview", body: { payload, ...lineage } };
}
