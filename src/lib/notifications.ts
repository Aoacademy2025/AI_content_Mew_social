import { prisma } from "@/lib/prisma";
import { isSafeNotificationLink } from "@/lib/notification-link";

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
  link,
}: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Optional in-app destination. Same-origin path only — see isSafeNotificationLink. */
  link?: string | null;
}) {
  return prisma.notification.create({
    data: { userId, type, title, body, link: isSafeNotificationLink(link) ? link : null },
  });
}

export { isSafeNotificationLink };

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
    data: admins.map((a: { id: string }) => ({ userId: a.id, type, title, body })),
  });
}
