import { prisma } from "@/lib/prisma";
import { clampAvatarLayout, type AvatarLayout } from "@/lib/avatar-layout";

/** Layout used when an avatar has no saved preset: avatar fills the green frame, centered. */
export const DEFAULT_AVATAR_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * Resolve the avatar composite layout for a job.
 * If the caller supplied ANY of avatarScale/avatarOffsetX/avatarOffsetY (non-null), those win
 * (missing fields fall back to 1/0/0). Otherwise use the saved preset, or DEFAULT_AVATAR_LAYOUT.
 */
export function resolveAvatarLayout(
  input: { avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number },
  preset: AvatarLayout | null,
): AvatarLayout {
  if (input.avatarScale != null || input.avatarOffsetX != null || input.avatarOffsetY != null) {
    return { scale: input.avatarScale ?? 1, offsetX: input.avatarOffsetX ?? 0, offsetY: input.avatarOffsetY ?? 0 };
  }
  return preset ?? DEFAULT_AVATAR_LAYOUT;
}

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
