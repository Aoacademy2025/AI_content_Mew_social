import "server-only";

import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  decideBrandVisualAccess,
  type BrandVisualAccessDecision,
} from "@/lib/brand-visual-rollout.server";

export type BrandVisualAuthResult =
  | { ok: true; user: User; access: BrandVisualAccessDecision }
  | { ok: false; response: NextResponse };

export async function requireBrandVisualUser(): Promise<BrandVisualAuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const access = decideBrandVisualAccess(user);
  if (!access.canUse) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: "BRAND_VISUAL_LOCKED", error: "ระบบแนวภาพยังไม่เปิดให้บัญชีนี้" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, user, access };
}
