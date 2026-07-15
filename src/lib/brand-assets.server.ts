import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  normalizeLogoOverlayConfig,
  type BrandAssetView,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";
import { prisma } from "@/lib/prisma";

type BrandAssetErrorCode =
  | "plan_required"
  | "project_not_found"
  | "unsupported_type"
  | "payload_too_large"
  | "empty_file"
  | "corrupt_image"
  | "dimensions_too_large"
  | "asset_not_found"
  | "asset_in_use"
  | "invalid_config"
  | "rate_limited";

export class BrandAssetError extends Error {
  code: BrandAssetErrorCode;
  status: number;

  constructor(code: BrandAssetErrorCode, status: number, message = code) {
    super(message);
    this.name = "BrandAssetError";
    this.code = code;
    this.status = status;
  }
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_DIMENSION = 4096;
const MAX_UPLOADS_PER_HOUR = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const uploadWindows = new Map<string, number[]>();
export const BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY = ".account-delete-receipts-v1";

const acceptedFileTypes: Record<string, { mimeType: string; decodedFormat: "jpeg" | "png" | "webp" }> = {
  ".jpg": { mimeType: "image/jpeg", decodedFormat: "jpeg" },
  ".jpeg": { mimeType: "image/jpeg", decodedFormat: "jpeg" },
  ".png": { mimeType: "image/png", decodedFormat: "png" },
  ".webp": { mimeType: "image/webp", decodedFormat: "webp" },
};

type BrandAssetRow = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
};

function brandRoot(): string {
  return path.resolve(process.env.BRAND_ASSET_ROOT || path.join(process.cwd(), "data", "brand-assets"));
}

function resolveBrandAssetPath(storageKey: string): string | null {
  const root = brandRoot();
  const resolved = path.resolve(root, storageKey);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function toBrandAssetView(asset: BrandAssetRow): BrandAssetView {
  return {
    id: asset.id,
    displayName: asset.originalName,
    mimeType: "image/webp",
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    imageUrl: `/api/brand-assets/${encodeURIComponent(asset.id)}`,
  };
}

function cleanDisplayName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 120);
  return cleaned || "logo";
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function draftReferencesAsset(draftJson: string | null, assetId: string): boolean {
  if (!draftJson) return false;
  try {
    const draft = JSON.parse(draftJson) as unknown;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false;
    const logoOverlay = (draft as Record<string, unknown>).logoOverlay;
    return Boolean(
      logoOverlay
      && typeof logoOverlay === "object"
      && !Array.isArray(logoOverlay)
      && (logoOverlay as Record<string, unknown>).assetId === assetId,
    );
  } catch {
    return false;
  }
}

export function canUseLogoOverlay(plan: string): boolean {
  return plan === "PRO" || plan === "BUSINESS";
}

export function tryConsumeBrandAssetUpload(userId: string, now = Date.now()): boolean {
  const windowStart = now - UPLOAD_WINDOW_MS;
  const recent = (uploadWindows.get(userId) || []).filter((timestamp) => timestamp > windowStart);
  if (recent.length >= MAX_UPLOADS_PER_HOUR) {
    uploadWindows.set(userId, recent);
    return false;
  }
  recent.push(now);
  uploadWindows.set(userId, recent);
  return true;
}

export async function saveBrandAsset(input: {
  userId: string;
  plan: string;
  projectId: string;
  file: File;
}): Promise<BrandAssetView> {
  if (!canUseLogoOverlay(input.plan)) {
    throw new BrandAssetError("plan_required", 403);
  }

  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId, status: { not: "archived" } },
    select: { id: true },
  });
  if (!project) throw new BrandAssetError("project_not_found", 404);

  if (!tryConsumeBrandAssetUpload(input.userId)) {
    throw new BrandAssetError("rate_limited", 429);
  }

  const extension = path.extname(input.file.name).toLowerCase();
  const expectedType = acceptedFileTypes[extension];
  if (!expectedType || input.file.type.toLowerCase() !== expectedType.mimeType) {
    throw new BrandAssetError("unsupported_type", 415);
  }
  if (input.file.size <= 0) throw new BrandAssetError("empty_file", 400);
  if (input.file.size > MAX_UPLOAD_BYTES) {
    throw new BrandAssetError("payload_too_large", 413);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await input.file.arrayBuffer());
  } catch {
    throw new BrandAssetError("corrupt_image", 400);
  }
  if (bytes.length === 0) throw new BrandAssetError("empty_file", 400);

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    throw new BrandAssetError("corrupt_image", 400);
  }
  if (metadata.format !== expectedType.decodedFormat) {
    throw new BrandAssetError("unsupported_type", 415);
  }
  if (!metadata.width || !metadata.height) {
    throw new BrandAssetError("corrupt_image", 400);
  }
  if (metadata.width > MAX_INPUT_DIMENSION || metadata.height > MAX_INPUT_DIMENSION) {
    throw new BrandAssetError("dimensions_too_large", 400);
  }

  let normalized: { data: Buffer; info: sharp.OutputInfo };
  try {
    normalized = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .webp({ lossless: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new BrandAssetError("corrupt_image", 400);
  }

  const storageKey = `${input.userId}/${randomUUID()}.webp`;
  const finalPath = resolveBrandAssetPath(storageKey);
  if (!finalPath) throw new BrandAssetError("invalid_config", 400);
  const directory = path.dirname(finalPath);
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, normalized.data, { flag: "wx" });
    await rename(temporaryPath, finalPath);
    const asset = await prisma.brandAsset.create({
      data: {
        userId: input.userId,
        projectId: project.id,
        storageKey,
        originalName: cleanDisplayName(input.file.name),
        mimeType: "image/webp",
        sizeBytes: normalized.data.length,
        width: normalized.info.width,
        height: normalized.info.height,
      },
    });
    return toBrandAssetView(asset);
  } catch (error) {
    await Promise.allSettled([unlinkIfPresent(temporaryPath), unlinkIfPresent(finalPath)]);
    throw error;
  }
}

