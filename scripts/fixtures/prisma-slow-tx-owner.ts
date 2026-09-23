import { getBalance } from "../../src/lib/credits";

export async function readBalance(userId: string) {
  return getBalance(userId, new Date("2026-09-23T00:00:00.000Z"));
}
