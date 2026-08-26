import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/clerk-auth";
import { isHeroVoiceCloningEnabled, isOmniVoiceUserAllowed } from "@/lib/omnivoice-policy";
import {
  createUserVoice,
  listUserVoices,
  MAX_UPLOAD_BYTES,
  userVoiceIdFor,
  UserVoiceError,
} from "@/lib/user-voices.server";

export const runtime = "nodejs";
export const maxDuration = 120;

async function requireCloneAdmin() {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (!isHeroVoiceCloningEnabled() || user.role !== "ADMIN" || !isOmniVoiceUserAllowed(user)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  }
  return { user } as const;
}

function publicUserVoice(voice: {
  id: string;
  name: string;
  durationMs: number;
  createdAt: Date;
}) {
  return {
    id: voice.id,
    voiceId: userVoiceIdFor(voice.id),
    name: voice.name,
    durationMs: voice.durationMs,
    createdAt: voice.createdAt.toISOString(),
    previewUrl: `/api/omnivoice/user-voices/${encodeURIComponent(voice.id)}`,
  };
}

export async function GET() {
  const gate = await requireCloneAdmin();
  if ("error" in gate) return gate.error;
  const voices = await listUserVoices(gate.user.id);
  return NextResponse.json(voices.map(publicUserVoice), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const gate = await requireCloneAdmin();
  if ("error" in gate) return gate.error;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "ไฟล์เสียงใหญ่เกิน 15 MB" }, { status: 413 });
  }

  try {
    const form = await request.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "ต้องส่งเป็น multipart form" }, { status: 400 });
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) {
      return NextResponse.json({ error: "แนบไฟล์เสียงก่อน" }, { status: 400 });
    }
    if (audio.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "ไฟล์เสียงใหญ่เกิน 15 MB" }, { status: 413 });
    }
    const voice = await createUserVoice({
      userId: gate.user.id,
      name: String(form.get("name") ?? ""),
      refText: String(form.get("refText") ?? ""),
      audio: Buffer.from(await audio.arrayBuffer()),
      consent: form.get("consent") === "true",
    });
    return NextResponse.json(publicUserVoice(voice), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof UserVoiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[omnivoice/user-voices] create failed:", error);
    return NextResponse.json({ error: "สร้างเสียงโคลนไม่สำเร็จ" }, { status: 500 });
  }
}
