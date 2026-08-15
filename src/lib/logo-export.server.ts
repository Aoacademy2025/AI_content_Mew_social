import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  BrandAssetError,
  canManageBrandMark,
  getBrandAssetPath,
} from "@/lib/brand-assets.server";
import { assertEditorProjectOwner } from "@/lib/editor-projects";
import {
  LOGO_POSITIONS,
  MAX_LOGO_OPACITY,
  MAX_LOGO_SIZE_PCT,
  MIN_LOGO_OPACITY,
  MIN_LOGO_SIZE_PCT,
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

const TRUSTED_LOGO_SNAPSHOT_SRC =
  /^\/api\/renders\/logo-snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

export function normalizeTrustedLogoRenderInput(
  value: unknown,
): TrustedLogoRenderInput | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.src !== "string"
    || !TRUSTED_LOGO_SNAPSHOT_SRC.test(candidate.src)
    || typeof candidate.position !== "string"
    || !LOGO_POSITIONS.some((position) => position === candidate.position)
    || typeof candidate.sizePct !== "number"
    || !Number.isFinite(candidate.sizePct)
    || candidate.sizePct < MIN_LOGO_SIZE_PCT
    || candidate.sizePct > MAX_LOGO_SIZE_PCT
    || typeof candidate.opacity !== "number"
    || !Number.isFinite(candidate.opacity)
    || candidate.opacity < MIN_LOGO_OPACITY
    || candidate.opacity > MAX_LOGO_OPACITY
    || typeof candidate.intrinsicWidth !== "number"
    || !Number.isInteger(candidate.intrinsicWidth)
    || candidate.intrinsicWidth <= 0
    || typeof candidate.intrinsicHeight !== "number"
    || !Number.isInteger(candidate.intrinsicHeight)
    || candidate.intrinsicHeight <= 0
  ) {
    return null;
  }

  return {
    src: candidate.src,
    position: candidate.position as LogoPosition,
    sizePct: candidate.sizePct,
    opacity: candidate.opacity,
    intrinsicWidth: candidate.intrinsicWidth,
    intrinsicHeight: candidate.intrinsicHeight,
  };
}

type LogoExportStagingInput = {
  userId: string;
  plan: string;
  brandVisualAllowed?: boolean;
  projectId: string;
  rawLogoOverlay: unknown;
  rendersRoot?: string;
};

type ParsedClientLogoExportInput =
  | { kind: "absent" }
  | { kind: "invalid-enabled" }
  | { kind: "valid"; logo: ClientLogoExportInput };

function parseClientLogoExportInput(value: unknown): ParsedClientLogoExportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "absent" };
  const candidate = value as Record<string, unknown>;
  if (candidate.enabled !== true) return { kind: "absent" };
  if (
    typeof candidate.assetId !== "string"
    || !candidate.assetId.trim()
    || typeof candidate.position !== "string"
    || !LOGO_POSITIONS.some((position) => position === candidate.position)
    || typeof candidate.sizePct !== "number"
    || !Number.isFinite(candidate.sizePct)
    || typeof candidate.opacity !== "number"
    || !Number.isFinite(candidate.opacity)
  ) {
    return { kind: "invalid-enabled" };
  }

  const normalized = normalizeLogoOverlayConfig(candidate);
  if (!normalized) return { kind: "invalid-enabled" };
  return { kind: "valid", logo: { ...normalized, enabled: true } };
}

function exportError(
  code: "plan_required" | "project_not_found" | "asset_not_found" | "invalid_config",
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
  const parsedLogo = parseClientLogoExportInput(input.rawLogoOverlay);
  if (parsedLogo.kind === "absent") return null;

  if (!canManageBrandMark(input.plan, input.brandVisualAllowed)) {
    throw exportError(
      "plan_required",
      403,
      "บัญชีนี้ยังไม่สามารถใช้โลโก้หรือลายน้ำของแบรนด์ได้",
    );
  }
  if (parsedLogo.kind === "invalid-enabled") {
    throw exportError(
      "invalid_config",
      400,
      "ข้อมูลโลโก้สำหรับส่งออกไม่ถูกต้อง",
    );
  }
  const logo = parsedLogo.logo;
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
