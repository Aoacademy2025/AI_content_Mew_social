// Device Seats: register / heartbeat / revoke / snapshot. Throwaway SQLite:
//   node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-desktop-seats.ts
//   npm run verify:desktop-seats
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "desktop-seats-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.DESKTOP_APP = "1";
process.env.DESKTOP_ALLOWLIST = "";
process.env.DESKTOP_SNAPSHOT_SECRET = "desktop-snapshot-secret-for-verify-tests-32b";
process.env.DESKTOP_SEATS_VERIFY = "1";
execSync("./node_modules/.bin/prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const THAI_TEXT = /[ก-๙]/;
const ROOT = process.cwd();

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) {
    console.error("❌ " + m);
    process.exit(1);
  }
  console.log("✓ " + m);
  passed++;
}

function apiReq(url: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function collectRouteFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dirPath: string) {
    for (const name of readdirSync(dirPath)) {
      const full = join(dirPath, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

function keysOf(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object).sort() : [];
}

async function main() {
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  assert(/model DeviceSeat \{/.test(schema), "Prisma model DeviceSeat exists");
  assert(/deviceId\s+String\s+@unique/.test(schema), "DeviceSeat.deviceId is unique");
  assert(/@@index\(\[userId\]\)/.test(schema), "DeviceSeat indexes userId");
  assert(!/model DeviceSeat \{[\s\S]*?email/.test(schema), "DeviceSeat stores no email");
  const userBlock = schema.slice(schema.indexOf("model User {"), schema.indexOf("\n}\n\n", schema.indexOf("model User {")) + 2);
  assert(!/deviceSeat/i.test(userBlock), "User model is untouched (no DeviceSeat relation)");

  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert(/DESKTOP_SNAPSHOT_SECRET=/.test(envExample), ".env.example documents DESKTOP_SNAPSHOT_SECRET");
  assert(!/[a-f0-9]{32,}/i.test(envExample.split("DESKTOP_SNAPSHOT_SECRET")[1]?.slice(0, 80) ?? ""), "no real secret in .env.example");

  const seatsLib = readFileSync(join(ROOT, "src/lib/desktop/seats.ts"), "utf8");
  assert(/oldest/.test(seatsLib) && /PRO/.test(seatsLib) && /FREE/.test(seatsLib), "downgrade PRO→FREE oldest-seat rule is documented in seats.ts");

  const settingsPage = readFileSync(join(ROOT, "src/app/(dashboard)/settings/page.tsx"), "utf8");
  const settingsSection = readFileSync(join(ROOT, "src/components/settings/desktop-devices-section.tsx"), "utf8");
  assert(settingsPage.includes("DesktopDevicesSection"), "Settings page mounts DesktopDevicesSection");
  assert(settingsSection.includes("อุปกรณ์ที่ล็อกอิน"), "Settings section title is Thai อุปกรณ์ที่ล็อกอิน");
  assert(settingsSection.includes("ลบ"), "Settings section has ลบ");
  assert(
    settingsSection.includes("isDesktopEnabled") && settingsSection.includes("isDesktopInvited"),
    "Settings section is gated by isDesktopEnabled && isDesktopInvited",
  );

  const desktopRouteFiles = collectRouteFiles(join(ROOT, "src/app/api/desktop"));
  assert(desktopRouteFiles.length >= 4, "session + register + heartbeat + revoke routes exist");
  for (const file of desktopRouteFiles) {
    const src = readFileSync(file, "utf8");
    assert(src.includes("withDesktop"), `${file.replace(ROOT, "")} uses withDesktop`);
  }

  const { prisma } = await import("../src/lib/prisma");
  const { createMcpToken } = await import("../src/lib/mcp/token");
  const { isDesktopEnabled, isDesktopInvited } = await import("../src/lib/desktop/flag");
  const { POST: register } = await import("../src/app/api/desktop/devices/register/route");
  const { POST: heartbeat } = await import("../src/app/api/desktop/devices/heartbeat/route");
  const { DELETE: revoke } = await import("../src/app/api/desktop/devices/[id]/route");

  await prisma.deviceSeat.deleteMany();
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();

  const pro = await prisma.user.create({
    data: {
      name: "seats-pro",
      email: "seats-pro@t.test",
      plan: "PRO",
      subStatus: "active",
      minutesLimit: 80,
      usagePeriodStartedAt: new Date(),
    },
  });
  const { token: pat } = await createMcpToken(pro.id, "desktop-seats");

  const deviceA = { deviceId: "dev-a", name: "Mac ของเอ", platform: "darwin", appVersion: "0.1.0" };
  const deviceB = { deviceId: "dev-b", name: "PC ของบี", platform: "win32", appVersion: "0.1.0" };
  const deviceC = { deviceId: "dev-c", name: "เครื่องสาม", platform: "darwin", appVersion: "0.1.1" };

  const regA = await register(apiReq("http://localhost/api/desktop/devices/register", { token: pat, body: deviceA }));
  const bodyA = await jsonOf(regA);
  assert(regA.status === 200, "first PRO device registers 200");
  assert(typeof bodyA.entitlementSnapshot === "string", "register returns opaque entitlementSnapshot");
  assert(typeof bodyA.expiresAt === "string", "register returns expiresAt");
  const seatA = bodyA.seat as Record<string, unknown>;
  assert(!!seatA?.id && seatA.deviceId === "dev-a", "register returns seat");
  assert(!("email" in seatA) && !("clerkId" in seatA), "seat has no PII beyond device name");
  const expiresA = new Date(bodyA.expiresAt as string).getTime();
  assert(expiresA - Date.now() > 6.5 * 24 * 60 * 60 * 1000 && expiresA - Date.now() < 7.5 * 24 * 60 * 60 * 1000, "expiresAt is now+7d");

  const regB = await register(apiReq("http://localhost/api/desktop/devices/register", { token: pat, body: deviceB }));
  const bodyB = await jsonOf(regB);
  assert(regB.status === 200, "second PRO device registers 200");

  const regC = await register(apiReq("http://localhost/api/desktop/devices/register", { token: pat, body: deviceC }));
  const bodyC = await jsonOf(regC);
  assert(regC.status === 409, "third device on PRO → 409");
  assert(bodyC.code === "SEAT_LIMIT", "third device → SEAT_LIMIT");
  assert(bodyC.limit === 2, "SEAT_LIMIT reports limit 2");
  assert(typeof bodyC.message === "string" && THAI_TEXT.test(bodyC.message as string), "SEAT_LIMIT Thai message");
  const listed = bodyC.devices as Array<Record<string, unknown>>;
  assert(Array.isArray(listed) && listed.length === 2, "409 includes the two existing devices");
  for (const d of listed) {
    assert(typeof d.id === "string" && typeof d.name === "string" && typeof d.lastSeenAt === "string", "409 device has id,name,lastSeenAt");
    assert(JSON.stringify(keysOf(d)) === JSON.stringify(["id", "lastSeenAt", "name"]), "409 device list has no PII beyond name");
  }
  assert(listed.some((d) => d.name === "Mac ของเอ") && listed.some((d) => d.name === "PC ของบี"), "409 lists both registered names");

  const hbOk = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: pat,
    body: { deviceId: "dev-a", entitlementSnapshot: bodyA.entitlementSnapshot },
  }));
  const hbOkBody = await jsonOf(hbOk);
  assert(hbOk.status === 200, "heartbeat of active seat → 200");
  assert(typeof hbOkBody.entitlementSnapshot === "string", "heartbeat returns refreshed snapshot");

  const tampered = String(bodyA.entitlementSnapshot).replace(/\./, ".") + "ff";
  const hbTamper = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: pat,
    body: { deviceId: "dev-a", entitlementSnapshot: tampered },
  }));
  const hbTamperBody = await jsonOf(hbTamper);
  assert(hbTamper.status === 401, "tampered snapshot → 401");
  assert(hbTamperBody.code === "SNAPSHOT_INVALID", "tampered snapshot → SNAPSHOT_INVALID");
  assert(typeof hbTamperBody.message === "string" && THAI_TEXT.test(hbTamperBody.message as string), "SNAPSHOT_INVALID Thai message");

  const regTamper = await register(apiReq("http://localhost/api/desktop/devices/register", {
    token: pat,
    body: { ...deviceA, entitlementSnapshot: tampered },
  }));
  const regTamperBody = await jsonOf(regTamper);
  assert(regTamper.status === 401 && regTamperBody.code === "SNAPSHOT_INVALID", "tampered snapshot on register → 401 SNAPSHOT_INVALID");

  const seatB = bodyB.seat as Record<string, unknown>;
  const delB = await revoke(apiReq(`http://localhost/api/desktop/devices/${seatB.id}`, { method: "DELETE", token: pat }));
  assert(delB.status === 200, "owner can revoke own seat");

  const hbRevoked = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: pat,
    body: { deviceId: "dev-b", entitlementSnapshot: bodyB.entitlementSnapshot },
  }));
  const hbRevokedBody = await jsonOf(hbRevoked);
  assert(hbRevoked.status === 401, "revoke → next heartbeat 401");
  assert(hbRevokedBody.code === "SEAT_REVOKED", "revoked heartbeat → SEAT_REVOKED");
  assert(typeof hbRevokedBody.message === "string" && THAI_TEXT.test(hbRevokedBody.message as string), "SEAT_REVOKED Thai message");

  const stranger = await prisma.user.create({
    data: { name: "seats-other", email: "seats-other@t.test", plan: "PRO", subStatus: "active" },
  });
  const { token: strangerPat } = await createMcpToken(stranger.id, "other");
  const steal = await revoke(apiReq(`http://localhost/api/desktop/devices/${seatA.id}`, { method: "DELETE", token: strangerPat }));
  assert(steal.status === 404 || steal.status === 403, "non-owner cannot revoke another user's seat");

  const freeUser = await prisma.user.create({
    data: {
      name: "seats-downgrade",
      email: "seats-downgrade@t.test",
      plan: "PRO",
      subStatus: "active",
      minutesLimit: 80,
      usagePeriodStartedAt: new Date(),
    },
  });
  const { token: downPat } = await createMcpToken(freeUser.id, "downgrade");
  const oldDev = { deviceId: "old-mac", name: "เครื่องเก่า", platform: "darwin", appVersion: "0.1.0" };
  const newDev = { deviceId: "new-mac", name: "เครื่องใหม่", platform: "darwin", appVersion: "0.1.0" };
  const oldReg = await register(apiReq("http://localhost/api/desktop/devices/register", { token: downPat, body: oldDev }));
  const oldBody = await jsonOf(oldReg);
  await new Promise((r) => setTimeout(r, 20));
  const newReg = await register(apiReq("http://localhost/api/desktop/devices/register", { token: downPat, body: newDev }));
  const newBody = await jsonOf(newReg);
  assert(oldReg.status === 200 && newReg.status === 200, "downgrade fixture registered two PRO seats");

  await prisma.user.update({
    where: { id: freeUser.id },
    data: { plan: "FREE", subStatus: null, trialEndsAt: null, planExpiresAt: null, bundleStatus: null, bundleAccessExpiresAt: null },
  });

  const hbNewAfterDown = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: downPat,
    body: { deviceId: "new-mac", entitlementSnapshot: newBody.entitlementSnapshot },
  }));
  const hbNewAfterDownBody = await jsonOf(hbNewAfterDown);
  assert(hbNewAfterDown.status === 401 && hbNewAfterDownBody.code === "SEAT_REVOKED", "downgrade PRO→FREE revokes newer seat");

  const hbOldAfterDown = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: downPat,
    body: { deviceId: "old-mac", entitlementSnapshot: oldBody.entitlementSnapshot },
  }));
  assert(hbOldAfterDown.status === 200, "downgrade PRO→FREE keeps the oldest seat");

  const savedSecret = process.env.DESKTOP_SNAPSHOT_SECRET;
  delete process.env.DESKTOP_SNAPSHOT_SECRET;
  const missReg = await register(apiReq("http://localhost/api/desktop/devices/register", { token: pat, body: deviceA }));
  const missRegBody = await jsonOf(missReg);
  assert(missReg.status === 503, "missing secret → 503");
  assert(missRegBody.code === "DESKTOP_MISCONFIGURED", "missing secret → DESKTOP_MISCONFIGURED");
  assert(typeof missRegBody.message === "string" && THAI_TEXT.test(missRegBody.message as string), "misconfigured Thai message");

  const missHb = await heartbeat(apiReq("http://localhost/api/desktop/devices/heartbeat", {
    token: pat,
    body: { deviceId: "dev-a", entitlementSnapshot: bodyA.entitlementSnapshot },
  }));
  const missHbBody = await jsonOf(missHb);
  assert(missHb.status === 503 && missHbBody.code === "DESKTOP_MISCONFIGURED", "heartbeat missing secret → 503");

  process.env.DESKTOP_SNAPSHOT_SECRET = "too-short";
  const shortReg = await register(apiReq("http://localhost/api/desktop/devices/register", { token: pat, body: deviceA }));
  const shortBody = await jsonOf(shortReg);
  assert(shortReg.status === 503 && shortBody.code === "DESKTOP_MISCONFIGURED", "secret < 32 bytes → 503");
  process.env.DESKTOP_SNAPSHOT_SECRET = savedSecret;

  delete process.env.DESKTOP_APP;
  assert(isDesktopEnabled() === false, "flag off");
  assert(isDesktopInvited(pro.id) === true, "empty allowlist still invited");
  const { canShowDesktopDeviceSeats } = await import("../src/lib/desktop/flag");
  assert(canShowDesktopDeviceSeats(pro.id) === false, "Settings section invisible with flag off");
  process.env.DESKTOP_APP = "1";
  process.env.DESKTOP_ALLOWLIST = "someone-else";
  assert(canShowDesktopDeviceSeats(pro.id) === false, "Settings section invisible when user is not invited");
  process.env.DESKTOP_ALLOWLIST = "";
  assert(canShowDesktopDeviceSeats(pro.id) === true, "Settings section visible when flag on and invited");

  await prisma.deviceSeat.deleteMany();
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} DESKTOP SEAT CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
