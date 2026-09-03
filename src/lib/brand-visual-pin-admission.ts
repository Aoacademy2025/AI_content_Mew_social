import type { BrandVisualAccessDecision } from "@/lib/brand-visual-rollout.server";

/** The only cohorts a live image decision can be ADMITTED under. The synthetic
 * `existing-pin` cohort is deliberately absent: it is the grandfather clause's
 * OUTPUT, so stamping it would let one pin mint the next one, and the rejecting
 * cohorts (`off`, `not-entitled`, `rollout-wait`) can never carry a stamp. */
export const ADMITTED_PIN_COHORTS = [
  "internal",
  "treatment-10",
  "treatment-50",
  "treatment-100",
] as const satisfies readonly BrandVisualAccessDecision["cohort"][];

export type AdmittedPinCohort = (typeof ADMITTED_PIN_COHORTS)[number];

export function isAdmittedPinCohort(value: string | null | undefined): value is AdmittedPinCohort {
  return (ADMITTED_PIN_COHORTS as readonly string[]).includes(value ?? "");
}

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
  cohort: AdmittedPinCohort;
  at: Date;
} | null;

/** The stamp IS the writer's live image decision. `canUse: false` deliberately
 * produces `null`: an unadmitted write must CLEAR any earlier admission rather
 * than leave a stale one behind, which is what makes a downgrade followed by a
 * re-pin fail closed. An unrecognised cohort fails closed the same way, so a
 * future cohort has to be added to `ADMITTED_PIN_COHORTS` on purpose before it
 * can grandfather anything. */
export function pinAdmissionFromDecision(
  decision: Pick<BrandVisualAccessDecision, "canUse" | "cohort">,
  now: Date = new Date(),
): PinAdmission {
  return decision.canUse && isAdmittedPinCohort(decision.cohort)
    ? { cohort: decision.cohort, at: now }
    : null;
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

export type PersistedPinAdmissionFields = PersistedProjectPinFields & BrandVisualPinAdmissionFields;

/** The stamp as a value: BOTH columns must be present and the cohort must be one
 * that actually admits somebody, otherwise there is no admission to read. */
export function persistedPinAdmission(project: BrandVisualPinAdmissionFields): PinAdmission {
  return isAdmittedPinCohort(project.brandVisualPinAdmittedCohort) && project.brandVisualPinAdmittedAt
    ? { cohort: project.brandVisualPinAdmittedCohort, at: project.brandVisualPinAdmittedAt }
    : null;
}

/** The render-time authorization predicate: a pin that actually exists AND was
 * written while its owner could use managed AI images. Both halves are required
 * — a stamp orphaned by a cleared pin admits nothing on its own. */
export function hasAdmittedPersistedPin(project: PersistedPinAdmissionFields): boolean {
  return persistedPinAdmission(project) !== null && hasPersistedProjectPin(project);
}

/**
 * The stamp a RENDER-TIME materialization must write (wave 1b Task 2, R5).
 *
 * Opening the pin to every plan means the render path itself now writes pin
 * columns (a repaired treatment pin, an upload Project Look materialised inside
 * the job transaction) for accounts the image gate rejects. Those writes go into
 * the SAME statement as the pin, and resolve to exactly one of:
 *
 *   1. the job's LIVE image decision, when it admits the owner;
 *   2. the stamp the project ALREADY holds, when it holds an admitted pin — the
 *      existing-pin path, whose original cohort and time must not be reminted;
 *   3. nothing.
 *
 * Case 3 is what stops an ORPHAN stamp (one left behind by a cleared pin, e.g.
 * `BrandProfileRevision` `onDelete: SetNull`) from being recombined with a pin
 * the render materialises afterwards.
 */
export function renderTimePinAdmissionFields(input: {
  liveAdmission: PinAdmission;
  project: PersistedPinAdmissionFields;
}): BrandVisualPinAdmissionFields {
  if (input.liveAdmission) return brandVisualPinAdmissionFields(input.liveAdmission);
  return brandVisualPinAdmissionFields(
    hasAdmittedPersistedPin(input.project) ? persistedPinAdmission(input.project) : null,
  );
}
