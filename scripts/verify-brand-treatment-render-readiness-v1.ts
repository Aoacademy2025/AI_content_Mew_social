import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-treatment-readiness-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");
  const {
    parseProjectVisualContext,
    prepareProjectVisualSnapshotAwaitingPreflight,
  } = await import("../src/lib/project-look.server");
  const { ensureVideoJobContentPreflight } = await import("../src/lib/video-job-content-preflight.server");

  const user = await prisma.user.create({
    data: { name: "Waiting render", email: "waiting-render@example.test", plan: "PRO" },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Render while planning" },
  });
  const pending = await prepareProjectVisualSnapshotAwaitingPreflight({
    userId: user.id,
    projectId: project.id,
    narrativeSourceKind: "creator-script",
  });
  assert.equal(pending.contentPreflightId, null);
  assert.equal(parseProjectVisualContext(pending.projectVisualContextJson), null);
  assert.doesNotMatch(pending.projectVisualContextJson, /ชัดเจนและเหมาะกับเนื้อหา/);
  assert.match(pending.projectVisualContextJson, /awaiting-content-preflight/);

  const job = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      projectVisualContextJson: pending.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  const resolved = await ensureVideoJobContentPreflight({
    actor: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
    projectId: project.id,
    videoJobId: job.id,
    narrativeSource: {
      kind: "creator-script",
      text: "เรื่องผีไทยดำเนินต่อเนื่องในงานศพกลางคืน",
      windowCount: 1,
    },
    brandVisualAccepted: true,
  }, {
    resolve: async (input) => {
      const preflight = await prisma.contentPreflight.create({
        data: {
          userId: input.userId,
          projectId: input.projectId,
          narrativeSourceKind: "creator-script",
          sourceHash: "worker-ready-hash",
          analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
          contentDomain: "Thai supernatural story",
          dominantNarrativeMode: "continuing supernatural narrative",
          suggestedVisualFormatId: "cinematic-realism",
          suggestedTreatmentJson: JSON.stringify({ label: "หนังผีไทย", mood: "frightening" }),
          suggestedTreatmentPresetId: "thai-supernatural-horror",
          suggestedTreatmentPresetVersion: "v1.0.0",
          rankedTreatmentPresetIdsJson: JSON.stringify([
            "thai-supernatural-horror", "thai-human-drama", "thai-history-period-storytelling",
          ]),
          treatmentRecommendationRationale: "The supernatural frame continues.",
          storyEntitiesJson: "[]",
          visualBeats: {
            create: {
              userId: input.userId,
              projectId: input.projectId,
              beatKey: "window-0",
              sequence: 0,
              sourceExcerptHash: "worker-beat-hash",
              beatJson: JSON.stringify({
                beatKey: "window-0", sourceExcerpt: "งานศพกลางคืน", subject: "a Thai mourner",
                action: "stands beside a coffin", setting: "a funeral pavilion at night", emotion: "dread",
                emphasis: "a supernatural presence", hardSceneFacts: {
                  entityTypes: ["Thai mourner"], ages: [], genders: [], actions: ["stands beside a coffin"],
                  locationTypes: ["funeral pavilion"], timeOfDay: "night", historicalPeriod: null,
                  count: 1, essentialObjects: ["coffin"],
                }, entityRefs: [], sceneIntensity: "escalating tension", safetyBoundary: "none",
              }),
            },
          },
        },
        include: { visualBeats: true },
      });
      return {
        id: preflight.id,
        sourceHash: preflight.sourceHash,
        contentDomain: preflight.contentDomain,
        dominantNarrativeMode: preflight.dominantNarrativeMode!,
        suggestedVisualFormatId: "cinematic-realism" as const,
        suggestedTreatment: {
          kind: "catalog" as const,
          presetId: "thai-supernatural-horror" as const,
          version: "v1.0.0",
          source: "adaptive" as const,
          label: "หนังผีไทย",
          rationale: "The supernatural frame continues.",
        },
        rankedTreatmentPresetIds: [
          "thai-supernatural-horror", "thai-human-drama", "thai-history-period-storytelling",
        ] as const,
        storyEntities: [],
        formatRecommendation: null,
        visualBeats: [],
        sceneContentPolicy: { locale: "narrative" as const, people: "narrative" as const },
        policyWarnings: [],
        cached: false,
      } as never;
    },
    createAnalyzer: () => ({ analyze: async () => { throw new Error("not used"); } }),
  });
  assert.equal(resolved.kind, "resolved");
  const pinnedJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.ok(pinnedJob.contentPreflightId);
  assert.equal(
    parseProjectVisualContext(pinnedJob.projectVisualContextJson)?.treatmentPin?.presetId,
    "thai-supernatural-horror",
  );

  const failedProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Failed planning" },
  });
  const failedPending = await prepareProjectVisualSnapshotAwaitingPreflight({
    userId: user.id,
    projectId: failedProject.id,
    narrativeSourceKind: "creator-script",
  });
  const failedJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: failedProject.id,
      projectVisualContextJson: failedPending.projectVisualContextJson,
      inputJson: "{}",
    },
  });
  await assert.rejects(() => ensureVideoJobContentPreflight({
    actor: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
    projectId: failedProject.id,
    videoJobId: failedJob.id,
    narrativeSource: { kind: "creator-script", text: "analysis fails", windowCount: 1 },
    brandVisualAccepted: true,
  }, {
    resolve: async () => { throw new Error("provider attempts exhausted"); },
    createAnalyzer: () => ({ analyze: async () => { throw new Error("provider attempts exhausted"); } }),
  }));
  assert.equal(await prisma.aiGenerationJob.count({ where: { userId: user.id } }), 0);
  assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: failedJob.id } })).contentPreflightId, null);

  const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  const scriptPlanningAt = orchestratorSource.indexOf("await ensureVideoJobContentPreflight({");
  const scriptKeywordsAt = orchestratorSource.indexOf('await step("keywords", 40)', scriptPlanningAt);
  assert.ok(scriptPlanningAt >= 0 && scriptPlanningAt < scriptKeywordsAt,
    "worker planning resolves before keyword and image-provider work");

  await prisma.$disconnect();
  console.log("verify-brand-treatment-render-readiness-v1: PASS accept-and-wait, worker pin, fail before image charge");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
