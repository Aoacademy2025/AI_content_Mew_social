import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "project-look-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { clearProjectLook, resolveProjectVisualContext, saveProjectLook } = await import(
    "../src/lib/project-look.server"
  );
  const user = await prisma.user.create({ data: { name: "Look owner", email: "look@example.test" } });
  const profile = await prisma.brandProfile.create({
    data: { userId: user.id, name: "Blue brand", niche: "education", audience: "creators", tone: "bold" },
  });
  const revision = await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: profile.id,
      version: 1,
      payloadJson: "{}",
      visualRecipeJson: JSON.stringify({
        schemaVersion: 1,
        visualFormatId: "stick-figure-story",
        recipeVersion: "stick-figure-story-v1",
        brandVisualLanguage: {
          palette: ["#111111", "#38BDF8"],
          personality: "bold handmade",
          peopleAndSetting: "Thai creator contexts",
          memorableCues: ["blue marker arrow"],
          visualNotes: "rough lines",
        },
        defaultTreatment: "energetic",
      }),
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Override test", brandProfileRevisionId: revision.id },
  });

  const branded = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(branded.source, "brand-revision");
  assert.equal(branded.visualFormatId, "stick-figure-story");

  const saved = await saveProjectLook({
    userId: user.id,
    projectId: project.id,
    look: { visualFormatId: "dramatic-comic", treatment: "urgent but trustworthy" },
  });
  assert.equal(saved.visualFormatId, "dramatic-comic");
  assert.equal(saved.recipeVersion, "dramatic-comic-v1", "project stores a resolved recipe snapshot");
  const overridden = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(overridden.source, "project-look");
  assert.equal(overridden.visualFormatId, "dramatic-comic", "creator override wins over AI suggestion and brand");
  assert.deepEqual(overridden.brandVisualLanguage?.palette, ["#111111", "#38BDF8"], "brand language remains beneath the project format override");
  assert.equal((await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } })).brandProfileRevisionId, revision.id);

  await clearProjectLook({ userId: user.id, projectId: project.id });
  const restored = await resolveProjectVisualContext({
    userId: user.id,
    projectId: project.id,
    suggested: { visualFormatId: "clear-infographic", treatment: "calm" },
  });
  assert.equal(restored.source, "brand-revision");

  await prisma.$disconnect();
  console.log("verify-project-look: PASS snapshot + creator precedence + clear");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
