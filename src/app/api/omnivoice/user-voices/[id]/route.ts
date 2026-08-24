import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/clerk-auth";
import { isHeroVoiceCloningEnabled, isOmniVoiceUserAllowed } from "@/lib/omnivoice-policy";
import {
  deleteUserVoice,
  readUserVoiceWav,
  UserVoiceError,
} from "@/lib/user-voices.server";

export const runtime = "nodejs";

async function requireCloneAdmin() {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (!isHeroVoiceCloningEnabled() || user.role !== "ADMIN" || !isOmniVoiceUserAllowed(user)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  }
  return { user } as const;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireCloneAdmin();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  const voice = await readUserVoiceWav(gate.user.id, id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(voice.wav), {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(voice.wav.length),
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireCloneAdmin();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  try {
    const removed = await deleteUserVoice(gate.user.id, id);
    if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof UserVoiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[omnivoice/user-voices] delete failed:", error);
    return NextResponse.json({ error: "ลบเสียงโคลนไม่สำเร็จ" }, { status: 500 });
  }
}
