// EP5 backlog #14 — the MCP Pending Edit Draft side of `tailHoldMs`. Split out of
// verify-tail-hold.ts because `pending-edit-draft.ts` transitively imports a "server-only"
// module (same reason verify-mcp-broll-window-edits.ts etc. run under
// `node --conditions=react-server`), which conflicts with that script's Remotion render (the
// Remotion package itself rejects the react-server condition). Run via
// `npm run verify:tail-hold` (chained after the plain-tsx checks).
import assert from "node:assert/strict";
import { DEFAULT_V2_SUB, type V2Caption } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import {
  parsePendingEditDraft,
  seedPendingEditDraft,
  toBurnConfig,
  type PendingEditDraft,
} from "../src/lib/mcp/pending-edit-draft";

const FPS = 30;

function main() {
  const basePreview = {
    videoUrl: "v.mp4",
    audioDurationMs: 2_000,
    captions: [{ text: "hi", startMs: 0, endMs: 2_000 }] as V2Caption[],
    config: {},
    voiceUrl: "a.mp3",
  };
  // 1) A legacy project draft JSON with no tailHoldMs at all must parse and read as 0.
  const legacyDraft: Omit<PendingEditDraft, "tailHoldMs"> = {
    version: 1,
    rootJobId: "root-1",
    baseJobId: "base-1",
    captions: basePreview.captions,
    originalCaptions: basePreview.captions,
    cardLen: "sentence",
    subtitleConfig: DEFAULT_V2_SUB,
    captionOverrides: {},
    windowEdits: [],
  };
  const parsedLegacy = parsePendingEditDraft(JSON.stringify(legacyDraft));
  assert.ok(parsedLegacy, "a legacy draft (no tailHoldMs) must still parse");
  assert.equal(parsedLegacy!.tailHoldMs, 0, "a legacy draft with no tailHoldMs reads as 0");
  console.log("✓ parsePendingEditDraft: a pre-existing draft with no tailHoldMs reads as 0");

  // 2) A draft that DOES carry a value round-trips exactly.
  const withHold: PendingEditDraft = { ...legacyDraft, tailHoldMs: 1_500 };
  const parsedWithHold = parsePendingEditDraft(JSON.stringify(withHold));
  assert.equal(parsedWithHold?.tailHoldMs, 1_500);
  console.log("✓ parsePendingEditDraft: a stored tailHoldMs round-trips exactly");

  // 3) seedPendingEditDraft: no snapshot (brand new project) seeds 0; a snapshot with a value
  //    carries it over.
  const seedNoSnapshot = seedPendingEditDraft({
    rootJobId: "root-2",
    rootInputJson: "{}",
    base: { id: "base-2", videoUrl: "v.mp4", preview: basePreview as never },
    latestExportSnapshot: null,
    projectDraftJson: null,
  });
  assert.equal(seedNoSnapshot.tailHoldMs, 0, "a fresh seed with no snapshot defaults to 0");

  const snapshotWithHold = {
    version: 1 as const,
    captions: basePreview.captions,
    originalCaptions: basePreview.captions,
    subtitleConfig: DEFAULT_V2_SUB,
    cardLen: "sentence" as const,
    captionOverrides: {},
    tailHoldMs: 2_500,
    videoUrl: "v.mp4",
    preview: basePreview as never,
  };
  const seedFromSnapshot = seedPendingEditDraft({
    rootJobId: "root-3",
    rootInputJson: "{}",
    base: { id: "base-3", videoUrl: "v.mp4", preview: basePreview as never },
    latestExportSnapshot: snapshotWithHold,
    projectDraftJson: null,
  });
  assert.equal(seedFromSnapshot.tailHoldMs, 2_500, "a seed carries the latest export snapshot's tailHoldMs over");
  console.log("✓ seedPendingEditDraft: carries the latest export snapshot's tailHoldMs, else 0");

  // 4) toBurnConfig forwards the draft's tailHoldMs into the shared burn-config builder.
  const burnConfig = toBurnConfig(seedFromSnapshot, { videoUrl: "v.mp4", preview: basePreview as never });
  assert.equal(burnConfig.tailHoldFrames, Math.round((2_500 / 1000) * FPS));
  console.log("✓ toBurnConfig forwards the draft's tailHoldMs into buildV2BurnConfig");

  console.log("\n✅ TAIL HOLD PENDING-DRAFT CHECKS PASSED");
}

main();
