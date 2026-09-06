import { createHmac, timingSafeEqual } from "node:crypto";
import { seatLimitForEffectivePlan } from "@/lib/desktop/seats";
import { desktopJson } from "@/lib/desktop/http";

export const DESKTOP_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SECRET_BYTES = 32;

export type EntitlementSnapshotClaims = {
  userId: string;
  effectivePlan: string;
  seatLimit: number;
  issuedAt: string;
  expiresAt: string;
};

let loggedMisconfigured = false;

/** Fail closed when unset or shorter than 32 bytes. Logs once per process; never logs the value. */
export function snapshotSecretOrNull(): string | null {
  const raw = process.env.DESKTOP_SNAPSHOT_SECRET ?? "";
  if (Buffer.byteLength(raw, "utf8") >= MIN_SECRET_BYTES) return raw;
  if (!loggedMisconfigured) {
    loggedMisconfigured = true;
    console.error("[desktop] DESKTOP_SNAPSHOT_SECRET is unset or shorter than 32 bytes; device routes fail closed");
  }
  return null;
}

export function desktopMisconfigured() {
  return desktopJson(
    503,
    "DESKTOP_MISCONFIGURED",
    "ระบบเดสก์ท็อปยังตั้งค่าไม่ครบ — ลองใหม่ภายหลังหรือติดต่อทีม Hero AI",
  );
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signEntitlementSnapshot(claims: EntitlementSnapshotClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifyEntitlementSnapshot(
  token: unknown,
  expectedUserId: string,
  secret: string,
): EntitlementSnapshotClaims | null {
  if (typeof token !== "string" || token.length < 16) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as EntitlementSnapshotClaims;
    if (
      typeof claims.userId !== "string"
      || typeof claims.effectivePlan !== "string"
      || typeof claims.seatLimit !== "number"
      || typeof claims.issuedAt !== "string"
      || typeof claims.expiresAt !== "string"
    ) {
      return null;
    }
    if (claims.userId !== expectedUserId) return null;
    return claims;
  } catch {
    return null;
  }
}

export function issueEntitlementSnapshot(
  principal: { userId: string; effectivePlan: string },
  secret: string,
  now: Date = new Date(),
): { entitlementSnapshot: string; expiresAt: string; claims: EntitlementSnapshotClaims } {
  const claims: EntitlementSnapshotClaims = {
    userId: principal.userId,
    effectivePlan: principal.effectivePlan,
    seatLimit: seatLimitForEffectivePlan(principal.effectivePlan),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DESKTOP_OFFLINE_GRACE_MS).toISOString(),
  };
  return {
    entitlementSnapshot: signEntitlementSnapshot(claims, secret),
    expiresAt: claims.expiresAt,
    claims,
  };
}

export function snapshotInvalid() {
  return desktopJson(
    401,
    "SNAPSHOT_INVALID",
    "ข้อมูลสิทธิ์ไม่ถูกต้อง — เข้าสู่ระบบใหม่",
  );
}
