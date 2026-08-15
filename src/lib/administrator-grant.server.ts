import "server-only";

import type { Plan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaidEquivalentPlan, type PaidEquivalentPlan } from "@/lib/paid-equivalent-entitlement.server";
import { usageWindowForPlan } from "@/lib/usage-limits";

export class AdministratorGrantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdministratorGrantInputError";
  }
}

export type CreateAdministratorGrantInput = {
  userId: string;
  plan: PaidEquivalentPlan;
  reason: string;
  startsAt?: Date;
  expiresAt: Date | null;
  permanent: boolean;
  grantedById: string;
};

function validateInput(input: CreateAdministratorGrantInput, now: Date): void {
  if (!isPaidEquivalentPlan(input.plan)) {
    throw new AdministratorGrantInputError("แผนสิทธิ์ต้องเป็น PRO หรือ BUSINESS");
  }
  if (input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    throw new AdministratorGrantInputError("กรุณาระบุเหตุผล 3–500 ตัวอักษร");
  }
  if (input.permanent && input.expiresAt) {
    throw new AdministratorGrantInputError("สิทธิ์ถาวรต้องไม่มีวันหมดอายุ");
  }
  if (!input.permanent && (!input.expiresAt || input.expiresAt <= (input.startsAt ?? now))) {
    throw new AdministratorGrantInputError("สิทธิ์ชั่วคราวต้องมีวันหมดอายุหลังวันเริ่ม");
  }
}

export async function createAdministratorGrant(
  input: CreateAdministratorGrantInput,
  now: Date = new Date(),
) {
  validateInput(input, now);
  const startsAt = input.startsAt ?? now;
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!target) throw new AdministratorGrantInputError("ไม่พบบัญชีผู้ใช้");
    const grant = await tx.administratorGrant.create({
      data: {
        userId: input.userId,
        plan: input.plan as Plan,
        reason: input.reason.trim(),
        startsAt,
        expiresAt: input.permanent ? null : input.expiresAt,
        permanent: input.permanent,
        grantedById: input.grantedById,
      },
    });
    await tx.user.update({
      where: { id: input.userId },
      data: {
        plan: input.plan,
        // Do not overwrite planExpiresAt/trialEndsAt: they belong to a payment
        // term or Conversion Trial. The grant's own expiry is authoritative.
        ...usageWindowForPlan(input.plan, startsAt),
      },
    });
    return grant;
  });
}

export async function revokeAdministratorGrants(
  input: { userId: string; revokedById: string; reason: string },
  now: Date = new Date(),
): Promise<number> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AdministratorGrantInputError("กรุณาระบุเหตุผลการยกเลิก 3–500 ตัวอักษร");
  }
  const result = await prisma.administratorGrant.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      startsAt: { lte: now },
      OR: [{ permanent: true }, { expiresAt: { gt: now } }],
    },
    data: { revokedAt: now, revokedById: input.revokedById, revokeReason: reason },
  });
  return result.count;
}

export type AdministratorGrantTransaction = Prisma.TransactionClient;
