import "server-only";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

/** Deliberately bypasses getCurrentUser: that helper also resolves service actors. */
export async function quoteBrowserOwner(): Promise<string | null> {
  const session = await auth({ acceptsToken: "session_token" });
  if (!session.userId || !session.sessionId) return null;
  const user = await prisma.user.findUnique({ where: { clerkId: session.userId }, select: { id: true, suspended: true } });
  return user && !user.suspended ? user.id : null;
}
