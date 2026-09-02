import "server-only";

import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  decideBrandLibraryAccess,
  resolveBrandVisualAccess,
  type BrandLibraryAccessDecision,
  type BrandVisualAccessDecision,
} from "@/lib/brand-visual-rollout.server";

export type BrandVisualAuthResult =
  | { ok: true; user: User; access: BrandVisualAccessDecision }
  | { ok: false; response: NextResponse };

/** The IMAGE gate (ADR 0059): paid entitlement + rollout cohort. It never closes
 * the Brand Library itself — only the actions that spend an AI image. */
export function brandVisualLockedResponse(access?: BrandVisualAccessDecision): NextResponse {
  if (access?.reason === "rollout_wait") {
    return NextResponse.json(
      { code: "BRAND_VISUAL_ROLLOUT_WAIT", error: "ระบบกำลังทยอยเปิดภาพ AI ประจำแบรนด์ให้สมาชิก บัญชีนี้จะได้รับสิทธิ์ในรอบถัดไป" },
      { status: 403 },
    );
  }
  if (access?.reason === "payment_required") {
    return NextResponse.json(
      { code: "PAYMENT_REQUIRED", error: "ภาพ AI ประจำแบรนด์ใช้ได้กับสมาชิก PRO และ BUSINESS", upgradeUrl: "/pricing" },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { code: "BRAND_VISUAL_LOCKED", error: "ภาพ AI ประจำแบรนด์ยังไม่เปิดให้บัญชีนี้" },
    { status: 403 },
  );
}

/** The LIBRARY gate (ADR 0059): the master switch and a suspension are the only
 * things that can close Brand Profile CRUD. Plan limits cap how many exist. */
export function brandLibraryLockedResponse(decision: BrandLibraryAccessDecision): NextResponse {
  return NextResponse.json(
    decision.reason === "suspended"
      ? { code: "ACCOUNT_SUSPENDED", error: "บัญชีนี้ถูกระงับการใช้งานชั่วคราว" }
      : { code: "BRAND_VISUAL_LOCKED", error: "ระบบแบรนด์ยังไม่เปิดรับงานใหม่ในขณะนี้" },
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

/** Brand Library CRUD: authentication + suspension + master switch, for every
 * plan. `auth.access` still carries the IMAGE decision for callers that report
 * the cohort or disclose the image gate to the client. */
export async function requireBrandLibraryUser(): Promise<BrandVisualAuthResult> {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth;
  const library = decideBrandLibraryAccess(auth.user);
  if (!library.canUse) return { ok: false, response: brandLibraryLockedResponse(library) };
  return auth;
}

/** AI-image actions only. */
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
