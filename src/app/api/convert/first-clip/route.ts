import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import {
  dismissFirstClipConvertPrompt,
  getFirstClipConvertPrompt,
} from "@/lib/first-clip-convert.server";

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

/**
 * Persist "not now" for the signed-in user only. The user id comes from the
 * Clerk session, never from the request body, and the only accepted action is
 * the dismissal — this endpoint can neither read nor change anything else.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let action: unknown = null;
    try {
      const body = await req.json() as { action?: unknown } | null;
      action = body?.action ?? null;
    } catch {
      action = null;
    }
    if (action !== "dismiss") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    await dismissFirstClipConvertPrompt(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "POST /api/convert/first-clip", error });
  }
}
