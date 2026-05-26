import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

/**
 * Get the current authenticated user from Prisma (server-side, Clerk-based).
 * - Looks up by clerkId first (fast path)
 * - Falls back to email match (for users migrated from NextAuth)
 * - Auto-creates Prisma row for brand-new Clerk signups
 */
export async function getCurrentUser(): Promise<User | null> {
  const { userId } = await auth();
  if (!userId) return null;

  // Fast path: already linked
  let user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (user) return user;

  // Slow path: match by email (existing NextAuth user)
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  const isAdminEmail = email.endsWith("@aoacademy.co");

  user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    // Link clerkId and upgrade to ADMIN if aoacademy.co domain
    return prisma.user.update({
      where: { id: user.id },
      data: {
        clerkId: userId,
        ...(isAdminEmail && user.role !== "ADMIN" ? { role: "ADMIN" } : {}),
      },
    });
  }

  // New user — create Prisma record
  return prisma.user.create({
    data: {
      clerkId: userId,
      name:
        `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim() ||
        email.split("@")[0],
      email,
      image: clerkUser.imageUrl ?? null,
      ...(isAdminEmail ? { role: "ADMIN" } : {}),
    },
  });
}

/**
 * Like getCurrentUser() but throws 401 if not authenticated.
 * Use inside API route handlers.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
