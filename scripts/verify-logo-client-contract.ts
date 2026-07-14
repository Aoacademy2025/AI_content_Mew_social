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

  if (failures.length > 0) {
    throw new Error(`logo client verifier failed (${failures.length}):\n${failures.join("\n")}`);
  }
  console.log("logo-client-contract: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
