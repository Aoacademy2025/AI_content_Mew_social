import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { getFirstClipConvertPrompt } from "@/lib/first-clip-convert.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json(await getFirstClipConvertPrompt(user.id));
  } catch (error) {
    return apiError({ route: "GET /api/convert/first-clip", error });
  }
}
