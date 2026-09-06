import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { desktopJson } from "@/lib/desktop/http";
import { enforceSeatLimit, seatLimitForEffectivePlan } from "@/lib/desktop/seats";
import { parseHeartbeatBody, publicSeat } from "@/lib/desktop/device-seats";
import {
  desktopMisconfigured,
  issueEntitlementSnapshot,
  snapshotInvalid,
  snapshotSecretOrNull,
  verifyEntitlementSnapshot,
} from "@/lib/desktop/snapshot";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export const POST = withDesktop(async (req, principal) => {
  const secret = snapshotSecretOrNull();
  if (!secret) return desktopMisconfigured();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return desktopJson(400, "INVALID_BODY", "ข้อมูลอุปกรณ์ไม่ครบ — ตรวจสอบแล้วส่งใหม่");
  }
  const parsed = parseHeartbeatBody(body);
  if (!parsed) {
    return desktopJson(400, "INVALID_BODY", "ข้อมูลอุปกรณ์ไม่ครบ — ตรวจสอบแล้วส่งใหม่");
  }
  if (!verifyEntitlementSnapshot(parsed.entitlementSnapshot, principal.userId, secret)) {
    return snapshotInvalid();
  }

  const existing = await prisma.deviceSeat.findFirst({
    where: { deviceId: parsed.deviceId, userId: principal.userId },
  });
  if (!existing || existing.revokedAt) {
    return desktopJson(401, "SEAT_REVOKED", "เครื่องนี้ถูกถอดออกจากบัญชีแล้ว — เข้าสู่ระบบใหม่บนเครื่องนี้");
  }

  const limit = seatLimitForEffectivePlan(principal.effectivePlan);
  await enforceSeatLimit(principal.userId, limit);

  const afterLimit = await prisma.deviceSeat.findUnique({ where: { id: existing.id } });
  if (!afterLimit || afterLimit.revokedAt) {
    return desktopJson(401, "SEAT_REVOKED", "เครื่องนี้ถูกถอดออกจากบัญชีแล้ว — เข้าสู่ระบบใหม่บนเครื่องนี้");
  }

  const now = new Date();
  const seat = await prisma.deviceSeat.update({
    where: { id: existing.id },
    data: { lastSeenAt: now },
  });
  const issued = issueEntitlementSnapshot(principal, secret, now);
  return NextResponse.json({
    seat: publicSeat(seat),
    entitlementSnapshot: issued.entitlementSnapshot,
    expiresAt: issued.expiresAt,
  });
});
