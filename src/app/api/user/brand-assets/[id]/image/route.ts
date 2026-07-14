import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  BrandAssetError,
  getBrandAssetPath,
} from "@/lib/brand-assets.server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  mapBrandAssetError,
  type BrandAssetActor,
} from "../../route";

function notFoundResponse(): NextResponse {
  const mapped = mapBrandAssetError(new BrandAssetError("asset_not_found", 404))!;
  return NextResponse.json(mapped.body, { status: mapped.status });
}

export async function getBrandAssetImage(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!assetId.trim()) {
    const mapped = mapBrandAssetError(new BrandAssetError("invalid_config", 400))!;
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  const filePath = await getBrandAssetPath(user.id, assetId);
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    return await getBrandAssetImage(user, id);
  } catch {
    return apiError({
      route: "user/brand-assets/[id]/image",
      error: "Brand asset image request failed",
    });
  }
}
