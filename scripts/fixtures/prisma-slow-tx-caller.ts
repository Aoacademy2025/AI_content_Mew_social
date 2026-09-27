import { prisma } from "../../src/lib/prisma";

export async function materializeWallet(userId: string) {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.creditBalance.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return { total: wallet.granted + wallet.purchased };
  });
}

export async function runSlowCallback<T>(delayMs: number, result: T): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.user.count();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return result;
  });
}
