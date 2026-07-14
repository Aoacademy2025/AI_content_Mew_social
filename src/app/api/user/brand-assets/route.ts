import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  BrandAssetError,
  canUseLogoOverlay,
  getDefaultBrandPreference,
  saveBrandAsset,
} from "@/lib/brand-assets.server";
import { getCurrentUser } from "@/lib/clerk-auth";
import type { BrandAssetView } from "@/lib/logo-overlay";

export type BrandAssetActor = {
  id: string;
  plan: string;
};

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

const BRAND_ASSET_ERRORS: Record<BrandAssetError["code"], Omit<BrandAssetErrorMapping, "body"> & { message: string }> = {
  plan_required: {
    status: 403,
    message: "ฟีเจอร์โลโก้แบรนด์ใช้ได้เฉพาะแผน Pro หรือ Business",
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

function brandAssetErrorResponse(error: unknown): NextResponse | null {
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

export async function getBrandAssetCollection(
  user: BrandAssetActor,
): Promise<NextResponse> {
  const defaultLogo = await getDefaultBrandPreference(user.id);
  return NextResponse.json({
    eligible: canUseLogoOverlay(user.plan),
    defaultLogo: defaultLogo
      ? { ...defaultLogo, asset: publicAsset(defaultLogo.asset) }
      : null,
  });
}

export async function postBrandAsset(
  user: BrandAssetActor,
  request: Request,
): Promise<NextResponse> {
  if (!canUseLogoOverlay(user.plan)) {
    return brandAssetErrorResponse(
      new BrandAssetError("plan_required", 403),
    )!;
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return brandAssetErrorResponse(
      new BrandAssetError("payload_too_large", 413),
    )!;
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
  if (!(file instanceof File) || !projectId) return invalidBodyResponse();

  try {
    const asset = await saveBrandAsset({
      userId: user.id,
      plan: user.plan,
      projectId,
      file,
    });
    return NextResponse.json({ asset: publicAsset(asset) }, { status: 201 });
  } catch (error) {
    const response = brandAssetErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return getBrandAssetCollection(user);
  } catch {
    return apiError({
      route: "user/brand-assets",
      error: "Brand asset request failed",
    });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return await postBrandAsset(user, request);
  } catch {
    return apiError({
      route: "user/brand-assets",
      error: "Brand asset request failed",
    });
  }
}