export async function getOwnedBrandAsset(userId: string, assetId: string): Promise<BrandAssetView | null> {
  const asset = await prisma.brandAsset.findFirst({ where: { id: assetId, userId } });
  return asset ? toBrandAssetView(asset) : null;
}

export async function getBrandAssetPath(userId: string, assetId: string): Promise<string | null> {
  const asset = await prisma.brandAsset.findFirst({
    where: { id: assetId, userId },
    select: { storageKey: true },
  });
  return asset ? resolveBrandAssetPath(asset.storageKey) : null;
}

export async function getDefaultBrandPreference(userId: string): Promise<{
  asset: BrandAssetView;
  config: LogoOverlayConfig;
} | null> {
  const preference = await prisma.brandPreference.findUnique({
    where: { userId },
    include: { defaultAsset: true },
  });
  if (!preference || preference.defaultAsset.userId !== userId) return null;

  const config = normalizeLogoOverlayConfig({
    enabled: preference.enabled,
    assetId: preference.defaultAssetId,
    position: preference.position,
    sizePct: preference.sizePct,
    opacity: preference.opacity,
  });
  if (!config) return null;
  return { asset: toBrandAssetView(preference.defaultAsset), config };
}

export async function setDefaultBrandPreference(input: {
  userId: string;
  plan: string;
  assetId: string;
  config: LogoOverlayConfig;
}): Promise<void> {
  if (!canUseLogoOverlay(input.plan)) {
    throw new BrandAssetError("plan_required", 403);
  }
  const config = normalizeLogoOverlayConfig(input.config);
  if (!config || config.assetId !== input.assetId) {
    throw new BrandAssetError("invalid_config", 400);
  }
  const asset = await prisma.brandAsset.findFirst({
    where: { id: input.assetId, userId: input.userId },
    select: { id: true },
  });
  if (!asset) throw new BrandAssetError("asset_not_found", 404);

  await prisma.brandPreference.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      defaultAssetId: asset.id,
      enabled: config.enabled,
      position: config.position,
      sizePct: config.sizePct,
      opacity: config.opacity,
    },
    update: {
      defaultAssetId: asset.id,
      enabled: config.enabled,
      position: config.position,
      sizePct: config.sizePct,
      opacity: config.opacity,
    },
  });
}

export async function deleteBrandAssetIfUnreferenced(userId: string, assetId: string): Promise<boolean> {
  const storageKey = await prisma.$transaction(async (tx) => {
    const asset = await tx.brandAsset.findFirst({
      where: { id: assetId, userId },
      select: { storageKey: true },
    });
    if (!asset) return null;

    const defaultPreference = await tx.brandPreference.findFirst({
      where: { defaultAssetId: assetId },
      select: { userId: true },
    });
    if (defaultPreference) throw new BrandAssetError("asset_in_use", 409);

    const projects = await tx.editorProject.findMany({
      select: { draftJson: true },
    });
    if (projects.some((project) => draftReferencesAsset(project.draftJson, assetId))) {
      throw new BrandAssetError("asset_in_use", 409);
    }

    const deleted = await tx.brandAsset.deleteMany({ where: { id: assetId, userId } });
    return deleted.count === 1 ? asset.storageKey : null;
  });

  if (!storageKey) return false;
  const filePath = resolveBrandAssetPath(storageKey);
  if (!filePath) throw new BrandAssetError("invalid_config", 400);
  await unlinkIfPresent(filePath);
  return true;
}

export function isSafeBrandAssetUserId(userId: unknown): userId is string {
  return !(
    typeof userId !== "string"
    || userId.length === 0
    || userId.length > 256
    || userId.trim() !== userId
    || userId === "."
    || userId === ".."
    || userId === BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY
    || userId.normalize("NFC") !== userId
    || /[\/\\\u0000-\u001f\u007f]/u.test(userId)
    || path.isAbsolute(userId)
    || path.win32.isAbsolute(userId)
    || path.posix.basename(userId) !== userId
    || path.win32.basename(userId) !== userId
    || path.posix.normalize(userId) !== userId
    || path.win32.normalize(userId) !== userId
  );
}

export async function removeBrandAssetDirectoryForUser(userId: string): Promise<void> {
  const root = brandRoot();
  if (!isSafeBrandAssetUserId(userId)) {
    throw new BrandAssetError("invalid_config", 400);
  }

  const directory = path.resolve(root, userId);
  const relative = path.relative(root, directory);
  if (
    directory === root
    || path.dirname(directory) !== root
    || relative !== userId
    || path.isAbsolute(relative)
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new BrandAssetError("invalid_config", 400);
  }

  await rm(directory, { recursive: true, force: true });
}
