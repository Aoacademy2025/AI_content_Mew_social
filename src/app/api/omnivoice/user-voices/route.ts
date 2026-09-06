import { heroVoiceClonePrivateJson as privateJson } from "@/lib/hero-voice-clone-response.server";

import { getCurrentUser } from "@/lib/clerk-auth";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";
import {
  createUserVoice,
  listUserVoices,
  MAX_UPLOAD_BYTES,
  userVoiceIdFor,
  UserVoiceError,
} from "@/lib/user-voices.server";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  const gate = await requireCloneCanaryUser();
  if ("error" in gate) return gate.error;
  const voices = await listUserVoices(gate.user.id);
  return privateJson(voices.map(publicUserVoice));
}

export async function POST(request: Request) {
  const gate = await requireCloneCanaryUser();
  if ("error" in gate) return gate.error;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return privateJson({ error: "ไฟล์เสียงใหญ่เกิน 15 MB" }, { status: 413 });
  }

  try {
    const form = await request.formData().catch(() => null);
    if (!form) return privateJson({ error: "ต้องส่งเป็น multipart form" }, { status: 400 });
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) {
      return privateJson({ error: "แนบไฟล์เสียงก่อน" }, { status: 400 });
    }
    if (audio.size > MAX_UPLOAD_BYTES) {
      return privateJson({ error: "ไฟล์เสียงใหญ่เกิน 15 MB" }, { status: 413 });
    }
    const voice = await createUserVoice({
      userId: gate.user.id,
      name: String(form.get("name") ?? ""),
      refText: String(form.get("refText") ?? ""),
      audio: Buffer.from(await audio.arrayBuffer()),
      consent: form.get("consent") === "true",
    });
    return privateJson(publicUserVoice(voice), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof UserVoiceError) {
      return privateJson({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[omnivoice/user-voices] create failed:", error);
    return privateJson({ error: "สร้างเสียงโคลนไม่สำเร็จ" }, { status: 500 });
  }
}
