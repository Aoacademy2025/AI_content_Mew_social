import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { deleteUserVoice, readUserVoiceWav } from "@/lib/user-voices.server";

export const runtime = "nodejs";

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { user };
}

/** Preview playback of the caller's OWN reference recording — never public. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  const voice = await readUserVoiceWav(gate.user.id, id);
  if (!voice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(voice.wav), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(voice.wav.length),
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { id } = await params;
  const removed = await deleteUserVoice(gate.user.id, id);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
