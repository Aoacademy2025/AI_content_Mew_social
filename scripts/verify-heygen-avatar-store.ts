// Run with: npx tsx scripts/verify-heygen-avatar-store.ts
// Proves the DB-backed durable avatar-list store (heygen-avatars-store.ts) round-trips against the
// real heygenAvatarsCache / heygenAvatarsCachedAt columns, and that the key-fingerprint guard holds
// end-to-end (a rotated HeyGen key never serves the previous key's avatars).
//
// Self-contained: throwaway SQLite, pushes the schema, dynamically imports the store so the DB env
// is set before prisma init.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "heygenstore-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) { console.error("❌ " + msg); process.exit(1); } console.log("✓ " + msg); passed++; }

async function main() {
  const { saveStaleAvatars, loadStaleAvatars } = await import("../src/lib/heygen-avatars-store");
  const { prisma } = await import("../src/lib/prisma");

  const u = await prisma.user.create({ data: { name: "HeyGen Store Test", email: "heygen-store@test.local", heygenKey: Buffer.from("HKEYAAAAAA").toString("base64") } });
  const LIST = { avatars: [{ avatar_id: "x1", avatar_name: "X1" }], talkingPhotos: [{ talking_photo_id: "p1" }] };

  // 1) load before save → null (no crash, nothing persisted yet)
  ok((await loadStaleAvatars(u.id, "HKEYAAAAAA")) === null, "no durable list yet → loadStale returns null");

  // 2) save then load → round-trips against the real columns
  await saveStaleAvatars(u.id, "HKEYAAAAAA", LIST);
  const back = await loadStaleAvatars(u.id, "HKEYAAAAAA");
  ok(!!back && back.avatars[0].avatar_id === "x1" && back.talkingPhotos[0].talking_photo_id === "p1", "save → load round-trips the avatar list");

  // 3) the row actually holds JSON + a timestamp
  const row = await prisma.user.findUnique({ where: { id: u.id }, select: { heygenAvatarsCache: true, heygenAvatarsCachedAt: true } });
  ok(!!row?.heygenAvatarsCache && !!row?.heygenAvatarsCachedAt, "persisted heygenAvatarsCache + heygenAvatarsCachedAt columns are populated");

  // 4) rotated key fingerprint → null (never serve another key's avatars)
  ok((await loadStaleAvatars(u.id, "HKEYZZZZZZ")) === null, "rotated HeyGen key → loadStale returns null (key-fingerprint guard, end-to-end)");

  // 5) unknown user → null (no crash)
  ok((await loadStaleAvatars("nope-no-user", "HKEYAAAAAA")) === null, "unknown user → null");

  console.log(`\n✅ ALL ${passed} HEYGEN AVATAR-STORE (DB) CHECKS PASSED`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
