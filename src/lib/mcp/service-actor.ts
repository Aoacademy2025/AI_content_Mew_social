import { timingSafeEqual } from "crypto";
import { headers } from "next/headers";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncUserEntitlement } from "@/lib/entitlements";

export const SERVICE_SECRET_HEADER = "x-heroai-service-secret";
export const SERVICE_ACTAS_HEADER = "x-heroai-act-as";

/** Constant-time string equality — never leak the secret via comparison timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pure: is this (envSecret, headerSecret, actAsUserId) a valid internal service credential? */
export function isValidServiceCredential(
  envSecret: string | undefined,
  headerSecret: string | null,
  actAsUserId: string | null,
): boolean {
  if (!envSecret) return false; // feature off unless env set
  if (!headerSecret || !safeEqual(headerSecret, envSecret)) return false;
  if (!actAsUserId) return false;
  return true;
}

/**
 * Does THIS request carry a valid internal service credential (i.e. did it originate
 * from the server-side render pipeline)? Header-only — no DB round-trip — so callers
 * can use it as a cheap provenance gate. A browser can never satisfy it: the secret
 * is a server-only env value that is never shipped to the client.
 *
 * Narrower than resolveServiceActor by design: it answers "is the CALLER the pipeline?",
 * not "which user is it acting as?", and deliberately does not verify that the acted-as
 * row exists. Use it alongside getCurrentUser (which already resolved and returned that
 * user), never as a substitute for it.
 */
export async function isServiceActorRequest(): Promise<boolean> {
  if (!process.env.MCP_SERVICE_SECRET) return false; // fast off-switch (same as resolveServiceActor)
  const h = await headers();
  return isValidServiceCredential(
    process.env.MCP_SERVICE_SECRET,
    h.get(SERVICE_SECRET_HEADER),
    h.get(SERVICE_ACTAS_HEADER),
  );
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
