import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getAvatarPreset, saveAvatarPreset } from "@/lib/avatar-preset";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ avatarId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { avatarId } = await params;
  const layout = await getAvatarPreset(user.id, avatarId);
  return NextResponse.json({ layout });
}

export async function PUT(req: Request, { params }: { params: Promise<{ avatarId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { avatarId } = await params;
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const layout = await saveAvatarPreset(user.id, avatarId, body);
  return NextResponse.json({ layout });
}
