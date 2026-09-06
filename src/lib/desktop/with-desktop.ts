import { NextResponse } from "next/server";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { isDesktopEnabled, isDesktopInvited } from "@/lib/desktop/flag";
import { resolveDesktopPrincipal } from "@/lib/desktop/auth";

export type DesktopHandler = (req: Request, principal: McpPrincipal) => Promise<Response> | Response;

function desktopError(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

/**
 * Gate every /api/desktop/* handler: flag → principal → allowlist → handler.
 * Allowlist needs a user id, so principal is resolved before the invite check.
 */
export function withDesktop(handler: DesktopHandler) {
  return async (req: Request): Promise<Response> => {
    if (!isDesktopEnabled()) {
      return desktopError(
        403,
        "DESKTOP_DISABLED",
        "แอปเดสก์ท็อปยังไม่เปิดให้ใช้งาน — ใช้ Hero AI บนเว็บต่อไป หรือรอการเชิญ",
      );
    }

    const principal = await resolveDesktopPrincipal(req);
    if (!principal) {
      return desktopError(
        401,
        "UNAUTHORIZED",
        "ไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่",
      );
    }

    if (!isDesktopInvited(principal.userId)) {
      return desktopError(
        403,
        "DESKTOP_NOT_INVITED",
        "บัญชีนี้ยังไม่ได้รับเชิญให้ใช้แอปเดสก์ท็อป — ติดต่อทีม Hero AI เพื่อขอสิทธิ์",
      );
    }

    return handler(req, principal);
  };
}
