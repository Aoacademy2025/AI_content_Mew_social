import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveGeminiKey } from "@/lib/gemini-key";
import {
  checkRefTextMatch,
  createUserVoice,
  listUserVoices,
  readUserVoiceWav,
  userVoiceIdFor,
  UserVoiceError,
} from "@/lib/user-voices.server";

export const runtime = "nodejs";
export const maxDuration = 120;

// Custom clone voices — admin-only v1 (product decision 2026-07-30): cloning
// consumes managed compute (ADR 0003), so it stays behind the admin role until
// quota/abuse policy for general users is decided.
async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { user };
}

function publicUserVoice(voice: { id: string; name: string; refText: string; durationMs: number; createdAt: Date }) {
  return {
    id: voice.id,
    voiceId: userVoiceIdFor(voice.id),
    name: voice.name,
    refText: voice.refText,
    durationMs: voice.durationMs,
    createdAt: voice.createdAt.toISOString(),
  };
}

export async function GET() {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const voices = await listUserVoices(gate.user.id);
  return NextResponse.json(voices.map(publicUserVoice));
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  try {
    const form = await request.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "ต้องส่งเป็น multipart form" }, { status: 400 });
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) return NextResponse.json({ error: "แนบไฟล์เสียงก่อน" }, { status: 400 });
    const voice = await createUserVoice({
      userId: gate.user.id,
      name: String(form.get("name") ?? ""),
      refText: String(form.get("refText") ?? ""),
      audio: Buffer.from(await audio.arrayBuffer()),
    });

    // ตรวจว่า refText ตรงกับเสียงจริงมั้ย (ตัวการหลักของ "โคลนไม่เหมือน") —
    // fail-open: ไม่มี key/transcribe ล่ม ก็สร้างสำเร็จตามปกติ แค่ไม่มีคำเตือน
    let refCheck: { similarity: number; heard: string; warning: boolean } | null = null;
    try {
      const { key } = resolveGeminiKey(gate.user);
      const stored = await readUserVoiceWav(gate.user.id, voice.id);
      if (stored) {
        const result = await checkRefTextMatch(key, stored.wav, voice.refText);
        if (result) refCheck = { ...result, warning: result.similarity < 0.85 };
      }
    } catch { /* no key configured — skip the check */ }

    return NextResponse.json({ ...publicUserVoice(voice), refCheck }, { status: 201 });
  } catch (error) {
    if (error instanceof UserVoiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[omnivoice/user-voices] create failed:", error);
    return NextResponse.json({ error: "สร้างเสียงโคลนไม่สำเร็จ" }, { status: 500 });
  }
}
