import { headers } from "next/headers";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncUserEntitlement } from "@/lib/entitlements";

export const SERVICE_SECRET_HEADER = "x-heroai-service-secret";
export const SERVICE_ACTAS_HEADER = "x-heroai-act-as";

/** Pure: is this (envSecret, headerSecret, actAsUserId) a valid internal service credential? */
export function isValidServiceCredential(
  envSecret: string | undefined,
  headerSecret: string | null,
  actAsUserId: string | null,
): boolean {
  if (!envSecret) return false; // feature off unless env set
  if (!headerSecret || headerSecret !== envSecret) return false;
  if (!actAsUserId) return false;
  return true;
}

/** The acted-as User if the request carries a valid internal service credential, else null. */
export async function resolveServiceActor(): Promise<User | null> {
  if (!process.env.MCP_SERVICE_SECRET) return null; // fast off-switch
  const h = await headers();
  const headerSecret = h.get(SERVICE_SECRET_HEADER);
  const actAs = h.get(SERVICE_ACTAS_HEADER);
  if (!isValidServiceCredential(process.env.MCP_SERVICE_SECRET, headerSecret, actAs)) return null;
  const user = await prisma.user.findUnique({ where: { id: actAs! } });
  if (!user) return null;
  await syncUserEntitlement(user.id).catch(() => {});
  return prisma.user.findUnique({ where: { id: user.id } });
}
