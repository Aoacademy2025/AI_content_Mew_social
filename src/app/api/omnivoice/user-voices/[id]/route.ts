import { NextResponse } from "next/server";
import { heroVoiceClonePrivateJson as privateJson, heroVoiceClonePrivateResponse } from "@/lib/hero-voice-clone-response.server";

import { getCurrentUser } from "@/lib/clerk-auth";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";
import {
  deleteUserVoice,
  readUserVoiceWav,
  UserVoiceError,
} from "@/lib/user-voices.server";

export const runtime = "nodejs";

async function requireCloneCanaryUser() {
  const user = await getCurrentUser();
  const access = heroVoiceCloneCanaryAccessDecision(user);
  if (!access.allowed) {
    return {
      error: privateJson(
        { error: access.status === 401 ? "Unauthorized" : "Not found" },
        { status: access.status },
      ),
    } as const;
  }
  return { user: user! } as const;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireCloneCanaryUser();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  const voice = await readUserVoiceWav(gate.user.id, id);
  if (!voice) return privateJson({ error: "Not found" }, { status: 404 });
  return heroVoiceClonePrivateResponse(new NextResponse(new Uint8Array(voice.wav), {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(voice.wav.length),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  }));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireCloneCanaryUser();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  try {
    const removed = await deleteUserVoice(gate.user.id, id);
    if (!removed) return privateJson({ error: "Not found" }, { status: 404 });
    return privateJson({ ok: true });
  } catch (error) {
    if (error instanceof UserVoiceError) {
      return privateJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[omnivoice/user-voices] delete failed:", error);
    return privateJson({ error: "ลบเสียงโคลนไม่สำเร็จ" }, { status: 500 });
  }
}
