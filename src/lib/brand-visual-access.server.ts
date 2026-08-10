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

export function brandVisualLockedResponse(): NextResponse {
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
  return { ok: true, user, access: decideBrandVisualAccess(user) };
}

export async function requireBrandVisualUser(): Promise<BrandVisualAuthResult> {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth;
  if (!auth.access.canUse) {
    return {
      ok: false,
      response: brandVisualLockedResponse(),
    };
  }
  return auth;
}
