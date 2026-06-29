// Run: npx tsx scripts/verify-avatar-preset.ts
// Proves AvatarPreset save→load round-trips, upserts per (user,avatar), isolates users.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "avpreset-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

async function main() {
  const { getAvatarPreset, saveAvatarPreset, DEFAULT_AVATAR_LAYOUT } = await import("../src/lib/avatar-preset");
  const { prisma } = await import("../src/lib/prisma");
  const u = await prisma.user.create({ data: { name: "P", email: "preset@test.local" } });

  ok((await getAvatarPreset(u.id, "av1")) === null, "no preset yet → null (caller uses default)");

  const saved = await saveAvatarPreset(u.id, "av1", { scale: 1.6, offsetX: 120, offsetY: -40 });
  ok(saved.scale === 1.6 && saved.offsetX === 120 && saved.offsetY === -40, "save returns the clamped layout");
  const back = await getAvatarPreset(u.id, "av1");
  ok(!!back && back.scale === 1.6 && back.offsetX === 120 && back.offsetY === -40, "load round-trips");

  await saveAvatarPreset(u.id, "av1", { scale: 2.0, offsetX: 0, offsetY: 0 });
  const back2 = await getAvatarPreset(u.id, "av1");
  ok(back2!.scale === 2.0 && back2!.offsetX === 0, "re-save overwrites (upsert on user+avatar)");
  ok((await prisma.avatarPreset.count({ where: { userId: u.id } })) === 1, "still one row (no dup)");

  const u2 = await prisma.user.create({ data: { name: "Q", email: "preset2@test.local" } });
  ok((await getAvatarPreset(u2.id, "av1")) === null, "another user's same avatarId is isolated");

  // garbage/no-op stores the default (so a 'Save' always yields a usable row)
  const def = await saveAvatarPreset(u.id, "avX", { scale: "nope" });
  ok(def.scale === DEFAULT_AVATAR_LAYOUT.scale && def.offsetX === 0 && def.offsetY === 0, "garbage layout → stored as default");

  console.log(`\n✅ ALL ${p} AVATAR-PRESET CHECKS PASSED`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
