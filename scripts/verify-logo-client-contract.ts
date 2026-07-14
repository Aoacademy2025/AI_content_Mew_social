// Run with: npx tsx scripts/verify-logo-client-contract.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as logoEditorModule from "../src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor";
import {
  LOGO_PICKER_ACCEPT,
  LOGO_PICKER_FORMAT_LABEL,
  buildLogoTelemetryProperties,
  buildLogoUploadFormData,
  logoUploadSizeBucket,
  parseLogoUploadResponse,
} from "../src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor";
import {
  DEFAULT_V2_SUB,
  buildV2BurnConfig,
  type V2Caption,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { BrandAssetView, LogoOverlayConfig } from "../src/lib/logo-overlay";

const failures: string[] = [];

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${detail}`);
    console.error(`not ok - ${name}\n  ${detail}`);
  }
}

const asset: BrandAssetView = {
  id: "asset_logo_1",
  displayName: "brand-mark.png",
  mimeType: "image/webp",
  sizeBytes: 42_000,
  width: 800,
  height: 400,
  imageUrl: "/api/user/brand-assets/asset_logo_1/image",
};

const config: LogoOverlayConfig = {
  enabled: true,
  assetId: asset.id,
  position: "bottom-left",
  sizePct: 22,
  opacity: 0.75,
};

const captions: V2Caption[] = [
  { text: "ทดสอบ", startMs: 0, endMs: 1_000, tag: "hook" },
];

type ScheduleLogoAssetCleanup = (
  assetId: string,
  dependencies?: {
    schedule?: (task: () => void, delayMs: number) => void;
    deleteAsset?: (assetId: string) => Promise<unknown>;
  },
) => boolean;

async function main() {
  await check("picker advertises every accepted MIME type, extension, and the limit", () => {
    for (const token of [
      "image/png",
      "image/jpeg",
      "image/webp",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
    ]) {
      assert.ok(LOGO_PICKER_ACCEPT.split(",").includes(token), `missing picker token: ${token}`);
    }
    assert.match(LOGO_PICKER_FORMAT_LABEL, /PNG/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /JPG|JPEG/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /WebP/i);
    assert.match(LOGO_PICKER_FORMAT_LABEL, /5\s*MB/i);
  });

  await check("multipart construction sends only file and projectId fields", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "brand.png", {
      type: "image/png",
    });
    const form = buildLogoUploadFormData(file, "project_123");
    assert.equal(form.get("file"), file);
    assert.equal(form.get("projectId"), "project_123");
    assert.deepEqual(Array.from(form.keys()).sort(), ["file", "projectId"]);
  });

  await check("upload response parsing accepts only the public asset shape", () => {
    assert.deepEqual(
      parseLogoUploadResponse(201, {
        asset: { ...asset, storageKey: "private/user/logo.webp", originalName: "secret.png" },
      }),
      { ok: true, asset },
    );
    assert.deepEqual(
      parseLogoUploadResponse(422, {
        error: "corrupt_image",
        message: "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้",
        path: "/private/logo.webp",
      }),
      {
        ok: false,
        errorCode: "corrupt_image",
        message: "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้",
      },
    );
    assert.deepEqual(parseLogoUploadResponse(201, { asset: { ...asset, imageUrl: "" } }), {
      ok: false,
      errorCode: "invalid_response",
      message: "อัปโหลดโลโก้ไม่สำเร็จ",
    });
  });

  await check("telemetry properties are normalized and privacy-safe", () => {
    const properties = buildLogoTelemetryProperties({
      planEligible: true,
      errorCode: "CORRUPT_IMAGE /Users/me/brand.png",
      sizeBucket: "1-5mb",
      position: "top-right",
      enabled: false,
      surface: "mobile",
      assetId: asset.id,
      filename: asset.displayName,
      url: asset.imageUrl,
      path: "/private/logo.webp",
      storageKey: "user/private.webp",
      originalName: "private.png",
    });
    assert.deepEqual(properties, {
      planEligible: true,
      errorCode: "unknown",
      sizeBucket: "1-5mb",
      position: "top-right",
      enabled: false,
      surface: "mobile",
    });
    for (const forbidden of [
      "assetId",
      "filename",
      "url",
      "path",
      "storageKey",
      "originalName",
    ]) {
      assert.equal(forbidden in properties, false, `telemetry leaked ${forbidden}`);
    }
    assert.equal(logoUploadSizeBucket(0), "under-1mb");
    assert.equal(logoUploadSizeBucket(1024 * 1024), "1-5mb");
    assert.equal(logoUploadSizeBucket(6 * 1024 * 1024), "over-5mb");
  });

  await check("burn config is byte-compatible when logo input is absent", () => {
    const legacy = buildV2BurnConfig("/preview.mp4", captions, 1_000, DEFAULT_V2_SUB);
    const explicitAbsent = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      undefined,
    );
    assert.deepEqual(explicitAbsent, legacy);
    assert.equal("logoOverlay" in legacy, false);
  });

  await check("burn config emits only normalized enabled client logo fields", () => {
    const enabled = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      { ...config, sizePct: 999, opacity: -2 } as LogoOverlayConfig,
    );
    assert.deepEqual(enabled.logoOverlay, {
      enabled: true,
      assetId: asset.id,
      position: "bottom-left",
      sizePct: 35,
      opacity: 0.2,
    });

    const disabled = buildV2BurnConfig(
      "/preview.mp4",
      captions,
      1_000,
      DEFAULT_V2_SUB,
      30,
      {},
      { ...config, enabled: false },
    );
    assert.equal("logoOverlay" in disabled, false);
  });

  const hookSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useLogoOverlayEditor.ts",
    "utf8",
  );
  await check("cleanup schedules any reloaded project asset and survives hook unmount", async () => {
    const scheduleLogoAssetCleanup = (
      logoEditorModule as typeof logoEditorModule & {
        scheduleLogoAssetCleanup?: ScheduleLogoAssetCleanup;
      }
    ).scheduleLogoAssetCleanup;
    const cleanupDelay = (
      logoEditorModule as typeof logoEditorModule & {
        LOGO_ASSET_CLEANUP_DELAY_MS?: number;
      }
    ).LOGO_ASSET_CLEANUP_DELAY_MS;
    assert.equal(
      typeof scheduleLogoAssetCleanup,
      "function",
      "scheduleLogoAssetCleanup is not exported",
    );
    assert.equal(cleanupDelay, 1_100, "cleanup waits beyond the one-second autosave window");

    const pendingTasks: Array<() => void> = [];
    const delays: number[] = [];
    const deletedAssetIds: string[] = [];
    let markDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const accepted = scheduleLogoAssetCleanup!("  asset_from_reloaded_project  ", {
        schedule(task, delayMs) {
          pendingTasks.push(task);
          delays.push(delayMs);
        },
        async deleteAsset(assetId) {
          deletedAssetIds.push(assetId);
          markDeleteStarted?.();
          throw new Error("network failure must stay invisible");
        },
      });
      assert.equal(accepted, true, "a persisted/reloaded asset does not need mount-local provenance");
      assert.deepEqual(delays, [1_100]);
      assert.equal(pendingTasks.length, 1);

      // Simulate the hook unmounting before the timeout: no hook cleanup is allowed to
      // cancel this independently owned task, so the queued callback still executes.
      pendingTasks[0]();
      await deleteStarted;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(deletedAssetIds, ["asset_from_reloaded_project"]);
      assert.deepEqual(unhandled, [], "best-effort DELETE failures remain invisible");
      assert.equal(scheduleLogoAssetCleanup!("   ", {
        schedule() { throw new Error("blank ids must not schedule"); },
      }), false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  await check("replacement/removal cleanup is server-protected rather than mount-gated", () => {
    assert.doesNotMatch(hookSource, /projectOnlyAssetIds|cleanupTimers|clearTimeout/);
    assert.match(
      hookSource,
      /previous\.assetId\s*!==\s*parsed\.asset\.id[\s\S]{0,160}scheduleLogoAssetCleanup\(previous\.assetId\)/,
    );
    assert.match(
      hookSource,
      /removeFromProject[\s\S]{0,420}scheduleLogoAssetCleanup\(normalizedValue\.assetId\)/,
    );
  });

  await check("client mutations never include sensitive asset data in telemetry", () => {
    assert.doesNotMatch(
      hookSource,
      /trackEvent\([^)]*\{[\s\S]{0,240}\b(assetId|filename|imageUrl|storageKey|originalName)\b/,
    );
  });

  const previewSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/LogoOverlayPreview.tsx",
    "utf8",
  );
  await check("live preview shares geometry and cannot intercept editor input", () => {
    assert.match(previewSource, /ResizeObserver/);
    assert.match(previewSource, /logoOverlayFrame/);
    assert.match(previewSource, /asset\.imageUrl/);
    assert.match(previewSource, /pointerEvents:\s*["']none["']/);
    assert.match(previewSource, /objectFit:\s*["']contain["']/);
  });

  const desktopSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
    "utf8",
  );
  await check("desktop exposes subtitle and logo branches with project wiring", () => {
    assert.match(desktopSource, /useState<\s*["']subtitle["']\s*\|\s*["']logo["']\s*>\(\s*["']subtitle["']\s*\)/);
    assert.match(desktopSource, /value:\s*["']subtitle["']\s*,\s*label:\s*["']ซับ["']/);
    assert.match(desktopSource, /value:\s*["']logo["']\s*,\s*label:\s*["']โลโก้["']/);
    const editorCallStart = desktopSource.indexOf("usePostPhaseEditor(job, script, {");
    const editorCallEnd = desktopSource.indexOf("});", editorCallStart);
    assert.ok(editorCallStart >= 0 && editorCallEnd > editorCallStart, "desktop editor call is missing");
    const editorOptionsSource = desktopSource.slice(editorCallStart, editorCallEnd);
    assert.match(editorOptionsSource, /surface:\s*["']desktop["']/);
    for (const prop of [
      "projectId",
      "logoOverlay",
      "onLogoOverlayChange",
      "logoEligible",
      "projectSaveStatus",
      "onRetryProjectSave",
    ]) {
      assert.match(
        editorOptionsSource,
        new RegExp(`(?:^|\\n)\\s*${prop},`),
        `desktop does not forward ${prop} into usePostPhaseEditor`,
      );
    }
  });

  const shellSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
    "utf8",
  );
  await check("editor shell supplies the project logo contract to desktop", () => {
    assert.match(shellSource, /projectId:\s*p\.projectId/);
    assert.match(shellSource, /logoOverlay:\s*p\.logoOverlay/);
    assert.match(shellSource, /onLogoOverlayChange:\s*p\.setLogoOverlay/);
    assert.match(shellSource, /logoEligible:\s*p\.canUseLogoOverlay/);
    assert.match(shellSource, /projectSaveStatus:\s*p\.saveStatus/);
    assert.match(shellSource, /onRetryProjectSave:\s*p\.retryProjectSave/);
    assert.match(shellSource, /<PostPhase\s+\{\.\.\.postPhaseProjectProps\}/);
  });

  await check("desktop mounts each control tree inside its matching tab panel", () => {
    const subtitleBranchStart = desktopSource.indexOf('rightTab === "subtitle"');
    const logoBranchStart = desktopSource.indexOf('rightTab === "logo"', subtitleBranchStart);
    const panelEnd = desktopSource.indexOf("</aside>", logoBranchStart);
    assert.ok(subtitleBranchStart >= 0 && logoBranchStart > subtitleBranchStart && panelEnd > logoBranchStart);
    const subtitleBranch = desktopSource.slice(subtitleBranchStart, logoBranchStart);
    const logoBranch = desktopSource.slice(logoBranchStart, panelEnd);
    assert.match(subtitleBranch, /role=["']tabpanel["']/);
    assert.match(subtitleBranch, /ความยาวการ์ดซับ/);
    assert.doesNotMatch(subtitleBranch, /<LogoOverlayControls\b/);
    assert.match(logoBranch, /role=["']tabpanel["']/);
    assert.match(logoBranch, /<LogoOverlayControls\b/);
    assert.equal(
      desktopSource.match(/<LogoOverlayControls\b/g)?.length,
      1,
      "desktop must have exactly one shared LogoOverlayControls instance",
    );
  });

  await check("desktop records the first logo-tab transition once per mount", () => {
    assert.match(desktopSource, /logoPanelOpenedRef\s*=\s*useRef\(false\)/);
    assert.match(
      desktopSource,
      /if\s*\(\s*next\s*===\s*["']logo["']\s*&&\s*!logoPanelOpenedRef\.current\s*\)[\s\S]{0,180}logoPanelOpenedRef\.current\s*=\s*true[\s\S]{0,180}logo_overlay_panel_opened[\s\S]{0,180}surface:\s*["']desktop["']/,
    );
  });

  await check("desktop logo preview shares video bounds below captions and ignores input", () => {
    const frameIndex = desktopSource.indexOf('data-video-preview-frame="true"');
    const frameEnd = desktopSource.indexOf("</main>", frameIndex);
    const videoIndex = desktopSource.indexOf("ref={ed.videoRef}", frameIndex);
    const logoIndex = desktopSource.indexOf("<LogoOverlayPreview", videoIndex);
    const captionsIndex = desktopSource.indexOf("<V2CaptionOverlay", videoIndex);
    assert.ok(frameIndex >= 0 && frameEnd > frameIndex, "desktop preview frame marker is missing");
    assert.ok(videoIndex >= 0, "desktop editor video is missing");
    assert.ok(logoIndex > videoIndex, "logo preview must render after the displayed video");
    assert.ok(captionsIndex > logoIndex, "logo preview must render before captions");
    assert.ok(captionsIndex < frameEnd, "video, logo, and captions must share one preview frame");
    assert.match(desktopSource.slice(logoIndex, captionsIndex), /value=\{logoOverlay\}/);
    assert.match(desktopSource.slice(logoIndex, captionsIndex), /asset=\{ed\.logo\.asset\}/);
    assert.match(previewSource, /position:\s*["']absolute["'][\s\S]{0,100}inset:\s*0/);
    assert.match(previewSource, /pointerEvents:\s*["']none["']/);
  });

  const controlsSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/LogoOverlayControls.tsx",
    "utf8",
  );
  await check("hidden logo picker is not a duplicate invisible tab stop", () => {
    const pickerStart = controlsSource.indexOf('className="logo-controls__file"');
    const pickerEnd = controlsSource.indexOf("/>", pickerStart);
    assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, "hidden logo picker is missing");
    const pickerSource = controlsSource.slice(pickerStart, pickerEnd);
    assert.match(pickerSource, /tabIndex=\{-1\}/);
    assert.match(pickerSource, /aria-label=["']เลือกไฟล์โลโก้["']/);
    assert.match(controlsSource, /fileInputRef\.current\?\.click\(\)/);
    assert.match(controlsSource, /className=["']logo-controls__upload["'][\s\S]{0,140}onClick=\{chooseFile\}/);
    assert.match(controlsSource, /className=["']logo-controls__text-action["'][\s\S]{0,140}onClick=\{chooseFile\}/);
  });

  await check("desktop shared controls preserve accessible anchor order", () => {
    assert.match(controlsSource, /LOGO_POSITIONS\.map/);
    assert.match(controlsSource, /aria-label=\{`วางโลโก้\$\{POSITION_LABELS\[position\]\}`\}/);
    assert.match(controlsSource, /aria-pressed=\{selected\}/);
    const switchIndex = controlsSource.indexOf("<LogoSwitch");
    const replaceIndex = controlsSource.indexOf("logo-controls__text-action", switchIndex);
    const removeIndex = controlsSource.indexOf("logo-controls__remove-action", replaceIndex);
    const positionsIndex = controlsSource.indexOf("LOGO_POSITIONS.map", removeIndex);
    const sizeIndex = controlsSource.indexOf("ขนาดโลโก้", positionsIndex);
    const opacityIndex = controlsSource.indexOf("ความทึบของโลโก้", sizeIndex);
    const defaultIndex = controlsSource.indexOf("logo-controls__default-choice", opacityIndex);
    assert.ok(
      switchIndex < replaceIndex
      && replaceIndex < removeIndex
      && removeIndex < positionsIndex
      && positionsIndex < sizeIndex
      && sizeIndex < opacityIndex
      && opacityIndex < defaultIndex,
      "configured logo controls are not in the required keyboard reading order",
    );
  });

  const uiSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/ui.tsx",
    "utf8",
  );
  await check("desktop segmented control opts into complete tab semantics", () => {
    assert.match(uiSource, /semantics\?:\s*["']tabs["']/);
    assert.match(uiSource, /role=\{semantics\s*===\s*["']tabs["']\s*\?\s*["']tablist["']/);
    assert.match(uiSource, /role=\{semantics\s*===\s*["']tabs["']\s*\?\s*["']tab["']/);
    assert.match(uiSource, /aria-selected=\{semantics\s*===\s*["']tabs["']\s*\?\s*active/);
    assert.match(uiSource, /tabIndex=\{semantics\s*===\s*["']tabs["']\s*\?\s*\(active\s*\?\s*0\s*:\s*-1\)/);
    assert.match(uiSource, /ArrowLeft/);
    assert.match(uiSource, /ArrowRight/);
    const rightTabsStart = desktopSource.indexOf("<Segmented", desktopSource.indexOf("ขวา 330px"));
    const rightTabsEnd = desktopSource.indexOf("/>", rightTabsStart);
    const rightTabsSource = desktopSource.slice(rightTabsStart, rightTabsEnd);
    assert.match(rightTabsSource, /semantics=["']tabs["']/);
    assert.match(rightTabsSource, /id=\{rightTabsId\}/);
    assert.match(rightTabsSource, /ariaLabel=["']ตั้งค่าองค์ประกอบวิดีโอ["']/);
  });

  await check("desktop export remains visually first but follows the editor in DOM order", () => {
    const panelEnd = desktopSource.indexOf("</aside>", desktopSource.indexOf("ขวา 330px"));
    const exportIndex = desktopSource.indexOf("onClick={() => void ed.exportVideo()}", panelEnd);
    assert.ok(panelEnd >= 0, "desktop right panel is missing");
    assert.ok(exportIndex > panelEnd, "export must follow the editor and right panel in DOM focus order");
    const exportBarMarker = desktopSource.lastIndexOf('data-desktop-export-bar="true"', exportIndex);
    assert.ok(exportBarMarker >= 0, "late-DOM export bar marker is missing");
    const exportBarSource = desktopSource.slice(Math.max(0, exportBarMarker - 180), exportIndex);
    assert.match(exportBarSource, /data-desktop-export-bar=["']true["']/);
    assert.match(exportBarSource, /order-first/);
    assert.match(desktopSource.slice(exportIndex, exportIndex + 520), /["']ส่งออกวิดีโอ["']/);
  });

  if (failures.length > 0) {
    throw new Error(`logo client verifier failed (${failures.length}):\n${failures.join("\n")}`);
  }
  console.log("logo-client-contract: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
