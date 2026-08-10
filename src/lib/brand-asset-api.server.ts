import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import {
  BrandAssetError,
  canManageBrandMark,
  deleteBrandAssetIfUnreferenced,
  getDefaultBrandPreference,
  getOwnedRecoverableBrandAsset,
  getRecoverableBrandAssetPath,
  saveBrandAsset,
  setDefaultBrandPreference,
} from "@/lib/brand-assets.server";
import type { User } from "@prisma/client";
import { decideBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import {
  normalizeLogoOverlayConfig,
  type BrandAssetView,
} from "@/lib/logo-overlay";

export type BrandAssetActor = {
  id: string;
  plan: string;
  brandVisualAllowed?: boolean;
};

export function brandAssetActorForUser(user: User): BrandAssetActor {
  return {
    id: user.id,
    plan: user.plan,
    brandVisualAllowed: decideBrandVisualAccess(user).canUse,
  };
}

function actorCanManageBrandMark(user: BrandAssetActor): boolean {
  return canManageBrandMark(user.plan, user.brandVisualAllowed === true);
}

type BrandAssetErrorBody = {
  error: BrandAssetError["code"];
  message: string;
};

type BrandAssetErrorMapping = {
  status: number;
  body: BrandAssetErrorBody;
};

const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = 5 * 1024 * 1024 + MAX_MULTIPART_OVERHEAD_BYTES;
const PATCH_KEYS = new Set([
  "setAsDefault",
  "enabled",
  "position",
  "sizePct",
  "opacity",
]);

const BRAND_ASSET_ERRORS: Record<BrandAssetError["code"], Omit<BrandAssetErrorMapping, "body"> & { message: string }> = {
  plan_required: {
    status: 403,
    message: "บัญชีนี้ยังไม่สามารถจัดการโลโก้หรือลายน้ำของแบรนด์ได้",
  },
  project_not_found: { status: 404, message: "ไม่พบโปรเจกต์" },
  unsupported_type: {
    status: 415,
    message: "รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP",
  },
  payload_too_large: { status: 413, message: "ไฟล์ใหญ่เกิน 5 MB" },
  empty_file: { status: 400, message: "ไฟล์ว่างหรืออ่านไม่ได้" },
  corrupt_image: {
    status: 422,
    message: "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้",
  },
  dimensions_too_large: {
    status: 422,
    message: "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)",
  },
  asset_not_found: { status: 404, message: "ไม่พบโลโก้แบรนด์" },
  asset_in_use: { status: 409, message: "โลโก้นี้กำลังถูกใช้งานอยู่" },
  invalid_config: { status: 400, message: "การตั้งค่าโลโก้ไม่ถูกต้อง" },
  rate_limited: {
    status: 429,
    message: "อัปโหลดมากเกินไปในชั่วโมงนี้ กรุณาลองใหม่ภายหลัง",
  },
};

export function mapBrandAssetError(error: unknown): BrandAssetErrorMapping | null {
  if (!(error instanceof BrandAssetError)) return null;
  const mapped = BRAND_ASSET_ERRORS[error.code];
  return {
    status: mapped.status,
    body: { error: error.code, message: mapped.message },
  };
}

function mappedErrorResponse(error: unknown): NextResponse | null {
  const mapped = mapBrandAssetError(error);
  return mapped ? NextResponse.json(mapped.body, { status: mapped.status }) : null;
}

function publicAsset(asset: BrandAssetView): BrandAssetView {
  return {
    ...asset,
    imageUrl: `/api/user/brand-assets/${encodeURIComponent(asset.id)}/image`,
  };
}

function invalidBodyResponse(): NextResponse {
  return NextResponse.json(
    { error: "invalid_body", message: "ข้อมูลคำขอไม่ถูกต้อง" },
    { status: 400 },
  );
}

function invalidConfigResponse(): NextResponse {
  return mappedErrorResponse(new BrandAssetError("invalid_config", 400))!;
}

function notFoundResponse(): NextResponse {
  return mappedErrorResponse(new BrandAssetError("asset_not_found", 404))!;
}

export async function getBrandAssetCollection(
  user: BrandAssetActor,
): Promise<NextResponse> {
  const defaultLogo = await getDefaultBrandPreference(user.id);
  return NextResponse.json({
    eligible: actorCanManageBrandMark(user),
    defaultLogo: defaultLogo
      ? { ...defaultLogo, asset: publicAsset(defaultLogo.asset) }
      : null,
  });
}

export async function postBrandAsset(
  user: BrandAssetActor,
  request: Request,
): Promise<NextResponse> {
  if (!actorCanManageBrandMark(user)) {
    return mappedErrorResponse(new BrandAssetError("plan_required", 403))!;
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return mappedErrorResponse(new BrandAssetError("payload_too_large", 413))!;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return invalidBodyResponse();
  }

  const file = form.get("file");
  const projectIdValue = form.get("projectId");
  const projectId = typeof projectIdValue === "string" ? projectIdValue.trim() : "";
  if (!(file instanceof File)) return invalidBodyResponse();

  try {
    const asset = await saveBrandAsset({
      userId: user.id,
      plan: user.plan,
      brandVisualAllowed: user.brandVisualAllowed,
      projectId: projectId || null,
      file,
    });
    return NextResponse.json({ asset: publicAsset(asset) }, { status: 201 });
  } catch (error) {
    const response = mappedErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function getBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!assetId.trim()) return invalidConfigResponse();
  const asset = await getOwnedRecoverableBrandAsset(user.id, assetId);
  if (!asset) return notFoundResponse();
  return NextResponse.json({ asset: publicAsset(asset) });
}

export async function patchBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
  request: Request,
): Promise<NextResponse> {
  if (!actorCanManageBrandMark(user)) {
    return mappedErrorResponse(new BrandAssetError("plan_required", 403))!;
  }
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) return invalidConfigResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidBodyResponse();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidBodyResponse();
  }

  const candidate = body as Record<string, unknown>;
  if (
    candidate.setAsDefault !== true
    || Object.keys(candidate).some((key) => !PATCH_KEYS.has(key))
  ) {
    return invalidConfigResponse();
  }

  const config = normalizeLogoOverlayConfig({
    assetId: normalizedAssetId,
    enabled: candidate.enabled,
    position: candidate.position,
    sizePct: candidate.sizePct,
    opacity: candidate.opacity,
  });
  if (!config) return invalidConfigResponse();

  try {
    await setDefaultBrandPreference({
      userId: user.id,
      plan: user.plan,
      brandVisualAllowed: user.brandVisualAllowed,
      assetId: normalizedAssetId,
      config,
    });
    const defaultLogo = await getDefaultBrandPreference(user.id);
    return NextResponse.json({
      ok: true,
      defaultLogo: defaultLogo
        ? { ...defaultLogo, asset: publicAsset(defaultLogo.asset) }
        : null,
    });
  } catch (error) {
    const response = mappedErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function deleteBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!actorCanManageBrandMark(user)) {
    return mappedErrorResponse(new BrandAssetError("plan_required", 403))!;
  }
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) return invalidConfigResponse();

  try {
    const deleted = await deleteBrandAssetIfUnreferenced(user.id, normalizedAssetId);
    if (!deleted) return notFoundResponse();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const response = mappedErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function getBrandAssetImage(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!assetId.trim()) return invalidConfigResponse();

  const filePath = await getRecoverableBrandAssetPath(user.id, assetId);
  if (!filePath) return notFoundResponse();

  let file;
  try {
    file = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return notFoundResponse();
    }
    return NextResponse.json(
      { error: "image_unavailable", message: "ไม่สามารถอ่านไฟล์โลโก้ได้" },
      { status: 500 },
    );
  }

  const nodeStream = file.createReadStream();
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
