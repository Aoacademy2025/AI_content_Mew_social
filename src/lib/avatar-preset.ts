import { prisma } from "@/lib/prisma";
import { clampAvatarLayout, type AvatarLayout } from "@/lib/avatar-layout";

/** Layout used when an avatar has no saved preset: avatar fills the green frame, centered. */
export const DEFAULT_AVATAR_LAYOUT: AvatarLayout = Object.freeze({ scale: 1, offsetX: 0, offsetY: 0 });

/**
 * Resolve the avatar composite layout for a job.
 * Each axis is resolved independently: an explicit non-null value wins for that axis,
 * otherwise the saved preset value (or DEFAULT_AVATAR_LAYOUT) is kept. This allows a
 * partial explicit layout (e.g. only scale) to preserve the preset's other axes.
 */
export function resolveAvatarLayout(
  input: { avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number },
  preset: AvatarLayout | null,
): AvatarLayout {
  const base = preset ?? DEFAULT_AVATAR_LAYOUT;
  return {
    scale: input.avatarScale != null ? input.avatarScale : base.scale,
    offsetX: input.avatarOffsetX != null ? input.avatarOffsetX : base.offsetX,
    offsetY: input.avatarOffsetY != null ? input.avatarOffsetY : base.offsetY,
  };
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
