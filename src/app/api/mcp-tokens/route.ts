import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isPaid } from "@/lib/plan-limits";
import { classifyEntitlement } from "@/lib/entitlements";
import { apiError } from "@/lib/api-error";
import { createMcpToken, listMcpTokens, countActiveMcpTokens } from "@/lib/mcp/token";
import { canCreateMcpTokenForUser, getMcpStarterTrialStatus } from "@/lib/mcp/starter-trial";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [tokens, starterTrial] = await Promise.all([
      listMcpTokens(user.id),
      getMcpStarterTrialStatus(user),
    ]);
    return NextResponse.json({ tokens, starterTrial });
  } catch (error) {
    return apiError({ route: "GET /api/mcp-tokens", error });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!canCreateMcpTokenForUser(user)) {
      return NextResponse.json({ error: "บัญชีนี้ยังไม่สามารถสร้าง MCP token ได้ กรุณาตรวจสอบสถานะบัญชีหรืออัปเกรดที่ https://studio.heroaiengine.com/pricing" }, { status: 403 });
    }
    if ((await countActiveMcpTokens(user.id)) >= 10) {
      return NextResponse.json({ error: "มี token ครบ 10 ตัวแล้ว — เพิกถอนตัวเก่าก่อนสร้างใหม่" }, { status: 400 });
    }
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    const { token, id } = await createMcpToken(user.id, name);
    return NextResponse.json({ id, token }, { status: 201 }); // token shown once
  } catch (error) {
    return apiError({ route: "POST /api/mcp-tokens", error });
  }
}
