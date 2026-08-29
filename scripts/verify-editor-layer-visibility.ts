// Run: npx tsx scripts/verify-editor-layer-visibility.ts
// Contract for non-destructive Post-phase layer toggles. Hidden layers must stay
// editable, survive project save/reload, and affect both preview and final burn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const {
    DEFAULT_EDITOR_LAYER_VISIBILITY,
    canToggleAvatarLayer,
    normalizeEditorLayerVisibility,
    resolveEditorPreviewVideoUrl,
  } = await import("../src/lib/editor-layer-visibility");
  const { EDITOR_DEFAULT_DRAFT } = await import("../src/lib/editor-default-draft");
  const { buildV2BurnConfig, DEFAULT_V2_SUB } = await import(
    "../src/app/(dashboard)/video-editor/_v2/subtitle-style"
  );

  assert.deepEqual(
    normalizeEditorLayerVisibility(undefined),
    DEFAULT_EDITOR_LAYER_VISIBILITY,
    "legacy projects default every editable layer to visible",
  );
  assert.deepEqual(
    EDITOR_DEFAULT_DRAFT.layerVisibility,
    DEFAULT_EDITOR_LAYER_VISIBILITY,
    "brand-new project drafts explicitly seed every editable layer as visible",
  );
  assert.deepEqual(
    normalizeEditorLayerVisibility({ avatar: false, subtitles: false }),
    { avatar: false, subtitles: false },
    "explicit hidden states round-trip",
  );
  assert.deepEqual(
    normalizeEditorLayerVisibility({ avatar: "no", subtitles: null }),
    DEFAULT_EDITOR_LAYER_VISIBILITY,
    "malformed values fail open instead of hiding content",
  );
  assert.equal(
    canToggleAvatarLayer({ hasAvatar: true, avatarBaseVideoUrl: "/renders/background.mp4" }),
    true,
    "avatar can be toggled only when its separate base video exists",
  );
  assert.equal(
    canToggleAvatarLayer({ hasAvatar: true, avatarBaseVideoUrl: null }),
    false,
    "legacy composited avatar jobs stay visible",
  );

  assert.equal(
    resolveEditorPreviewVideoUrl({
      renderedVideoUrl: "/renders/avatar.mp4",
      avatarBaseVideoUrl: "/renders/background.mp4",
      avatarVisible: false,
    }),
    "/renders/background.mp4",
    "hiding avatar selects the already-rendered pre-composite video",
  );
  assert.equal(
    resolveEditorPreviewVideoUrl({
      renderedVideoUrl: "/renders/avatar.mp4",
      avatarBaseVideoUrl: null,
      avatarVisible: false,
    }),
    "/renders/avatar.mp4",
    "legacy jobs without a pre-composite source fail open to their rendered video",
  );

  const captions = [{
    text: "ทดสอบซับ",
    startMs: 0,
    endMs: 1000,
    tag: "hook" as const,
  }];
  const visibleBurn = buildV2BurnConfig(
    "/renders/base.mp4",
    captions,
    1000,
    DEFAULT_V2_SUB,
  );
  assert.equal(visibleBurn.keywordPopups.length, 1, "default burn keeps subtitles visible");

  const hiddenBurn = buildV2BurnConfig(
    "/renders/base.mp4",
    captions,
    1000,
    DEFAULT_V2_SUB,
    30,
    {},
    undefined,
    { avatar: true, subtitles: false },
  );
  assert.equal(hiddenBurn.keywordPopups.length, 0, "hidden subtitles are omitted from final burn");

  const root = process.cwd();
  const timeline = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx"),
    "utf8",
  );
  const desktop = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx"),
    "utf8",
  );
  const mobile = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx"),
    "utf8",
  );
  const mobileControls = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/LayerVisibilityControls.tsx"),
    "utf8",
  );
  const project = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/useV2Project.ts"),
    "utf8",
  );

  assert.match(timeline, /data-layer-toggle=/, "desktop Timeline exposes real layer toggles");
  assert.doesNotMatch(
    timeline,
    /โลโก้ทั้งคลิป/,
    "desktop Timeline omits the redundant logo row; the dedicated logo panel owns its toggle",
  );
  assert.match(desktop, /ed\.previewVideoUrl/, "desktop preview uses the effective avatar-aware source");
  assert.match(desktop, /ed\.layerVisibility\.subtitles/, "desktop subtitle preview honors visibility");
  assert.match(desktop, /visible=\{ed\.layerVisibility\.logo\}/, "desktop logo preview honors visibility");
  assert.match(desktop, /ed\.layerVisibility\.subtitles\s*\?\s*ed\.captions\s*:\s*\[\]/, "desktop passes no live captions while hidden");
  assert.match(mobile, /LayerVisibilityControls/, "mobile exposes the same layer controls");
  assert.match(mobile, /visible=\{ed\.layerVisibility\.logo\}/, "mobile logo preview honors visibility");
  assert.match(mobileControls, /role="switch"/, "mobile layer controls use accessible switch semantics");
  assert.match(project, /layerVisibility,\s*setLayerVisibility/, "layer state is saved with the project draft");
  const resetStart = project.indexOf("const resetProject = useCallback");
  const resetEnd = project.indexOf("}, [createServerProject", resetStart);
  assert.ok(resetStart >= 0 && resetEnd > resetStart, "new-project reset block remains discoverable");
  assert.match(
    project.slice(resetStart, resetEnd),
    /setLayerVisibilityRaw\(/,
    "creating another project in the same editor session resets hidden layers to the new-project default",
  );

  console.log("editor-layer-visibility: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
