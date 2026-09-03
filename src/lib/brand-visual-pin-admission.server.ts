import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveBrandVisualAccessByUserId } from "@/lib/brand-visual-rollout.server";
import {
  brandVisualPinAdmissionFields,
  pinAdmissionFromDecision,
  type PinAdmission,
} from "@/lib/brand-visual-pin-admission";

// The pure half of the contract (the stamp shape and its two predicates) lives
// in `@/lib/brand-visual-pin-admission` so that pin writers which are not
// themselves `server-only` can reach it. Re-exported here so a server caller
// needs one import.
export {
  brandVisualPinAdmissionFields,
  hasAdmittedPersistedPin,
  hasPersistedProjectPin,
  pinAdmissionFromDecision,
} from "@/lib/brand-visual-pin-admission";
export type {
  BrandVisualPinAdmissionFields,
  PersistedProjectPinFields,
  PinAdmission,
} from "@/lib/brand-visual-pin-admission";

/** Stamp (or clear) an existing project's admission inside the pin's own
 * transaction. Ownership is enforced by the pin write that precedes it. */
export async function recordBrandVisualPinAdmission(
  tx: Prisma.TransactionClient,
  projectId: string,
  admission: PinAdmission | undefined,
): Promise<void> {
  await tx.editorProject.update({
    where: { id: projectId },
    data: brandVisualPinAdmissionFields(admission),
  });
}

/**
 * The image decision for a pin writer that only knows the OWNER's id — the two
 * system-initiated writers (Hero Script's send-to-editor and the First-Clip
 * auto-spine) that sit outside the image guard, and the backfill. Resolved
 * immediately before the pin's transaction, exactly like a creator route
 * resolves `auth.access` before its own write. An unknown owner fails closed.
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
