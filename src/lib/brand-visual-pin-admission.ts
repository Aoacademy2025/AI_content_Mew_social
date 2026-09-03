import type { BrandVisualAccessDecision } from "@/lib/brand-visual-rollout.server";

/**
 * A persisted project pin (Brand Revision, Project Look or Treatment pin) is an
 * unconditional grandfather clause in `resolveBrandVisualRenderAccess` — the
 * synthetic `existing-pin` cohort — so that a downgrade or a rollout rollback
 * can never break a rerender of work that was ALREADY admitted to managed AI
 * images. ADR 0059's 2026-09-02 amendment (#430) anchors that clause: a pin
 * carries the image decision taken at the moment it was written, and only an
 * ADMITTED pin grandfathers anything. A pin written for an account the image
 * gate rejects is still a perfectly good look for stock B-roll, subtitles,
 * voice, logo and pacing — it simply admits nobody to the image route.
 *
 * These helpers are pure so that every pin writer can reach them, including the
 * ones that are not themselves `server-only`. The decision/DB side lives in
 * `brand-visual-pin-admission.server.ts`.
 */
export type PinAdmission = {
  cohort: BrandVisualAccessDecision["cohort"];
  at: Date;
} | null;

/** The stamp IS the writer's live image decision. `canUse: false` deliberately
 * produces `null`: an unadmitted write must CLEAR any earlier admission rather
 * than leave a stale one behind, which is what makes a downgrade followed by a
 * re-pin fail closed. */
export function pinAdmissionFromDecision(
  decision: Pick<BrandVisualAccessDecision, "canUse" | "cohort">,
  now: Date = new Date(),
): PinAdmission {
  return decision.canUse ? { cohort: decision.cohort, at: now } : null;
}

export type BrandVisualPinAdmissionFields = {
  brandVisualPinAdmittedCohort: string | null;
  brandVisualPinAdmittedAt: Date | null;
};

/** Merge into the SAME `create`/`update` that writes the pin, so the pin and its
 * admission can never commit apart. An omitted admission (a writer that forgot
 * to resolve one) is treated exactly like a refusal. */
export function brandVisualPinAdmissionFields(
  admission: PinAdmission | undefined,
): BrandVisualPinAdmissionFields {
  return admission
    ? { brandVisualPinAdmittedCohort: admission.cohort, brandVisualPinAdmittedAt: admission.at }
    : { brandVisualPinAdmittedCohort: null, brandVisualPinAdmittedAt: null };
}

export type PersistedProjectPinFields = {
  projectLookJson: string | null;
  brandProfileRevisionId: string | null;
  treatmentPresetId: string | null;
  treatmentPresetVersion: string | null;
};

/** The persisted-selection predicate the editor and quote surfaces already use:
 * does this project own a visual selection at all? */
export function hasPersistedProjectPin(project: PersistedProjectPinFields): boolean {
  return Boolean(
    project.projectLookJson
    || project.brandProfileRevisionId
    || (project.treatmentPresetId && project.treatmentPresetVersion),
  );
}

/** The render-time authorization predicate: a pin that actually exists AND was
 * written while its owner could use managed AI images. Both halves are required
 * — a stamp orphaned by a cleared pin admits nothing on its own. */
export function hasAdmittedPersistedPin(
  project: PersistedProjectPinFields & { brandVisualPinAdmittedCohort: string | null },
): boolean {
  return Boolean(project.brandVisualPinAdmittedCohort) && hasPersistedProjectPin(project);
}
