import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "first-clip-path-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.match(jobsRoute, /ensureFirstClipProjectSpine/, "job create pins First-Clip Brand Profile Revision");
  assert.match(jobsRoute, /resolveFirstClipPath/, "job create consults First-Clip Path");
  assert.match(jobsRoute, /first_clip_script_required/, "First-Clip Path rejects upload/cutaway");
  assert.match(jobsRoute, /onFirstClipPath && projectId && !uploadMode/, "First-Clip Path snapshots awaiting Content Preflight");
  const sidebar = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  assert.doesNotMatch(
    sidebar,
    /item\.href !== "\/hero-script" \|\| \(!firstClipPath/,
    "First-Clip Path must not hide the paid Hero Script entrypoint",
  );
  assert.match(sidebar, /ทดลอง PRO/, "Conversion Trial has an honest plan label");
  assert.match(
    sidebar,
    /data\.effectivePlan \?\? data\.plan/,
    "Sidebar plan label uses entitlement-backed effectivePlan",
  );
  const dashboard = readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8");
  assert.match(dashboard, /ทดลอง PRO/, "Dashboard does not present Conversion Trial as a paid Pro Plan");
  const userStatsRoute = readFileSync("src/app/api/user/stats/route.ts", "utf8");
  assert.match(userStatsRoute, /resolvePaidEquivalentEntitlement/, "Dashboard stats resolve durable paid evidence");
  assert.match(userStatsRoute, /classifyEntitlement/, "Dashboard stats downgrade expired Trial labels");
  assert.doesNotMatch(userStatsRoute, /const plan = user\?\.plan/, "Dashboard stats do not trust the raw plan label");
  const supportModal = readFileSync("src/components/ui/support-modal.tsx", "utf8");
  assert.match(supportModal, /ทดลอง PRO/, "Support context distinguishes Conversion Trial from paid Pro");
  assert.match(
    supportModal,
    /d\?\.effectivePlan \?\? d\?\.plan/,
    "Support context uses entitlement-backed effectivePlan",
  );
  const heroLayout = readFileSync("src/app/(dashboard)/hero-script/layout.tsx", "utf8");
  assert.doesNotMatch(
    heroLayout,
    /resolveFirstClipPath|firstClip\.onPath/,
    "First-Clip Path must not redirect an entitled Hero Script visitor",
  );
  const brandsLayout = readFileSync("src/app/(dashboard)/brands/layout.tsx", "utf8");
  assert.match(brandsLayout, /redirect\("\/video-editor"\)/, "brands redirects while on the path");
  const editor = readFileSync("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "utf8");
  assert.match(editor, /firstClipPath=\{firstClipPath\}/, "editor passes First-Clip Path into the script rail");
  assert.match(editor, /คลิปแรก: วางสคริปต์แล้วกดสร้าง/, "editor shows the First-Clip Path banner");
  const orchestrator = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  assert.match(orchestrator, /awaiting-content-preflight/, "worker runs Content Preflight from the awaiting snapshot");
  assert.match(orchestrator, /first_clip_preflight_fail_open/, "first-clip Content Preflight is fail-open");

  const { prisma } = await import("../src/lib/prisma");
  const {
    resolveFirstClipPath,
    ensureFirstClipBrandRevision,
    ensureFirstClipProjectSpine,
    ensureFirstClipContentPreflight,
  } = await import("../src/lib/first-clip-path.server");
  const { createEditorProject } = await import("../src/lib/editor-projects");
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86_400_000);

  const grantor = await prisma.user.create({
    data: { id: "grantor", name: "Grantor", email: "grantor@example.invalid", role: "USER", plan: "PRO" },
  });
  const user = await prisma.user.create({
    data: { id: "clip-user", name: "Clip", email: "clip@example.invalid", role: "USER", plan: "PRO" },
  });
  await prisma.administratorGrant.create({
    data: {
      userId: user.id,
      plan: "PRO",
      reason: "first-clip-path verify",
      startsAt: now,
      expiresAt: future,
      grantedById: grantor.id,
    },
  });

  const before = await resolveFirstClipPath({ id: user.id, email: user.email, role: user.role });
  assert.equal(before.onPath, true, "paid-equivalent with no video is on the path");

  const starter = await ensureFirstClipBrandRevision(user.id);
  assert.equal(starter.created, true);
  assert.equal(starter.profile.name, "คลิปแรก");
  assert.ok(starter.revision.id);

  const again = await ensureFirstClipBrandRevision(user.id);
  assert.equal(again.created, false, "existing profile is reused");
  assert.equal(again.profile.id, starter.profile.id);

  const project = await createEditorProject(user.id, { title: "First clip" });
  const pin = await ensureFirstClipProjectSpine({ userId: user.id, projectId: project.id });
  const pinned = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(pinned.brandProfileRevisionId, pin.revisionId);

  const script = "วางสคริปต์คลิปแรกตรงนี้\nแล้วกดสร้างได้เลย";
  const preflight = await ensureFirstClipContentPreflight({
    userId: user.id,
    projectId: project.id,
    script,
    analyzer: {
      async analyze(input) {
        return {
          contentDomain: "short form creator clip",
          dominantNarrativeMode: "direct spoken explanation",
          suggestedVisualFormatId: "clear-infographic" as const,
          rankedTreatmentPresetIds: [
            "expert-clarity",
            "practical-documentary",
            "modern-business-technology",
          ] as const,
          treatmentRecommendationRationale: "The source is a practical first-clip explanation.",
          formatRecommendation: null,
          storyEntities: [],
          beats: input.windows.map((window, index) => ({
            beatKey: `window-${index}`,
            sourceExcerpt: window.text.slice(0, 200) || "first clip",
            subject: "a creator and a simple visual",
            action: "explains one idea",
            setting: "a clean desk",
            emotion: "clear focus",
            emphasis: "the first clip",
            hardSceneFacts: {
              entityTypes: ["creator"],
              ages: [],
              genders: [],
              actions: ["explains one idea"],
              locationTypes: ["desk"],
              timeOfDay: null,
              historicalPeriod: null,
              count: 1,
              essentialObjects: [],
            },
            entityRefs: [],
            sceneIntensity: "clear",
            safetyBoundary: "none" as const,
          })),
        };
      },
    },
  });
  assert.equal(preflight.skipped, false, "Content Preflight actually ran");
  assert.ok(preflight.preflightId);
  const storedPreflight = await prisma.contentPreflight.findUniqueOrThrow({
    where: { id: preflight.preflightId! },
  });
  assert.equal(storedPreflight.projectId, project.id);

  await prisma.video.create({
    data: {
      userId: user.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/first.mp4",
    },
  });
  const after = await resolveFirstClipPath({ id: user.id, email: user.email, role: user.role });
  assert.equal(after.onPath, false);
  assert.equal(after.reason, "has_completed_video");

  await prisma.$disconnect();
  console.log("verify-first-clip-path-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
