// Backfill: default TTS provider was historically stamped "elevenlabs" via the
// Prisma column default even though Gemini is the zero-setup managed provider.
// This rewrites ONLY accounts that never proved an ElevenLabs intent — an
// account holding an ElevenLabs key (including a whitespace-only one) is
// treated as having chosen it and is left alone.
//
//   UPDATE User SET ttsProvider = 'gemini'
//   WHERE ttsProvider = 'elevenlabs'
//     AND (elevenlabsKey IS NULL OR TRIM(elevenlabsKey) = '')
//
// --dry-run (default): prints the matched count, writes nothing.
// --apply: performs the update, prints matched count before + updated count after.
//
// Run: npx tsx scripts/backfill-tts-provider-gemini.ts [--apply]
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

export type BackfillMode = "dry-run" | "apply";

export function modeFromArgs(args: string[]): BackfillMode {
  const known = new Set(["--apply", "--dry-run"]);
  if (args.some((arg) => !known.has(arg))) throw new Error("unknown backfill argument");
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("choose either --apply or --dry-run");
  }
  return args.includes("--apply") ? "apply" : "dry-run";
}

/**
 * Selects and (in "apply" mode) rewrites ttsProvider='elevenlabs' -> 'gemini'
 * for accounts that never proved an ElevenLabs intent.
 *
 * The write is a single atomic SQL UPDATE — not a JS read-ids-then-updateMany
 * — so SQLite re-evaluates the WHERE predicate per row at write time. If a
 * user saves a real ElevenLabs key between the informational "matched" count
 * and the write, that row's predicate no longer holds and the UPDATE simply
 * does not touch it; there is no window where a stale id list can blindly
 * overwrite a choice made in between. This also lets TRIM() do real work
 * (Prisma's query builder has no trim operator), so a whitespace-only key
 * counts as "has a key" as accurately as a real one.
 */
export async function backfillTtsProviderToGemini(
  mode: BackfillMode,
): Promise<{ matched: number; updated: number }> {
  const matchedRows = await prisma.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(*) as n FROM User
    WHERE ttsProvider = 'elevenlabs'
      AND (elevenlabsKey IS NULL OR TRIM(elevenlabsKey) = '')
  `;
  const matched = Number(matchedRows[0]?.n ?? 0);

  if (mode === "dry-run") {
    return { matched, updated: 0 };
  }

  const updated = await prisma.$executeRaw`
    UPDATE User SET ttsProvider = 'gemini'
    WHERE ttsProvider = 'elevenlabs'
      AND (elevenlabsKey IS NULL OR TRIM(elevenlabsKey) = '')
  `;

  return { matched, updated };
}

async function main() {
  const mode = modeFromArgs(process.argv.slice(2));
  console.log(`[backfill-tts-provider-gemini] mode=${mode}`);

  const { matched, updated } = await backfillTtsProviderToGemini(mode);
  console.log(`[backfill-tts-provider-gemini] matched (elevenlabs, no key): ${matched}`);

  if (mode === "dry-run") {
    console.log("[backfill-tts-provider-gemini] dry-run — no rows written. Pass --apply to write.");
  } else if (matched === 0) {
    console.log("[backfill-tts-provider-gemini] nothing to update.");
  } else {
    console.log(`[backfill-tts-provider-gemini] updated: ${updated}`);
  }

  await prisma.$disconnect();
}

// Guard the CLI entrypoint so importing this module (e.g. from the verify
// script) does not also run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
