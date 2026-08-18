/**
 * Repair the one reviewed Mewsocial Real palette after the Brand Visual helper
 * stored descriptive prose instead of HEX, then publish immutable revision 6.
 *
 * Dry-run on production:
 *   npx tsx scripts/ops-repair-mewsocial-real-palette.ts
 * Apply after a fresh DB backup:
 *   RUN=1 npx tsx scripts/ops-repair-mewsocial-real-palette.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  brandProfilePayloadSchema,
  publishBrandProfileDraft,
  saveBrandProfileDraft,
} from "../src/lib/brand-profile-library.server";

const RUN = process.env.RUN === "1";
const USER_EMAIL = "duckyhero@gmail.com";
const PROFILE_ID = "cmsmpktdh0001lczvews1v226";
const EXPECTED_VERSION = 5;
const INVALID_PALETTE = [
  "high-contrast carbon black",
  "warm paper white",
  "vivid sky blue #38BDF8 used only as a sharp accent",
];
const REPAIRED_PALETTE = ["#111111", "#F8F5EE", "#38BDF8"];

async function main() {
  const profile = await prisma.brandProfile.findFirst({
    where: {
      id: PROFILE_ID,
      user: { email: USER_EMAIL },
      archivedAt: null,
    },
    include: { draft: true },
  });
  if (!profile?.draft) throw new Error("reviewed Mewsocial Real draft was not found");
  const current = JSON.parse(profile.draft.payloadJson) as {
    name?: unknown;
    visual?: { palette?: unknown };
  };
  if (current.name !== "Mewsocial Real") throw new Error("profile name guard failed");
  const currentPaletteJson = JSON.stringify(current.visual?.palette);
  const invalidPaletteJson = JSON.stringify(INVALID_PALETTE);
  const repairedPaletteJson = JSON.stringify(REPAIRED_PALETTE);

  if (profile.activeRevisionNumber === EXPECTED_VERSION + 1) {
    if (
      profile.draft.baseRevisionNumber !== EXPECTED_VERSION + 1
      || currentPaletteJson !== repairedPaletteJson
    ) {
      throw new Error("published repair does not match the reviewed revision 6 state");
    }
    const published = await prisma.brandProfileRevision.findUnique({
      where: {
        brandProfileId_version: {
          brandProfileId: profile.id,
          version: EXPECTED_VERSION + 1,
        },
      },
    });
    if (!published) throw new Error("published revision 6 was not found");
    const stored = brandProfilePayloadSchema.parse(JSON.parse(published.payloadJson));
    if (JSON.stringify(stored.visual.palette) !== repairedPaletteJson) {
      throw new Error("published revision 6 palette verification failed");
    }
    console.log(JSON.stringify({
      repaired: true,
      replayed: true,
      profileId: profile.id,
      revisionId: published.id,
      revision: published.version,
      palette: stored.visual.palette,
    }));
    return;
  }
  if (
    profile.activeRevisionNumber !== EXPECTED_VERSION
    || profile.draft.baseRevisionNumber !== EXPECTED_VERSION
  ) {
    throw new Error(
      `revision guard failed: active=${profile.activeRevisionNumber} draftBase=${profile.draft.baseRevisionNumber}`,
    );
  }
  if (currentPaletteJson !== invalidPaletteJson && currentPaletteJson !== repairedPaletteJson) {
    throw new Error("palette guard failed: the creator changed this draft after review");
  }
  const payload = brandProfilePayloadSchema.parse({
    ...current,
    visual: { ...current.visual, palette: REPAIRED_PALETTE },
  });
  console.log(JSON.stringify({
    mode: RUN ? "apply" : "dry-run",
    profileId: PROFILE_ID,
    fromVersion: EXPECTED_VERSION,
    toVersion: EXPECTED_VERSION + 1,
    draftAlreadyRepaired: currentPaletteJson === repairedPaletteJson,
    palette: payload.visual.palette,
  }));
  if (!RUN) return;

  if (currentPaletteJson !== repairedPaletteJson) {
    await saveBrandProfileDraft({ userId: profile.userId, profileId: profile.id, payload });
  }
  const revision = await publishBrandProfileDraft({ userId: profile.userId, profileId: profile.id });
  if (revision.version !== EXPECTED_VERSION + 1) {
    throw new Error(`unexpected published revision ${revision.version}`);
  }
  const stored = brandProfilePayloadSchema.parse(JSON.parse(revision.payloadJson));
  if (JSON.stringify(stored.visual.palette) !== repairedPaletteJson) {
    throw new Error("published palette verification failed");
  }
  console.log(JSON.stringify({
    repaired: true,
    profileId: profile.id,
    revisionId: revision.id,
    revision: revision.version,
    palette: stored.visual.palette,
  }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
