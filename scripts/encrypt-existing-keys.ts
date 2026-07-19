// One-time migration: re-encrypt legacy (base64) BYOK provider keys to AES-256-GCM.
//
// RUN AFTER DEPLOY, with KEY_ENC_SECRET set in the environment (same secret the app
// uses). Idempotent — safe to run repeatedly; already-encrypted (`v2:`) values are
// skipped. Dry-run by default; pass --apply to write.
//
// On PROD (inside /var/www/ai-content, prod .env supplies DATABASE_URL + KEY_ENC_SECRET):
//   npx tsx scripts/encrypt-existing-keys.ts            # dry run — reports counts, writes nothing
//   npx tsx scripts/encrypt-existing-keys.ts --apply    # commit
//
// Backward compatibility: decryptKey reads BOTH v2 and legacy base64, so reads keep
// working before, during, and after this migration — no downtime, no ordering risk.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { encryptKey, decryptKey, isEncrypted } from "../src/lib/key-crypto";

const KEY_FIELDS = [
  "geminiKey", "heygenKey", "elevenlabsKey", "pexelsKey",
  "pixabayKey", "kieKey", "unsplashKey", "flickrKey",
] as const;
type KeyField = (typeof KEY_FIELDS)[number];

const apply = process.argv.includes("--apply");

async function main() {
  if (!process.env.KEY_ENC_SECRET) {
    console.error(
      "\n❌ KEY_ENC_SECRET is not set. Set it in the environment before migrating —\n" +
        "   otherwise keys would be re-written as base64 (no encryption). Aborting.\n",
    );
    process.exit(1);
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true,
      pixabayKey: true, kieKey: true, unsplashKey: true, flickrKey: true,
    },
  });

  let usersTouched = 0;
  let fieldsMigrated = 0;
  const perField: Record<string, number> = {};

  for (const user of users) {
    const data: Partial<Record<KeyField, string>> = {};
    for (const field of KEY_FIELDS) {
      const stored = user[field];
      if (!stored) continue;            // empty/null → nothing to do
      if (isEncrypted(stored)) continue; // already v2 → idempotent skip
      // Legacy base64 → decode to plaintext, then AES-256-GCM encrypt.
      const plain = decryptKey(stored); // non-v2 → base64 decode (legacy path)
      data[field] = encryptKey(plain);
      fieldsMigrated++;
      perField[field] = (perField[field] ?? 0) + 1;
    }
    if (Object.keys(data).length === 0) continue;
    usersTouched++;
    if (apply) {
      await prisma.user.update({ where: { id: user.id }, data });
    }
  }

  console.log(`\n${apply ? "✅ APPLIED" : "⚠️  DRY RUN (no writes — pass --apply to commit)"}`);
  console.log(`Users scanned:        ${users.length}`);
  console.log(`Users with legacy key: ${usersTouched}`);
  console.log(`Fields ${apply ? "re-encrypted" : "to re-encrypt"}: ${fieldsMigrated}`);
  for (const field of KEY_FIELDS) {
    if (perField[field]) console.log(`  - ${field}: ${perField[field]}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
