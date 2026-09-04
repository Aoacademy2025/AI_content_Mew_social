import fs from "node:fs";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/clerk-auth";
import { heroVoiceCloneAudioFilePath } from "@/lib/hero-voice-clone-audio.server";
import {
  heroVoiceCloneCanaryAccessDecision,
  isHeroVoiceCloneGenerationJob,
} from "@/lib/omnivoice-policy";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "audio/wav",
  "Content-Disposition": "inline",
  "X-Content-Type-Options": "nosniff",
  "Accept-Ranges": "bytes",
};

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": PRIVATE_HEADERS["Cache-Control"] },
  });
}

function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > end) return null;
  return { start, end };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const user = await getCurrentUser();
  const access = heroVoiceCloneCanaryAccessDecision(user);
  if (!access.allowed) {
    return privateJson(
      { error: access.status === 401 ? "Unauthorized" : "Not found" },
      access.status,
    );
  }
  if (!user) throw new Error("clone canary access decision admitted a missing actor");

  const { jobId } = await params;
  const job = await prisma.aiGenerationJob.findFirst({ where: { id: jobId, userId: user.id } });
  const expectedUrl = `/api/ai-studio/voice-audio/${encodeURIComponent(jobId)}`;
  if (!job
    || !isHeroVoiceCloneGenerationJob(job)
    || job.status !== "completed"
    || job.outputUrl !== expectedUrl) {
    return privateJson({ error: "Not found" }, 404);
  }

  const filename = heroVoiceCloneAudioFilePath(job.id);
  if (!filename) return privateJson({ error: "Not found" }, 404);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filename);
  } catch {
    return privateJson({ error: "Not found" }, 404);
  }
  if (!stat.isFile() || stat.size < 44) return privateJson({ error: "Not found" }, 404);

  const rangeValue = request.headers.get("range");
  const range = parseRange(rangeValue, stat.size);
  if (!range) {
    return new NextResponse(null, {
      status: 416,
      headers: { ...PRIVATE_HEADERS, "Content-Range": `bytes */${stat.size}` },
    });
  }
  const body = fs.readFileSync(filename).subarray(range.start, range.end + 1);
  return new NextResponse(new Uint8Array(body), {
    status: rangeValue ? 206 : 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Length": String(body.length),
      ...(rangeValue ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
    },
  });
}
