import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatar: true } as any,
  });

  return NextResponse.json({ avatar: (user as any)?.avatar ?? null });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { avatar } = await req.json();

  if (avatar && !avatar.startsWith("data:image/")) {
    return NextResponse.json({ error: "Invalid image format" }, { status: 400 });
  }

  // ~2MB limit (base64 is ~33% larger than binary)
  if (avatar && avatar.length > 2_800_000) {
    return NextResponse.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 2MB)" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { avatar } as any,
  });

  return NextResponse.json({ success: true });
}
