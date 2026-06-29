import { prisma } from "@/lib/prisma";
import { clampAvatarLayout, type AvatarLayout } from "@/lib/avatar-layout";

/** Layout used when an avatar has no saved preset: avatar fills the green frame, centered. */
export const DEFAULT_AVATAR_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

export async function getAvatarPreset(userId: string, avatarId: string): Promise<AvatarLayout | null> {
  if (!avatarId) return null;
  const row = await prisma.avatarPreset.findUnique({ where: { userId_avatarId: { userId, avatarId } } });
  return row ? { scale: row.scale, offsetX: row.offsetX, offsetY: row.offsetY } : null;
}

export async function saveAvatarPreset(userId: string, avatarId: string, raw: unknown): Promise<AvatarLayout> {
  const layout = clampAvatarLayout(raw) ?? DEFAULT_AVATAR_LAYOUT;
  await prisma.avatarPreset.upsert({
    where: { userId_avatarId: { userId, avatarId } },
    create: { userId, avatarId, ...layout },
    update: { ...layout },
  });
  return layout;
}
