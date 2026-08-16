// Proof that the default TTS provider is Gemini end-to-end: the Prisma column
// default, the parse/resolve helpers, and the SHIPPED backfill script's
// exported rule (imported, not re-implemented). Run against a THROWAWAY DB —
// never prisma/dev.db:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-default-voice.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-default-voice.db?connection_limit=1" npx tsx scripts/verify-default-voice-provider.ts
import { prisma } from "../src/lib/prisma";
import { parseTtsProvider, resolveJobTtsProvider } from "../src/lib/tts-providers";
import { backfillTtsProviderToGemini } from "./backfill-tts-provider-gemini";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

// This script calls prisma.user.deleteMany(). DATABASE_URL is read from the
// environment, and the default in .env points at prisma/dev.db — a real DB.
// Hard-abort before any write unless DATABASE_URL is unambiguously a
// throwaway test file, so pointing this at the wrong URL by mistake fails
// loudly instead of wiping every user row.
function assertThrowawayDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/test-.*\.db/.test(url)) {
    console.error(
      "❌ refusing to run: DATABASE_URL does not look like a throwaway test DB " +
        `(got: ${url || "<unset>"}).\n` +
        "   This script calls prisma.user.deleteMany(). Set DATABASE_URL to a file " +
        "matching /test-.*\\.db/, e.g.:\n" +
        '   DATABASE_URL="file:$(pwd)/prisma/test-default-voice.db?connection_limit=1" ' +
        "npx tsx scripts/verify-default-voice-provider.ts",
    );
    process.exit(1);
  }
}

async function main() {
  assertThrowawayDatabase();

  await prisma.user.deleteMany();

  // 1) A fresh User row created with no explicit ttsProvider reads back "gemini"
  //    (proves the Prisma column @default is "gemini", not "elevenlabs").
  const fresh = await prisma.user.create({
    data: { name: "fresh", email: "fresh@t.test" },
  });
  assert(fresh.ttsProvider === "gemini", "fresh User row with no explicit ttsProvider defaults to 'gemini'");

  // 2) parseTtsProvider(null) → "gemini"
  assert(parseTtsProvider(null) === "gemini", "parseTtsProvider(null) → 'gemini'");
  assert(parseTtsProvider(undefined) === "gemini", "parseTtsProvider(undefined) → 'gemini'");

  // 3) Backfill: exercise the ACTUAL shipped function, not a re-implementation.
  await prisma.user.deleteMany();
  const noKey = await prisma.user.create({
    data: { name: "no-key", email: "nokey@t.test", ttsProvider: "elevenlabs", elevenlabsKey: null },
  });
  const withKey = await prisma.user.create({
    data: { name: "with-key", email: "withkey@t.test", ttsProvider: "elevenlabs", elevenlabsKey: "sk-real-key" },
  });
  const whitespaceKey = await prisma.user.create({
    data: { name: "whitespace-key", email: "wskey@t.test", ttsProvider: "elevenlabs", elevenlabsKey: "   " },
  });
  const alreadyGemini = await prisma.user.create({
    data: { name: "already-gemini", email: "gemini@t.test", ttsProvider: "gemini" },
  });

  // Dry-run first: must not write.
  const dryRun = await backfillTtsProviderToGemini("dry-run");
  assert(dryRun.matched === 2, "dry-run matches 2 rows (no-key + whitespace-key)");
  assert(dryRun.updated === 0, "dry-run reports updated=0");
  const afterDryRun = await prisma.user.findUnique({ where: { id: noKey.id } });
  assert(afterDryRun!.ttsProvider === "elevenlabs", "dry-run wrote nothing — row still 'elevenlabs'");

  const firstApply = await backfillTtsProviderToGemini("apply");
  assert(firstApply.updated === 2, "apply updates exactly 2 rows (no-key + whitespace-key) on first run");

  const afterNoKey = await prisma.user.findUnique({ where: { id: noKey.id } });
  assert(afterNoKey!.ttsProvider === "gemini", "backfill: (elevenlabs, elevenlabsKey=NULL) → 'gemini'");

  const afterWhitespace = await prisma.user.findUnique({ where: { id: whitespaceKey.id } });
  assert(afterWhitespace!.ttsProvider === "gemini", "backfill: (elevenlabs, elevenlabsKey='   ') → 'gemini' (TRIM handles whitespace)");

  const afterWithKey = await prisma.user.findUnique({ where: { id: withKey.id } });
  assert(afterWithKey!.ttsProvider === "elevenlabs", "backfill: (elevenlabs, elevenlabsKey=<set>) → UNCHANGED");

  const afterAlreadyGemini = await prisma.user.findUnique({ where: { id: alreadyGemini.id } });
  assert(afterAlreadyGemini!.ttsProvider === "gemini", "backfill: (gemini, …) → unchanged");

  // 4) Idempotent: running the backfill a second time changes nothing further.
  const secondApply = await backfillTtsProviderToGemini("apply");
  assert(secondApply.updated === 0, "running the backfill twice changes nothing (idempotent)");

  // 5) resolveJobTtsProvider
  assert(resolveJobTtsProvider(undefined, "gemini") === "gemini", 'resolveJobTtsProvider(undefined, "gemini") → "gemini"');
  assert(resolveJobTtsProvider("elevenlabs", "gemini") === "elevenlabs", 'resolveJobTtsProvider("elevenlabs", "gemini") → "elevenlabs"');

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} DEFAULT-VOICE-PROVIDER CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
