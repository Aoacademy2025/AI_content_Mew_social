import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-profile-library-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    pinProjectBrandRevision,
    publishBrandProfileDraft,
    reconcileBrandProfileAvailability,
    saveBrandProfileDraft,
  } = await import("../src/lib/brand-profile-library.server");

  const user = await prisma.user.create({
    data: { name: "Brand owner", email: "brand-owner@example.test", plan: "PRO" },
  });
  const profile = await prisma.brandProfile.create({
    data: {
      userId: user.id,
      name: "Mewsocial",
      niche: "creator education",
      audience: "Thai creators",
      tone: "direct and energetic",
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Pinned launch video" },
  });

  const basePayload = {
    schemaVersion: 1 as const,
    name: "Mewsocial",
    niche: "creator education",
    audience: "Thai creators",
    script: {
      styleId: null,
      tone: "direct and energetic",
      bannedWords: [],
      ctaStyle: "follow",
      language: "th",
      analysisNotes: "Short hook, direct explanation, one concrete CTA",
      sampleText: "Creator writing sample retained for the next script",
    },
    voice: { provider: "elevenlabs", voiceId: "voice-main" },
    subtitle: {
      presetId: null,
      config: { fontFamily: "Kanit", preset: "stroke", effect: "karaoke", accentColor: "#38BDF8" },
    },
    brandMark: { assetId: null, enabled: true, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "stick-figure-story" as const,
      palette: ["#111111", "#F8F5EE", "#38BDF8"],
      personality: "bold raw energetic",
      peopleAndSetting: "Thai creator contexts",
      memorableCues: ["blue marker circle", "blue marker arrow"],
      visualNotes: "thick imperfect marker lines",
      defaultTreatment: "clear and energetic",
    },
  };

  await saveBrandProfileDraft({ userId: user.id, profileId: profile.id, payload: basePayload });
  const revisionOne = await publishBrandProfileDraft({ userId: user.id, profileId: profile.id });
  assert.equal(revisionOne.version, 1);
  const publishedProfile = await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } });
  assert.equal(publishedProfile.analysisNotes, basePayload.script.analysisNotes);
  assert.equal(publishedProfile.sampleText, basePayload.script.sampleText);

  await pinProjectBrandRevision({
    userId: user.id,
    projectId: project.id,
    profileId: profile.id,
  });

  await saveBrandProfileDraft({
    userId: user.id,
    profileId: profile.id,
    payload: {
      ...basePayload,
      visual: { ...basePayload.visual, palette: ["#111111", "#F8F5EE", "#FF5C35"] },
    },
  });
  const revisionTwo = await publishBrandProfileDraft({ userId: user.id, profileId: profile.id });
  assert.equal(revisionTwo.version, 2);

  const pinnedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(
    pinnedProject.brandProfileRevisionId,
    revisionOne.id,
    "publishing a new profile revision must not silently move an existing project",
  );
  const storedRevisionOne = await prisma.brandProfileRevision.findUniqueOrThrow({ where: { id: revisionOne.id } });
  assert.deepEqual(JSON.parse(storedRevisionOne.payloadJson).visual.palette, ["#111111", "#F8F5EE", "#38BDF8"]);

  const overflowProfile = await prisma.brandProfile.create({
    data: {
      userId: user.id,
      name: "Second channel",
      niche: "finance",
      audience: "first-jobbers",
      tone: "friendly",
    },
  });
  await saveBrandProfileDraft({
    userId: user.id,
    profileId: overflowProfile.id,
    payload: { ...basePayload, name: "Second channel" },
  });
  const overflowRevision = await publishBrandProfileDraft({ userId: user.id, profileId: overflowProfile.id });
  const legacyProject = await prisma.editorProject.create({
    data: {
      userId: user.id,
      title: "Legacy client work",
      brandProfileRevisionId: overflowRevision.id,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
  await reconcileBrandProfileAvailability({ userId: user.id, preferredProfileId: profile.id });

  const availability = await prisma.brandProfile.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
  });
  assert.equal(availability.find((item) => item.id === profile.id)?.frozenAt, null);
  assert.ok(availability.find((item) => item.id === overflowProfile.id)?.frozenAt);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: legacyProject.id } })).brandProfileRevisionId,
    overflowRevision.id,
    "downgrade must preserve old project revision pins",
  );

  const newProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "New free project" },
  });
  await assert.rejects(
    pinProjectBrandRevision({
      userId: user.id,
      projectId: newProject.id,
      profileId: overflowProfile.id,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "FROZEN"),
  );

  await prisma.$disconnect();
  console.log("verify-brand-profile-library: PASS revision pinning + downgrade freeze");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
