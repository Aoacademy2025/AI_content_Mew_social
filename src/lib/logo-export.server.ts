import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  BrandAssetError,
  canUseLogoOverlay,
  getBrandAssetPath,
} from "@/lib/brand-assets.server";
import { assertEditorProjectOwner } from "@/lib/editor-projects";
import {
  LOGO_POSITIONS,
  normalizeLogoOverlayConfig,
  type LogoPosition,
} from "@/lib/logo-overlay";

export type ClientLogoExportInput = {
  enabled: true;
  assetId: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
};

export type TrustedLogoRenderInput = {
  src: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
};

type LogoExportStagingInput = {
  userId: string;
  plan: string;
  projectId: string;
  rawLogoOverlay: unknown;
  rendersRoot?: string;
};

function parseClientLogoExportInput(value: unknown): ClientLogoExportInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.enabled !== true
    || typeof candidate.assetId !== "string"
    || !candidate.assetId.trim()
    || typeof candidate.position !== "string"
    || !LOGO_POSITIONS.some((position) => position === candidate.position)
    || typeof candidate.sizePct !== "number"
    || !Number.isFinite(candidate.sizePct)
    || typeof candidate.opacity !== "number"
    || !Number.isFinite(candidate.opacity)
  ) {
    return null;
  }

  const normalized = normalizeLogoOverlayConfig(candidate);
  if (!normalized) return null;
  return { ...normalized, enabled: true };
}

function exportError(
  code: "plan_required" | "project_not_found" | "asset_not_found",
  status: number,
  message: string,
): BrandAssetError {
  const error = new BrandAssetError(code, status);
  error.message = message;
  return error;
}

export async function stageLogoForExport(
  input: LogoExportStagingInput,
): Promise<{ trusted: TrustedLogoRenderInput; snapshotPath: string } | null> {
  const logo = parseClientLogoExportInput(input.rawLogoOverlay);
  if (!logo) return null;

  if (!canUseLogoOverlay(input.plan)) {
    throw exportError(
      "plan_required",
      403,
      "ฟีเจอร์โลโก้แบรนด์ใช้ได้เฉพาะแผน Pro หรือ Business",
    );
  }
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw exportError("project_not_found", 404, "ไม่พบโปรเจกต์");
  }
  try {
    await assertEditorProjectOwner(input.userId, projectId);
  } catch (error) {
    if ((error as { code?: string }).code === "project_not_found") {
      throw exportError("project_not_found", 404, "ไม่พบโปรเจกต์");
    }
    throw error;
  }

  const sourcePath = await getBrandAssetPath(input.userId, logo.assetId);
  if (!sourcePath) {
    throw exportError("asset_not_found", 404, "ไม่พบโลโก้แบรนด์");
  }

  const filename = `logo-snapshot-${randomUUID()}.webp`;
  const root = path.resolve(input.rendersRoot ?? path.join(process.cwd(), "public", "renders"));
  const snapshotPath = path.join(root, filename);
  let copied = false;
  try {
    await mkdir(root, { recursive: true });
    await copyFile(sourcePath, snapshotPath, constants.COPYFILE_EXCL);
    copied = true;
    const metadata = await sharp(snapshotPath, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) {
      throw exportError(
        "asset_not_found",
        404,
        "ไฟล์โลโก้ไม่พร้อมใช้งาน กรุณาอัปโหลดใหม่",
      );
    }
    return {
      trusted: {
        src: `/api/renders/${filename}`,
        position: logo.position,
        sizePct: logo.sizePct,
        opacity: logo.opacity,
        intrinsicWidth: metadata.width,
        intrinsicHeight: metadata.height,
      },
      snapshotPath,
    };
  } catch (error) {
    if (copied) await removeLogoSnapshot(snapshotPath);
    if (error instanceof BrandAssetError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw exportError(
        "asset_not_found",
        404,
        "ไฟล์โลโก้ไม่พร้อมใช้งาน กรุณาอัปโหลดใหม่",
      );
    }
    throw error;
  }
}

export async function removeLogoSnapshot(snapshotPath: string): Promise<void> {
  try {
    await unlink(snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createDurableExportWithStagedLogo<Job>(input: {
  staging: LogoExportStagingInput;
  createDurableJob: (trustedLogo: TrustedLogoRenderInput | null) => Promise<Job>;
  afterDurableJobCreated?: (job: Job) => Promise<void>;
}): Promise<Job> {
  let snapshotPath: string | null = null;
  let jobIsDurable = false;
  try {
    const stagedLogo = await stageLogoForExport(input.staging);
    snapshotPath = stagedLogo?.snapshotPath ?? null;
    const job = await input.createDurableJob(stagedLogo?.trusted ?? null);
    jobIsDurable = true;
    await input.afterDurableJobCreated?.(job);
    return job;
  } catch (error) {
    if (!jobIsDurable && snapshotPath) {
      await removeLogoSnapshot(snapshotPath);
    }
    throw error;
  }
}
