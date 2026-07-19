import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  checkOmniVoiceReady,
  isOmniVoiceUserAllowed,
  OmniVoiceConfigError,
  omnivoiceConfig,
} from "@/lib/omnivoice";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOmniVoiceUserAllowed(user.id)) {
    return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "private, no-store" } });
  }

  try {
    const config = omnivoiceConfig();
    if (!await checkOmniVoiceReady(config)) {
      return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ enabled: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[omnivoice/status] config check failed:", error);
    }
    return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "private, no-store" } });
  }
}
