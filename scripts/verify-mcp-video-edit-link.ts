// verify-mcp-video-edit-link.ts — list_my_videos / get_video report jobId + editable so an
// agent resuming an earlier clip in a NEW chat can jump straight to the MCP edit tools without
// the chain id from the original create_video_job call.
//
//   - a video produced by a Held Preview chain (export or B-roll re-render carrying
//     `inputJson.mcpRootJobId`) reports jobId = the held root's id, editable = true once that
//     root has finished (the exact condition `resolveHeldRoot`/`get_edit_state` itself checks);
//   - a video produced by the ADR-0063 auto-chain (non-hold) export reports jobId = the
//     preview's id, editable = false (an auto chain never supports held editing);
//   - a video with no owning MCP job at all (made in the web editor, or a plain non-chain
//     create) reports jobId = null, editable = false;
//   - another user's chain is never returned, even by id;
//   - get_edit_state(videoId) — a Video id, not a jobId — keeps error code "invalid_input" but
//     points the agent at list_my_videos/get_video instead of the generic "use exportMode hold"
//     hint.
//
// Self-contained: builds its own throwaway SQLite. No HTTP/orchestrator — fixtures are written
// directly through Prisma, exactly the shape finishJobWithTransition/persistExportGalleryVideo
// leave behind, so the test exercises resolveMcpVideoEditLinks / listMyVideosTool / getVideoTool
// / resolveHeldRoot against real rows instead of re-deriving their own expectations.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-video-edit-link.ts

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mcp-video-edit-link-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { resolveMcpVideoEditLinks } = await import("../src/lib/mcp/chain-export");
  const { mcpChainExportKey } = await import("../src/lib/mcp/chain-key");
  const { listMyVideosTool, getVideoTool } = await import("../src/lib/mcp/tools");
  const { resolveHeldRoot, getEditStateTool } = await import("../src/lib/mcp/edit-tools");

  const now = new Date();
  async function makeUser(id: string, email: string) {
    await prisma.user.create({
      data: {
        id, name: id, email,
        plan: "PRO", minutesLimit: 80, minutesUsed: 0,
        usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
      },
    });
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }

  async function makeVideo(userId: string, id: string) {
    return prisma.video.create({
      data: {
        id, userId, avatarModel: "none", voiceModel: "gemini", sceneCount: 1,
        status: "COMPLETED", script: "test",
      },
    });
  }

  const u1 = await makeUser("u-edit-link-1", "edit-link-1@example.com");
  const u2 = await makeUser("u-edit-link-2", "edit-link-2@example.com");

  await section("fixture: Held Preview chain (root done, export carries videoId)", async () => {
    const project = await prisma.editorProject.create({ data: { userId: u1.id } });
    const root = await prisma.videoJob.create({
      data: {
        userId: u1.id, projectId: project.id, type: "create", status: "done",
        inputJson: JSON.stringify({ mcpHold: true, script: "held root" }),
      },
    });
    const video = await makeVideo(u1.id, "video-held-done");
    const exportJob = await prisma.videoJob.create({
      data: {
        userId: u1.id, projectId: project.id, type: "export", status: "done",
        idempotencyKey: `mcp-export:${root.id}:0`,
        inputJson: JSON.stringify({ mode: "export", sourceJobId: root.id, mcpRootJobId: root.id }),
        videoId: video.id,
      },
    });

    const links = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks: jobId = held root id", links.get(video.id)?.jobId === root.id);
    check("resolveMcpVideoEditLinks: editable = true (root done)", links.get(video.id)?.editable === true);

    const listed = await listMyVideosTool(u1.id, {});
    const row = listed.find((v) => v.id === video.id);
    check("list_my_videos: row present", !!row);
    check("list_my_videos: jobId = held root id", row?.jobId === root.id);
    check("list_my_videos: editable = true", row?.editable === true);

    const got = await getVideoTool(u1.id, video.id);
    check("get_video: found", got.found === true);
    check("get_video: jobId = held root id", (got as { jobId?: string | null }).jobId === root.id);
    check("get_video: editable = true", (got as { editable?: boolean }).editable === true);

    const held = await resolveHeldRoot(u1.id, root.id);
    check("resolveHeldRoot(root.id): ok", held.ok === true);
    if (held.ok) check("resolveHeldRoot(root.id): same root", held.root.id === root.id);

    void exportJob;
  });

  await section("fixture: Held Preview chain, root still rendering (not editable yet)", async () => {
    const project = await prisma.editorProject.create({ data: { userId: u1.id } });
    const root = await prisma.videoJob.create({
      data: {
        userId: u1.id, projectId: project.id, type: "create", status: "processing",
        inputJson: JSON.stringify({ mcpHold: true, script: "held root in flight" }),
      },
    });
    // A re-render that happens to have landed a videoId before the root itself is done is not
    // a real production shape, but resolveMcpVideoEditLinks must still answer purely from the
    // root's own status, not assume done.
    const video = await makeVideo(u1.id, "video-held-inflight");
    await prisma.videoJob.create({
      data: {
        userId: u1.id, projectId: project.id, type: "export", status: "processing",
        idempotencyKey: `mcp-export:${root.id}:0`,
        inputJson: JSON.stringify({ mode: "export", sourceJobId: root.id, mcpRootJobId: root.id }),
        videoId: video.id,
      },
    });

    const links = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks: jobId = held root id even in flight", links.get(video.id)?.jobId === root.id);
    check("resolveMcpVideoEditLinks: editable = false (root not done)", links.get(video.id)?.editable === false);
  });

  await section("fixture: ADR-0063 auto-chain export (non-hold) — jobId = preview, never editable", async () => {
    const preview = await prisma.videoJob.create({
      data: {
        userId: u1.id, type: "create", status: "done",
        inputJson: JSON.stringify({ mcpChainExport: true, script: "auto chain preview" }),
      },
    });
    const video = await makeVideo(u1.id, "video-auto-chain");
    await prisma.videoJob.create({
      data: {
        userId: u1.id, type: "export", status: "done",
        idempotencyKey: mcpChainExportKey(preview.id),
        inputJson: JSON.stringify({ mode: "export", sourceJobId: preview.id }),
        videoId: video.id,
      },
    });

    const links = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks: jobId = auto-chain preview id", links.get(video.id)?.jobId === preview.id);
    check("resolveMcpVideoEditLinks: editable = false (auto chain, not held)", links.get(video.id)?.editable === false);

    const held = await resolveHeldRoot(u1.id, preview.id);
    check("resolveHeldRoot(preview.id): refused not_editable", held.ok === false && (held as { failure: { code: string } }).failure.code === "not_editable");
  });

  await section("fixture: web-editor video — no owning MCP job at all", async () => {
    const video = await makeVideo(u1.id, "video-web-made");
    // A plain web-editor export job that happens to carry this videoId, but none of the MCP
    // chain/hold markers get() must still not invent a jobId it.
    await prisma.videoJob.create({
      data: { userId: u1.id, type: "export", status: "done", inputJson: JSON.stringify({ mode: "export" }), videoId: video.id },
    });

    const links = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks: jobId = null", links.get(video.id)?.jobId === null);
    check("resolveMcpVideoEditLinks: editable = false", links.get(video.id)?.editable === false);

    const listed = await listMyVideosTool(u1.id, {});
    const row = listed.find((v) => v.id === video.id);
    check("list_my_videos: jobId = null for a web-made video", row?.jobId === null);
    check("list_my_videos: editable = false for a web-made video", row?.editable === false);

    const got = await getVideoTool(u1.id, video.id);
    check("get_video: jobId = null for a web-made video", (got as { jobId?: string | null }).jobId === null);
    check("get_video: editable = false for a web-made video", (got as { editable?: boolean }).editable === false);
  });

  await section("fixture: a video with no VideoJob row at all", async () => {
    const video = await makeVideo(u1.id, "video-no-job");
    const links = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks: no entry, caller defaults to null/false", links.get(video.id) === undefined);
  });

  await section("cross-user isolation: another user's held chain never leaks", async () => {
    const project = await prisma.editorProject.create({ data: { userId: u2.id } });
    const root = await prisma.videoJob.create({
      data: {
        userId: u2.id, projectId: project.id, type: "create", status: "done",
        inputJson: JSON.stringify({ mcpHold: true, script: "u2 held root" }),
      },
    });
    const video = await makeVideo(u2.id, "video-u2-held");
    await prisma.videoJob.create({
      data: {
        userId: u2.id, projectId: project.id, type: "export", status: "done",
        idempotencyKey: `mcp-export:${root.id}:0`,
        inputJson: JSON.stringify({ mode: "export", sourceJobId: root.id, mcpRootJobId: root.id }),
        videoId: video.id,
      },
    });

    // u1 asking about u2's video id: no job-scoped data is ever returned for it.
    const linksAsU1 = await resolveMcpVideoEditLinks(u1.id, [video.id]);
    check("resolveMcpVideoEditLinks(u1, u2's videoId): no entry", linksAsU1.get(video.id) === undefined);

    const gotAsU1 = await getVideoTool(u1.id, video.id);
    check("get_video(u1, u2's videoId): not found", gotAsU1.found === false);

    // u1 trying u2's root jobId directly through get_edit_state: unknown, not not_editable —
    // the row must not even be acknowledged to exist.
    const held = await resolveHeldRoot(u1.id, root.id);
    check(
      "resolveHeldRoot(u1, u2's root jobId): UNKNOWN_JOB (no leak)",
      held.ok === false && (held as { failure: { code: string } }).failure.code === "invalid_input",
    );

    // u1's own listing never contains u2's video.
    const listedAsU1 = await listMyVideosTool(u1.id, {});
    check("list_my_videos(u1): never contains u2's video", !listedAsU1.some((v) => v.id === video.id));
  });

  await section("get_edit_state: a Video id (not a jobId) gets the list_my_videos hint", async () => {
    const video = await makeVideo(u1.id, "video-for-hint-check");
    const reply = (await getEditStateTool(u1.id, video.id)) as { code?: string; next?: string };
    check("get_edit_state(videoId): code stays invalid_input", reply.code === "invalid_input");
    check(
      "get_edit_state(videoId): next points at list_my_videos/get_video's jobId",
      typeof reply.next === "string" && reply.next.includes("list_my_videos") && reply.next.includes("jobId"),
    );

    // A jobId that truly does not exist at all keeps the generic hint (no regression).
    const unknown = (await getEditStateTool(u1.id, "job-does-not-exist")) as { code?: string; next?: string };
    check("get_edit_state(unknown id): code stays invalid_input", unknown.code === "invalid_input");
    check(
      "get_edit_state(unknown id): generic hint, no list_my_videos mention",
      typeof unknown.next === "string" && !unknown.next.includes("list_my_videos"),
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
