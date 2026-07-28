import { NextResponse } from "next/server";
import { serveMediaGet, serveMediaHead } from "@/lib/media-serving";
import { runtimeMediaStorage } from "@/lib/media-storage-rollout";

export const runtime = "nodejs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

function options(filename: string) {
  return {
    area: "stocks" as const,
    filename,
    storage: runtimeMediaStorage(),
    cors,
    cacheControl: "public, max-age=86400",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function HEAD(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  return serveMediaHead(options(filename));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  return serveMediaGet(request, options(filename));
}
