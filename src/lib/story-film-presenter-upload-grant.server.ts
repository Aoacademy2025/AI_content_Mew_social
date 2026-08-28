import "server-only";

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { prisma } from "@/lib/prisma";
import { StoryFilmError } from "@/lib/story-film.server";

const MAX_BYTES = 500 * 1024 * 1024;
const GRANT_LIFETIME_MS = 10 * 60 * 1_000;
const MIME_BY_EXTENSION = new Map([
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
]);

function invalid(message: string): never {
  throw new StoryFilmError("invalid_input", message);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanPresenterUpload(input: {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const originalName = input.originalName.normalize("NFC").trim();
  if (!originalName || originalName.length > 255 || path.basename(originalName) !== originalName) {
    invalid("ชื่อไฟล์ Presenter ไม่ถูกต้อง");
  }
  const extension = originalName.split(".").pop()?.toLowerCase() ?? "";
  const expectedMime = MIME_BY_EXTENSION.get(extension);
  if (!expectedMime || input.mimeType !== expectedMime) {
    invalid("รองรับเฉพาะ mp4, mov และ webm");
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_BYTES) {
    invalid("ไฟล์ Presenter ต้องมีขนาดไม่เกิน 500 MB");
  }
  return { originalName, mimeType: expectedMime, sizeBytes: input.sizeBytes };
}

export async function createStoryFilmPresenterUploadGrant(
  userId: string,
  input: { originalName: string; mimeType: string; sizeBytes: number },
) {
  const cleaned = cleanPresenterUpload(input);
  const uploadToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + GRANT_LIFETIME_MS);
  const grant = await prisma.storyFilmPresenterUploadGrant.create({
    data: {
      userId,
      tokenHash: tokenHash(uploadToken),
      originalName: cleaned.originalName,
      mimeType: cleaned.mimeType,
      sizeBytes: cleaned.sizeBytes,
      expiresAt,
    },
  });
  return { grantId: grant.id, uploadToken, expiresAt };
}

export async function claimStoryFilmPresenterUploadGrant(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,120})$/u.exec(authorization);
  if (!match) return null;

  const now = new Date();
  const grant = await prisma.storyFilmPresenterUploadGrant.findFirst({
    where: {
      tokenHash: tokenHash(match[1]),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
  if (!grant || !isInternalAiTester(grant.user)) return null;

  const claimed = await prisma.storyFilmPresenterUploadGrant.updateMany({
    where: {
      id: grant.id,
      tokenHash: grant.tokenHash,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  return claimed.count === 1 ? grant : null;
}

export async function completeStoryFilmPresenterUploadGrant(
  grantId: string,
  presenterAssetId: string,
) {
  const completed = await prisma.storyFilmPresenterUploadGrant.updateMany({
    where: { id: grantId, consumedAt: { not: null }, presenterAssetId: null },
    data: { presenterAssetId },
  });
  if (completed.count !== 1) {
    throw new Error("Presenter upload grant completion conflict");
  }
}
