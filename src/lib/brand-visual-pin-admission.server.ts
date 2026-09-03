import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveBrandVisualAccessByUserId } from "@/lib/brand-visual-rollout.server";
import {
  brandVisualPinAdmissionFields,
  pinAdmissionFromDecision,
  renderTimePinAdmissionFields,
  type BrandVisualPinAdmissionFields,
  type PinAdmission,
} from "@/lib/brand-visual-pin-admission";

// The pure half of the contract (the stamp shape and its predicates) lives in
// `@/lib/brand-visual-pin-admission` so that pin writers which are not
// themselves `server-only` can reach it. Re-exported here so a server caller
// needs one import.
export {
  ADMITTED_PIN_COHORTS,
  brandVisualPinAdmissionFields,
  hasAdmittedPersistedPin,
  hasPersistedProjectPin,
  isAdmittedPinCohort,
  persistedPinAdmission,
  pinAdmissionFromDecision,
  renderTimePinAdmissionFields,
} from "@/lib/brand-visual-pin-admission";
export type {
  AdmittedPinCohort,
  BrandVisualPinAdmissionFields,
  PersistedPinAdmissionFields,
  PersistedProjectPinFields,
  PinAdmission,
} from "@/lib/brand-visual-pin-admission";

/** The columns any admission read needs: the pin itself plus BOTH halves of its
 * stamp. */
export const persistedPinAdmissionSelect = {
  projectLookJson: true,
  brandProfileRevisionId: true,
  treatmentPresetId: true,
  treatmentPresetVersion: true,
  brandVisualPinAdmittedCohort: true,
  brandVisualPinAdmittedAt: true,
} as const;

/** Stamp (or clear) an existing project's admission inside the pin's own
 * transaction. The stamp IS an authorization record, so it is ownership-scoped
 * in its own right instead of trusting the caller's project id. */
export async function recordBrandVisualPinAdmission(
  tx: Prisma.TransactionClient,
  owner: { projectId: string; userId: string },
  admission: PinAdmission | undefined,
): Promise<void> {
  await tx.editorProject.updateMany({
    where: { id: owner.projectId, userId: owner.userId },
    data: brandVisualPinAdmissionFields(admission),
  });
}

/**
 * The image decision for a pin writer that only knows the OWNER's id — the two
 * system-initiated writers (Hero Script's send-to-editor and the First-Clip
 * auto-spine) that sit outside the image guard, and the backfill. Resolved
 * immediately before the pin's transaction, exactly like a creator route
 * resolves its image decision before its own write. An unknown owner fails
 * closed.
 */
export async function resolveOwnerPinAdmission(
  userId: string,
  now: Date = new Date(),
): Promise<PinAdmission> {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, suspended: true },
  });
  if (!owner) return null;
  return pinAdmissionFromDecision(await resolveBrandVisualAccessByUserId(owner), now);
}

/**
 * The stamp a RENDER-TIME pin materialization must write for one owner/project
 * (wave 1b Task 2, R5). Wave 1b lets every plan pin, so the render path itself
 * now writes pin columns for accounts the image gate rejects. Resolve the
 * owner's live image decision here, exactly as a creator route resolves its own
 * before writing, then let the pure rule pick between it, the project's existing
 * ADMITTED stamp, and nothing. Fails closed: a project that does not exist, or
 * is not this owner's, stamps nothing.
 */
export async function resolveRenderTimePinAdmissionFields(input: {
  userId: string;
  projectId: string;
  now?: Date;
}): Promise<BrandVisualPinAdmissionFields> {
  const [liveAdmission, project] = await Promise.all([
    resolveOwnerPinAdmission(input.userId, input.now),
    prisma.editorProject.findFirst({
      where: { id: input.projectId, userId: input.userId },
      select: persistedPinAdmissionSelect,
    }),
  ]);
  return renderTimePinAdmissionFields({
    liveAdmission,
    project: project ?? {
      projectLookJson: null,
      brandProfileRevisionId: null,
      treatmentPresetId: null,
      treatmentPresetVersion: null,
      brandVisualPinAdmittedCohort: null,
      brandVisualPinAdmittedAt: null,
    },
  });
}
