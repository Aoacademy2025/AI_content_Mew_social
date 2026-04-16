import { prisma } from "@/lib/prisma";

type NotificationType =
  | "VIDEO_COMPLETED"
  | "VIDEO_FAILED"
  | "LIMIT_WARNING"
  | "LIMIT_REACHED"
  | "NEW_USER"
  | "ERROR_SYSTEM";

export async function createNotification({
  userId,
  type,
  title,
  body,
}: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
}) {
  return prisma.notification.create({
    data: { userId, type, title, body },
  });
}

// Notify all admins (for NEW_USER type)
export async function notifyAdmins({
  type,
  title,
  body,
}: {
  type: NotificationType;
  title: string;
  body: string;
}) {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  await prisma.notification.createMany({
    data: admins.map((a) => ({ userId: a.id, type, title, body })),
  });
}
