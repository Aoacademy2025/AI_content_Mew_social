import type { DeviceSeat } from "@prisma/client";

export type PublicDeviceSeat = {
  id: string;
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
};

export type SeatLimitDevice = {
  id: string;
  name: string;
  lastSeenAt: string;
};

export function publicSeat(row: DeviceSeat): PublicDeviceSeat {
  return {
    id: row.id,
    deviceId: row.deviceId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export function seatLimitDevices(rows: DeviceSeat[]): SeatLimitDevice[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

function asTrimmed(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export function parseRegisterBody(body: unknown): {
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
  entitlementSnapshot?: unknown;
} | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const deviceId = asTrimmed(rec.deviceId, 128);
  const name = asTrimmed(rec.name, 80);
  const platform = asTrimmed(rec.platform, 32);
  const appVersion = asTrimmed(rec.appVersion, 32);
  if (!deviceId || !name || !platform || !appVersion) return null;
  return {
    deviceId,
    name,
    platform,
    appVersion,
    entitlementSnapshot: rec.entitlementSnapshot,
  };
}

export function parseHeartbeatBody(body: unknown): {
  deviceId: string;
  entitlementSnapshot: unknown;
} | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const deviceId = asTrimmed(rec.deviceId, 128);
  if (!deviceId) return null;
  return { deviceId, entitlementSnapshot: rec.entitlementSnapshot };
}
