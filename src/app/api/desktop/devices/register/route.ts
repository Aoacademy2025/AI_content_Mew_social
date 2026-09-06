import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { desktopJson } from "@/lib/desktop/http";
import { enforceSeatLimit, seatLimitForEffectivePlan } from "@/lib/desktop/seats";
import { parseRegisterBody, publicSeat, seatLimitDevices } from "@/lib/desktop/device-seats";
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
  const parsed = parseRegisterBody(body);
  if (!parsed) {
    return desktopJson(400, "INVALID_BODY", "ข้อมูลอุปกรณ์ไม่ครบ — ตรวจสอบแล้วส่งใหม่");
  }

  if (parsed.entitlementSnapshot !== undefined) {
    if (!verifyEntitlementSnapshot(parsed.entitlementSnapshot, principal.userId, secret)) {
      return snapshotInvalid();
    }
  }

  const limit = seatLimitForEffectivePlan(principal.effectivePlan);
  await enforceSeatLimit(principal.userId, limit);

  const now = new Date();
  const existing = await prisma.deviceSeat.findUnique({ where: { deviceId: parsed.deviceId } });
  if (existing && existing.userId !== principal.userId) {
    return desktopJson(409, "DEVICE_CONFLICT", "อุปกรณ์นี้ผูกกับบัญชีอื่นแล้ว — ใช้เครื่องนี้กับบัญชีเดิม หรือติดต่อทีม Hero AI");
  }

  if (existing && existing.userId === principal.userId && !existing.revokedAt) {
    const seat = await prisma.deviceSeat.update({
      where: { id: existing.id },
      data: {
        name: parsed.name,
        platform: parsed.platform,
        appVersion: parsed.appVersion,
        lastSeenAt: now,
      },
    });
    const issued = issueEntitlementSnapshot(principal, secret, now);
    return NextResponse.json({
      seat: publicSeat(seat),
      entitlementSnapshot: issued.entitlementSnapshot,
      expiresAt: issued.expiresAt,
    });
  }

  const active = await prisma.deviceSeat.findMany({
    where: { userId: principal.userId, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (active.length >= limit) {
    return desktopJson(409, "SEAT_LIMIT", "บัญชีนี้ล็อกอินครบจำนวนเครื่องแล้ว — ลบเครื่องเก่าในตั้งค่าแล้วลองใหม่", {
      limit,
      devices: seatLimitDevices(active),
    });
  }

  const seat = existing
    ? await prisma.deviceSeat.update({
        where: { id: existing.id },
        data: {
          name: parsed.name,
          platform: parsed.platform,
          appVersion: parsed.appVersion,
          lastSeenAt: now,
          revokedAt: null,
          createdAt: now,
        },
      })
    : await prisma.deviceSeat.create({
        data: {
          userId: principal.userId,
          deviceId: parsed.deviceId,
          name: parsed.name,
          platform: parsed.platform,
          appVersion: parsed.appVersion,
          lastSeenAt: now,
        },
      });

  const issued = issueEntitlementSnapshot(principal, secret, now);
  return NextResponse.json({
    seat: publicSeat(seat),
    entitlementSnapshot: issued.entitlementSnapshot,
    expiresAt: issued.expiresAt,
  });
});
