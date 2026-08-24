import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyPostExportEditStateResume } from "./editor-project-job-runtime-harness";
import {
  createEditorExportSnapshot,
  parseEditorExportSnapshot,
} from "../src/lib/editor-export-snapshot";
import { restorePostExportEditorState } from "../src/app/(dashboard)/video-editor/_v2/export-edit-state";

function verifyDurableSnapshotContract(): void {
  const originalCaptions = [{ text: "original", startMs: 0, endMs: 1_000 }];
  const latestCaptions = [{ text: "latest edited caption", startMs: 0, endMs: 1_000 }];
  const snapshot = createEditorExportSnapshot({
    draft: {
      version: 1,
      captions: latestCaptions,
      originalCaptions,
      subtitleConfig: {
        preset: "stroke",
        effect: "pop",
        fontFamily: "Kanit",
        bold: true,
        fontWeight: 900,
        fontSize: 80,
        textColor: "#FFFFFF",
        accentColor: "#FFE500",
        shadow: true,
        outline: false,
        outlineSize: 2,
        verticalPos: 82,
      },
      cardLen: "sentence",
      captionOverrides: { 0: { textColor: "#38BDF8" } },
    },
    sourcePreview: {
      captions: originalCaptions,
      config: { bgVideos: [] },
      voiceUrl: "/api/audio/voice.mp3",
      audioDurationMs: 1_000,
    },
    videoUrl: "/api/videos/latest-preview.mp4",
  });
  assert.ok(snapshot, "the server can compose a durable snapshot from a valid editor draft");
  assert.deepEqual(snapshot.preview.captions, latestCaptions, "latest captions replace the stale source captions");
  assert.deepEqual(
    parseEditorExportSnapshot(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
    "the output reader preserves the snapshot after a durable JSON round trip",
  );
  const restored = restorePostExportEditorState({
    phase: "done",
    jobId: "export-job",
    jobType: "export",
    projectId: "project",
    currentStep: "save",
    progress: 100,
    queuePosition: null,
    errorMessage: null,
    errorCode: null,
    errorProvider: null,
    output: {
      version: 2,
      videoUrl: "/api/videos/final.mp4",
      sourceJobId: "source-preview-job",
      editSnapshot: snapshot,
    },
    mediaState: { status: "available" },
  }, null);
  assert.equal(restored?.jobId, "source-preview-job");
  assert.equal(restored?.jobType, "create");
  assert.equal(restored?.output?.videoUrl, "/api/videos/latest-preview.mp4");
  assert.deepEqual(restored?.output?.preview?.captions, latestCaptions);
  assert.equal(
    restorePostExportEditorState({ ...restored!, output: { version: 2 } }, "legacy-source"),
    null,
    "rows without a snapshot remain on the legacy polling path",
  );
  assert.equal(
    createEditorExportSnapshot({
      draft: { ...snapshot, subtitleConfig: { preset: "missing-required-fields" } },
      sourcePreview: snapshot.preview,
      videoUrl: snapshot.videoUrl,
    }),
    null,
    "malformed browser-owned editor state fails closed before job creation",
  );

  const wires = [
    ["src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts", "editorSnapshot:"],
    ["src/app/api/videos/jobs/route.ts", "createEditorExportSnapshot({"],
    ["src/lib/mcp/orchestrator.ts", "editSnapshot: input.editSnapshot"],
    ["src/lib/mcp/video-job.ts", "parseEditorExportSnapshot(raw.editSnapshot)"],
    ["src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "restorePostExportEditorState(job, p.activeJobId)"],
  ] as const;
  for (const [file, marker] of wires) {
    assert.match(readFileSync(file, "utf8"), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

verifyDurableSnapshotContract();
void verifyPostExportEditStateResume()
  .then(() => console.log("post-export edit-state runtime: OK"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
