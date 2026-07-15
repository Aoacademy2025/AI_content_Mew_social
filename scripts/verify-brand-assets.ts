// Run with a disposable database that has already received `prisma db push`:
// DATABASE_URL=file:/tmp/heroai-logo-model.db BRAND_ASSET_ROOT=/tmp/heroai-brand-assets npx tsx scripts/verify-brand-assets.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const requestedRoot = process.env.BRAND_ASSET_ROOT || path.join(tmpdir(), "heroai-brand-assets");
const rootPrefix = path.resolve(`${requestedRoot}-`);
const brandRoot = mkdtempSync(rootPrefix);
process.env.BRAND_ASSET_ROOT = brandRoot;

const USER_A = "brand-user-a";
const USER_B = "brand-user-b";
const PROJECT_A = "brand-project-a";
const PROJECT_B = "brand-project-b";
const HOUR_MS = 60 * 60 * 1000;

function imageFile(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const service = await import("@/lib/brand-assets.server");

  async function expectBrandError(
    task: () => Promise<unknown>,
    code: InstanceType<typeof service.BrandAssetError>["code"],
    status: number,
  ) {
    let caught: unknown;
    try {
      await task();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof service.BrandAssetError, `${code} should throw BrandAssetError`);
    assert.equal(caught.code, code, `${code} should expose its stable error code`);
    assert.equal(caught.status, status, `${code} should expose HTTP ${status}`);
  }

  async function captureDeleteOutcome(task: () => Promise<boolean>): Promise<string> {
    try {
      return `returned:${await task()}`;
    } catch (error) {
      if (error instanceof service.BrandAssetError) return `error:${error.code}:${error.status}`;
      throw error;
    }
  }

  async function verifyExactUserDirectoryRemoval(): Promise<void> {
    const validUserId = "brand-directory-removal-user";
    const validDirectory = path.join(brandRoot, validUserId);
    await mkdir(path.join(validDirectory, "nested"), { recursive: true });
    await writeFile(path.join(validDirectory, "nested", "logo.webp"), "private-logo");

    await service.removeBrandAssetDirectoryForUser(validUserId);
    assert.equal(
      existsSync(validDirectory),
      false,
      "exact-user directory removal is recursive",
    );
    await service.removeBrandAssetDirectoryForUser(validUserId);

    const rootSentinel = path.join(brandRoot, "root-sentinel.txt");
    const siblingDirectory = `${brandRoot}-sibling`;
    const siblingSentinel = path.join(siblingDirectory, "sibling-sentinel.txt");
    await writeFile(rootSentinel, "keep-root");
    await mkdir(siblingDirectory, { recursive: true });
    await writeFile(siblingSentinel, "keep-sibling");

    const invalidUserIds = [
      "",
      ".",
      "..",
      "nested/user",
      "nested\\user",
      path.resolve(siblingDirectory),
      `../${path.basename(siblingDirectory)}`,
      " brand-user ",
      "e\u0301",
      "nul\u0000user",
    ];
    for (const invalidUserId of invalidUserIds) {
      await expectBrandError(
        () => service.removeBrandAssetDirectoryForUser(invalidUserId),
        "invalid_config",
        400,
      );
      assert.equal(existsSync(rootSentinel), true, "invalid user id never removes the asset root");
      assert.equal(existsSync(siblingSentinel), true, "invalid user id never removes a sibling directory");
    }

    rmSync(siblingDirectory, { recursive: true, force: true });
  }

  try {
    await verifyExactUserDirectoryRemoval();

    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    await prisma.user.createMany({
      data: [
        { id: USER_A, name: "Brand A", email: "brand-a@example.test", plan: "PRO" },
        { id: USER_B, name: "Brand B", email: "brand-b@example.test", plan: "BUSINESS" },
      ],
    });
    await prisma.editorProject.createMany({
      data: [
        { id: PROJECT_A, userId: USER_A, title: "A project", status: "draft" },
        { id: PROJECT_B, userId: USER_B, title: "B project", status: "draft" },
      ],
    });

    assert.equal(service.canUseLogoOverlay("PRO"), true, "PRO can use logo overlays");
    assert.equal(service.canUseLogoOverlay("BUSINESS"), true, "BUSINESS can use logo overlays");
    assert.equal(service.canUseLogoOverlay("FREE"), false, "FREE cannot use logo overlays");

    const transparentPng = await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 0.25 },
      },
    }).png().toBuffer();
    const jpeg = await sharp({
      create: {
        width: 240,
        height: 120,
        channels: 3,
        background: { r: 180, g: 90, b: 30 },
      },
    }).jpeg().toBuffer();
    const webp = await sharp({
      create: {
        width: 90,
        height: 45,
        channels: 3,
        background: { r: 20, g: 130, b: 220 },
      },
    }).webp().toBuffer();

    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "FREE",
        projectId: PROJECT_A,
        file: imageFile(transparentPng, "free.png", "image/png"),
      }),
      "plan_required",
      403,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_B,
        file: imageFile(transparentPng, "cross-project.png", "image/png"),
      }),
      "project_not_found",
      404,
    );

    const unsafeDisplayName = `${"LongLogo".repeat(17)}\u0001.png`;
    const alphaAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(transparentPng, unsafeDisplayName, "image/png"),
    });
    assert.equal(alphaAsset.mimeType, "image/webp", "PNG upload is normalized to WebP");
    assert.equal(alphaAsset.width, 64, "normalization preserves width when no resize is needed");
    assert.equal(alphaAsset.height, 32, "normalization preserves height when no resize is needed");
    assert.ok(alphaAsset.displayName.length <= 120, "display label is truncated to 120 characters");
    assert.doesNotMatch(alphaAsset.displayName, /[\u0000-\u001f\u007f-\u009f]/u, "display label strips controls");

    const alphaRow = await prisma.brandAsset.findUniqueOrThrow({ where: { id: alphaAsset.id } });
    assert.match(alphaRow.storageKey, /^brand-user-a\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i, "storage key uses a random server UUID");
    assert.equal(alphaRow.storageKey.includes("LongLogo"), false, "storage key never contains the client filename");
    const alphaPath = await service.getBrandAssetPath(USER_A, alphaAsset.id);
    assert.ok(alphaPath, "owner can resolve the normalized asset path");
    assert.equal(path.dirname(alphaPath), path.join(brandRoot, USER_A), "normalized asset stays in its user directory");
    assert.equal(alphaAsset.sizeBytes, alphaRow.sizeBytes, "view reports persisted normalized byte size");
    const normalizedAlpha = await sharp(alphaPath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(normalizedAlpha.info.channels, 4, "normalized WebP retains an alpha channel");
    assert.ok(
      normalizedAlpha.data.some((value, index) => index % 4 === 3 && value > 0 && value < 255),
      "normalized lossless WebP retains translucent pixels",
    );

    const businessAsset = await service.saveBrandAsset({
      userId: USER_B,
      plan: "BUSINESS",
      projectId: PROJECT_B,
      file: imageFile(jpeg, "business.jpeg", "image/jpeg"),
    });
    assert.equal(businessAsset.mimeType, "image/webp", "BUSINESS JPEG upload is accepted and normalized");

    const webpAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(webp, "existing.webp", "image/webp"),
    });
    assert.equal(webpAsset.width, 90, "PRO WebP upload is accepted");

    await prisma.editorProject.update({ where: { id: PROJECT_B }, data: { status: "archived" } });
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_B,
        plan: "BUSINESS",
        projectId: PROJECT_B,
        file: imageFile(jpeg, "archived.jpeg", "image/jpeg"),
      }),
      "project_not_found",
      404,
    );

    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(transparentPng, "unsupported.gif", "image/png"),
      }),
      "unsupported_type",
      415,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(jpeg, "declared.png", "image/jpeg"),
      }),
      "unsupported_type",
      415,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(jpeg, "decoded.png", "image/png"),
      }),
      "unsupported_type",
      415,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(Buffer.alloc(0), "empty.png", "image/png"),
      }),
      "empty_file",
      400,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(Buffer.alloc(5 * 1024 * 1024 + 1), "too-large.png", "image/png"),
      }),
      "payload_too_large",
      413,
    );
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(Buffer.from("not an image"), "corrupt.png", "image/png"),
      }),
      "corrupt_image",
      400,
    );

    const tooWide = await sharp({
      create: {
        width: 4097,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    }).png().toBuffer();
    await expectBrandError(
      () => service.saveBrandAsset({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        file: imageFile(tooWide, "too-wide.png", "image/png"),
      }),
      "dimensions_too_large",
      400,
    );

    const exifJpeg = await sharp({
      create: {
        width: 240,
        height: 80,
        channels: 3,
        background: { r: 60, g: 120, b: 180 },
      },
    }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const exifAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(exifJpeg, "rotated.jpg", "image/jpeg"),
    });
    assert.equal(exifAsset.width, 80, "EXIF rotation swaps the normalized width");
    assert.equal(exifAsset.height, 240, "EXIF rotation swaps the normalized height");

    const largePng = await sharp({
      create: {
        width: 3000,
        height: 1500,
        channels: 3,
        background: { r: 210, g: 170, b: 25 },
      },
    }).png().toBuffer();
    const resizedAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(largePng, "large.png", "image/png"),
    });
    assert.deepEqual(
      { width: resizedAsset.width, height: resizedAsset.height },
      { width: 2048, height: 1024 },
      "normalization reduces the longest edge to 2048 without changing aspect ratio",
    );

    assert.equal(await service.getOwnedBrandAsset(USER_A, businessAsset.id), null, "asset metadata is owner-scoped");
    assert.equal(await service.getBrandAssetPath(USER_A, businessAsset.id), null, "asset paths are owner-scoped");
    assert.equal(await service.deleteBrandAssetIfUnreferenced(USER_A, businessAsset.id), false, "cross-owner deletion is hidden as not found");

    await prisma.brandPreference.create({
      data: {
        userId: USER_B,
        defaultAssetId: alphaAsset.id,
        enabled: true,
        position: "top-right",
        sizePct: 18,
        opacity: 0.9,
      },
    });
    await prisma.editorProject.update({
      where: { id: PROJECT_B },
      data: { draftJson: JSON.stringify({ logoOverlay: { enabled: true, assetId: webpAsset.id } }) },
    });
    const crossUserReferenceOutcomes = {
      defaultPreference: await captureDeleteOutcome(
        () => service.deleteBrandAssetIfUnreferenced(USER_A, alphaAsset.id),
      ),
      projectDraft: await captureDeleteOutcome(
        () => service.deleteBrandAssetIfUnreferenced(USER_A, webpAsset.id),
      ),
    };
    assert.deepEqual(
      crossUserReferenceOutcomes,
      {
        defaultPreference: "error:asset_in_use:409",
        projectDraft: "error:asset_in_use:409",
      },
      "references owned by other users still block deletion of the referenced asset",
    );
    await prisma.brandPreference.delete({ where: { userId: USER_B } });
    await prisma.editorProject.update({ where: { id: PROJECT_B }, data: { draftJson: null } });

    const defaultConfig = {
      enabled: true,
      assetId: alphaAsset.id,
      position: "top-left" as const,
      sizePct: 22,
      opacity: 0.75,
    };
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "FREE",
        assetId: alphaAsset.id,
        config: defaultConfig,
      }),
      "plan_required",
      403,
    );
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: alphaAsset.id,
        config: { ...defaultConfig, assetId: webpAsset.id },
      }),
      "invalid_config",
      400,
    );
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: businessAsset.id,
        config: { ...defaultConfig, assetId: businessAsset.id },
      }),
      "asset_not_found",
      404,
    );

    await service.setDefaultBrandPreference({
      userId: USER_A,
      plan: "PRO",
      assetId: alphaAsset.id,
      config: defaultConfig,
    });
    await expectBrandError(
      () => service.deleteBrandAssetIfUnreferenced(USER_A, alphaAsset.id),
      "asset_in_use",
      409,
    );

    const replacementConfig = {
      enabled: false,
      assetId: webpAsset.id,
      position: "bottom-right" as const,
      sizePct: 31,
      opacity: 0.4,
    };
    await service.setDefaultBrandPreference({
      userId: USER_A,
      plan: "PRO",
      assetId: webpAsset.id,
      config: replacementConfig,
    });
    assert.equal(await prisma.brandPreference.count({ where: { userId: USER_A } }), 1, "default save upserts one preference row");
    assert.deepEqual(
      await service.getDefaultBrandPreference(USER_A),
      { asset: webpAsset, config: replacementConfig },
      "default preference read returns the owned normalized asset and updated config",
    );

    await prisma.editorProject.update({
      where: { id: PROJECT_A },
      data: { draftJson: JSON.stringify({ note: `mentions ${resizedAsset.id} but is not a logo reference` }) },
    });
    const resizedPath = await service.getBrandAssetPath(USER_A, resizedAsset.id);
    assert.equal(
      await service.deleteBrandAssetIfUnreferenced(USER_A, resizedAsset.id),
      true,
      "a mere JSON string mention does not block deletion",
    );
    assert.equal(existsSync(resizedPath!), false, "unreferenced deletion removes the normalized file");

    await prisma.editorProject.update({
      where: { id: PROJECT_A },
      data: { draftJson: JSON.stringify({ logoOverlay: { enabled: true, assetId: alphaAsset.id } }) },
    });
    await expectBrandError(
      () => service.deleteBrandAssetIfUnreferenced(USER_A, alphaAsset.id),
      "asset_in_use",
      409,
    );
    await prisma.editorProject.update({ where: { id: PROJECT_A }, data: { draftJson: "{malformed" } });
    assert.equal(
      await service.deleteBrandAssetIfUnreferenced(USER_A, alphaAsset.id),
      true,
      "malformed or non-matching drafts do not invent a logo reference",
    );
    assert.equal(existsSync(alphaPath!), false, "draft-unreferenced asset file is removed after its row");

    const rateNow = 1_000_000;
    for (let index = 0; index < 20; index += 1) {
      assert.equal(service.tryConsumeBrandAssetUpload("rate-user", rateNow), true, `rate slot ${index + 1} is accepted`);
    }
    assert.equal(service.tryConsumeBrandAssetUpload("rate-user", rateNow), false, "the 21st upload in an hour is rate limited");
    assert.equal(
      service.tryConsumeBrandAssetUpload("rate-user", rateNow + HOUR_MS + 1),
      true,
      "the sliding window expires old upload slots",
    );

    await prisma.brandAsset.create({
      data: {
        userId: USER_A,
        projectId: PROJECT_A,
        storageKey: "../outside-brand-root.webp",
        originalName: "legacy-invalid.webp",
        mimeType: "image/webp",
        sizeBytes: 1,
        width: 1,
        height: 1,
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    assert.equal(await prisma.brandAsset.count({ where: { userId: { in: [USER_A, USER_B] } } }), 0, "user deletion cascades brand asset rows");
    assert.equal(await prisma.brandPreference.count({ where: { userId: USER_A } }), 0, "user deletion cascades the default preference");
    await service.removeBrandAssetDirectoryForUser(USER_A);
    await service.removeBrandAssetDirectoryForUser(USER_B);
    assert.equal(existsSync(path.join(brandRoot, USER_A)), false, "post-user-delete cleanup removes user A's exact directory");
    assert.equal(existsSync(path.join(brandRoot, USER_B)), false, "post-user-delete cleanup removes user B's exact directory");

    console.log("brand-assets: all checks passed");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(brandRoot, { recursive: true, force: true });
  });
