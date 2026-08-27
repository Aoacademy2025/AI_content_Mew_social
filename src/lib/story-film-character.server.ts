import "server-only";

import { prisma } from "@/lib/prisma";
import { StoryFilmError } from "@/lib/story-film.server";

export type StoryFilmCharacterReferenceView = {
  id: string;
  url: string;
  setVersion: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  viewLabel: string | null;
};

export type StoryFilmCharacterProfileView = {
  id: string;
  name: string;
  identityNotes: string | null;
  activeReferenceSetVersion: number;
  references: StoryFilmCharacterReferenceView[];
  createdAt: string;
  updatedAt: string;
};

export function storyFilmCharacterReferenceUrl(referenceId: string) {
  return `/api/internal/story-film-media/character-references/${encodeURIComponent(referenceId)}`;
}

function toView(profile: {
  id: string;
  name: string;
  identityNotes: string | null;
  activeReferenceSetVersion: number;
  createdAt: Date;
  updatedAt: Date;
  references: Array<{
    id: string;
    storageUrl: string;
    setVersion: number;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    viewLabel: string | null;
  }>;
}): StoryFilmCharacterProfileView {
  return {
    id: profile.id,
    name: profile.name,
    identityNotes: profile.identityNotes,
    activeReferenceSetVersion: profile.activeReferenceSetVersion,
    references: profile.references
      .filter((reference) => reference.setVersion === profile.activeReferenceSetVersion)
      .map((reference) => ({
        id: reference.id,
        url: storyFilmCharacterReferenceUrl(reference.id),
        setVersion: reference.setVersion,
        originalName: reference.originalName,
        mimeType: reference.mimeType,
        sizeBytes: reference.sizeBytes,
        width: reference.width,
        height: reference.height,
        viewLabel: reference.viewLabel,
      })),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function createStoryFilmCharacterProfile(
  userId: string,
  input: { name: string; identityNotes?: string | null },
): Promise<StoryFilmCharacterProfileView> {
  const name = input.name.replace(/\s+/g, " ").trim();
  const identityNotes = input.identityNotes?.trim() || null;
  if (!name || name.length > 100) throw new StoryFilmError("invalid_input", "ชื่อตัวละครต้องยาว 1–100 ตัวอักษร");
  if (identityNotes && identityNotes.length > 1_000) throw new StoryFilmError("invalid_input", "Identity Notes ยาวเกิน 1,000 ตัวอักษร");
  const profile = await prisma.storyFilmCharacterProfile.create({
    data: { userId, name, identityNotes },
    include: { references: true },
  });
  return toView(profile);
}

export async function listStoryFilmCharacterProfiles(userId: string): Promise<StoryFilmCharacterProfileView[]> {
  const profiles = await prisma.storyFilmCharacterProfile.findMany({
    where: { userId },
    include: { references: { orderBy: { createdAt: "asc" } } },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return profiles.map(toView);
}

export async function registerStoryFilmCharacterReference(
  userId: string,
  profileId: string,
  input: Omit<StoryFilmCharacterReferenceView, "id" | "setVersion">,
): Promise<StoryFilmCharacterReferenceView> {
  if (!input.url || input.url.length > 2_000) throw new StoryFilmError("invalid_input", "Character Reference URL ไม่ถูกต้อง");
  if (!input.originalName || input.originalName.length > 255) throw new StoryFilmError("invalid_input", "ชื่อไฟล์ Character Reference ไม่ถูกต้อง");
  if (!input.mimeType.startsWith("image/") || input.mimeType.length > 120) throw new StoryFilmError("invalid_input", "Character Reference ต้องเป็นรูปภาพ");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > 25 * 1024 * 1024) {
    throw new StoryFilmError("invalid_input", "Character Reference ต้องมีขนาดไม่เกิน 25 MB");
  }
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 256 || input.height < 256) {
    throw new StoryFilmError("invalid_input", "Character Reference ต้องมีขนาดอย่างน้อย 256×256 px");
  }
  const viewLabel = input.viewLabel?.replace(/\s+/g, " ").trim() || null;
  if (viewLabel && viewLabel.length > 80) throw new StoryFilmError("invalid_input", "ป้ายมุมภาพยาวเกิน 80 ตัวอักษร");

  return prisma.$transaction(async (tx) => {
    const profile = await tx.storyFilmCharacterProfile.findFirst({ where: { id: profileId, userId } });
    if (!profile) throw new StoryFilmError("not_found", "ไม่พบ Character Profile");
    const referenceCount = await tx.storyFilmCharacterReference.count({
      where: { profileId: profile.id, setVersion: profile.activeReferenceSetVersion },
    });
    if (referenceCount >= 8) throw new StoryFilmError("invalid_input", "Reference Set หนึ่งชุดเก็บได้ไม่เกิน 8 ภาพ");
    const reference = await tx.storyFilmCharacterReference.create({
      data: {
        profileId: profile.id,
        setVersion: profile.activeReferenceSetVersion,
        storageUrl: input.url,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        viewLabel,
      },
    });
    await tx.storyFilmCharacterProfile.update({ where: { id: profile.id }, data: { updatedAt: new Date() } });
    return {
      id: reference.id,
      url: storyFilmCharacterReferenceUrl(reference.id),
      setVersion: reference.setVersion,
      originalName: reference.originalName,
      mimeType: reference.mimeType,
      sizeBytes: reference.sizeBytes,
      width: reference.width,
      height: reference.height,
      viewLabel: reference.viewLabel,
    };
  });
}

export async function resolveStoryFilmCharacterPin(userId: string, profileId: string) {
  const profile = await prisma.storyFilmCharacterProfile.findFirst({
    where: { id: profileId, userId },
    include: {
      references: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!profile) throw new StoryFilmError("invalid_input", "ไม่พบ Character Profile ของบัญชีนี้");
  const references = profile.references.filter((item) => item.setVersion === profile.activeReferenceSetVersion);
  if (references.length === 0) throw new StoryFilmError("invalid_input", "Character Profile ต้องมี Reference อย่างน้อย 1 ภาพ");
  return { profile, references, referenceSetVersion: profile.activeReferenceSetVersion };
}
