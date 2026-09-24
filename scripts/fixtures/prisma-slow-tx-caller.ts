import { getBalance } from "../../src/lib/credits";
import { prisma } from "../../src/lib/prisma";

export async function readBalance(userId: string) {
  return getBalance(userId, new Date("2026-09-23T00:00:00.000Z"));
}

export async function runSlowCallback<T>(delayMs: number, result: T): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.user.count();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return result;
  });
}
