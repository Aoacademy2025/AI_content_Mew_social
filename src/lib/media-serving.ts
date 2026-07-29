import { NextResponse } from "next/server";
import {
  InvalidMediaIdentityError,
  MediaRangeError,
  type MediaArea,
  type MediaByteRange,
  type MediaIdentity,
  type MediaStorage,
} from "@/lib/media-storage";
import { MediaRemoteUnavailableError } from "@/lib/media-storage-rollout";

type MediaServingOptions = {
  area: MediaArea;
  filename: string;
  storage: MediaStorage;
  cors: Record<string, string>;
  cacheControl: string;
};

function parseByteRange(
  rangeHeader: string,
  total: number,
): MediaByteRange | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  const start = rawStart === "" ? 0 : Number.parseInt(rawStart, 10);
  const end = rawEnd === "" ? total - 1 : Number.parseInt(rawEnd, 10);
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return null;
  }
  return { start, end: Math.min(end, total - 1) };
}

function mediaHeaders(
  contentType: string,
  contentLength: number,
  cacheControl: string,
  cors: Record<string, string>,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": String(contentLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    ...cors,
  };
}

function errorResponse(
  error: unknown,
  options: Pick<MediaServingOptions, "area" | "cors">,
  total?: number,
): NextResponse {
  if (error instanceof InvalidMediaIdentityError) {
    return NextResponse.json(
      { error: "Invalid filename" },
      { status: 400, headers: options.cors },
    );
  }
  if (error instanceof MediaRangeError) {
    return NextResponse.json(
      { error: "Invalid range" },
      {
        status: 416,
        headers: {
          "Content-Range": `bytes */${total ?? error.totalSize}`,
          ...options.cors,
        },
      },
    );
  }
  if (error instanceof MediaRemoteUnavailableError) {
    console.error(`[media-serving] ${options.area} remote unavailable`);
    return NextResponse.json(
      { error: "Media temporarily unavailable" },
      {
        status: 503,
        headers: { "Retry-After": "5", ...options.cors },
      },
    );
  }

  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`[media-serving] ${options.area} read failed: ${name}`);
  return NextResponse.json(
    { error: "Failed to read media" },
    { status: 500, headers: options.cors },
  );
}

function identity(options: MediaServingOptions): MediaIdentity {
  return { area: options.area, filename: options.filename };
}

export async function serveMediaHead(
  options: MediaServingOptions,
): Promise<NextResponse> {
  try {
    const descriptor = await options.storage.stat(identity(options));
    if (!descriptor) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: options.cors },
      );
    }
    return new NextResponse(null, {
      status: 200,
      headers: mediaHeaders(
        descriptor.contentType,
        descriptor.sizeBytes,
        options.cacheControl,
        options.cors,
      ),
    });
  } catch (error) {
    return errorResponse(error, options);
  }
}

export async function serveMediaGet(
  request: Request,
  options: MediaServingOptions,
): Promise<NextResponse> {
  try {
    const mediaIdentity = identity(options);
    const descriptor = await options.storage.stat(mediaIdentity);
    if (!descriptor) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: options.cors },
      );
    }

    const rangeHeader = request.headers.get("range");
    const range = rangeHeader
      ? parseByteRange(rangeHeader, descriptor.sizeBytes)
      : undefined;
    if (range === null) {
      return NextResponse.json(
        { error: "Invalid range" },
        {
          status: 416,
          headers: {
            "Content-Range": `bytes */${descriptor.sizeBytes}`,
            ...options.cors,
          },
        },
      );
    }

    const read = await options.storage.open(mediaIdentity, range);
    if (!read) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: options.cors },
      );
    }

    if (range) {
      return new NextResponse(read.body, {
        status: 206,
        headers: {
          ...mediaHeaders(
            read.descriptor.contentType,
            read.contentLength,
            options.cacheControl,
            options.cors,
          ),
          "Content-Range":
            `bytes ${read.start}-${read.end}/${read.descriptor.sizeBytes}`,
        },
      });
    }

    return new NextResponse(read.body, {
      status: 200,
      headers: mediaHeaders(
        read.descriptor.contentType,
        read.contentLength,
        options.cacheControl,
        options.cors,
      ),
    });
  } catch (error) {
    return errorResponse(error, options);
  }
}
