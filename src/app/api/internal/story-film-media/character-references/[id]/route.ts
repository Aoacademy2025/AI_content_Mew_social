import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { prisma } from "@/lib/prisma";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";
import { storyFilmCharacterReferencesDir } from "@/lib/story-film-character-storage";

export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

async function resolveReference(request: Request, id: string) {
  const worker = isStoryFilmWorkerAuthorized(request);
  const user = worker ? null : await getCurrentUser();
  if (!worker && (!user || !isInternalAiTester(user))) return null;
  return prisma.storyFilmCharacterReference.findFirst({
    where: {
      id,
      ...(worker ? {} : { profile: { userId: user!.id } }),
    },
  });
}

function localFile(storageUrl: string) {
  const match = /^story-film-private:(story-film-character-[A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/i.exec(storageUrl);
  if (!match) return null;
  return {
    filePath: path.join(storyFilmCharacterReferencesDir(), match[1]),
    mimeType: MIME_BY_EXT[match[1].split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
  };
}

async function responseFor(request: Request, id: string, head: boolean) {
  const reference = await resolveReference(request, id);
  if (!reference) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const local = localFile(reference.storageUrl);
  if (!local || !fs.existsSync(local.filePath)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const stats = fs.statSync(local.filePath);
  return new NextResponse(head ? null : fs.readFileSync(local.filePath), {
    status: 200,
    headers: {
      "Content-Type": local.mimeType,
      "Content-Length": String(stats.size),
      "Cache-Control": "private, max-age=300, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return responseFor(request, (await params).id, false);
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return responseFor(request, (await params).id, true);
}
