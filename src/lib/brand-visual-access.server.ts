import "server-only";

import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  resolveBrandVisualAccess,
  type BrandVisualAccessDecision,
} from "@/lib/brand-visual-rollout.server";

export type BrandVisualAuthResult =
  | { ok: true; user: User; access: BrandVisualAccessDecision }
  | { ok: false; response: NextResponse };

export function brandVisualLockedResponse(access?: BrandVisualAccessDecision): NextResponse {
  if (access?.reason === "rollout_wait") {
    return NextResponse.json(
      { code: "BRAND_VISUAL_ROLLOUT_WAIT", error: "กำลังทยอยเปิด Brand Visual ให้สมาชิก — บัญชีนี้จะได้รับสิทธิ์ในรอบถัดไป" },
      { status: 403 },
    );
  }
  if (access?.reason === "payment_required") {
    return NextResponse.json(
      { code: "PAYMENT_REQUIRED", error: "Brand Visual เป็นฟีเจอร์สำหรับสมาชิก PRO/BUSINESS", upgradeUrl: "/pricing" },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { code: "BRAND_VISUAL_LOCKED", error: "ระบบแนวภาพยังไม่เปิดให้บัญชีนี้" },
    { status: 403 },
  );
}

/** Owner-only recovery for durable work that may have been admitted before a
 * kill switch/cohort rollback. This authenticates identity but deliberately
 * does not authorize any new generation. */
export async function requireBrandVisualRecoveryUser(): Promise<BrandVisualAuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true, user, access: await resolveBrandVisualAccess(user) };
}

export async function requireBrandVisualUser(): Promise<BrandVisualAuthResult> {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth;
  if (!auth.access.canUse) {
    return {
      ok: false,
      response: brandVisualLockedResponse(auth.access),
    };
  }
  return auth;
}
