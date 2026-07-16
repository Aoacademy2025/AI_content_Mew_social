// Run with a disposable database that has already received `prisma db push`:
// DATABASE_URL=file:/tmp/heroai-logo-model.db BRAND_ASSET_ROOT=/tmp/heroai-brand-assets npx tsx scripts/verify-brand-assets.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      ".account-delete-receipts-v1",
      ".account-delete-quarantine-v1",
      "x".repeat(257),
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

  async function verifyRetirementRevisionFenceContract(): Promise<void> {
    const source = await readFile(
      path.join(process.cwd(), "src/lib/brand-assets.server.ts"),
      "utf8",
    );
    const retirementUpdate = source.slice(
      source.indexOf("const retired = await tx.brandAsset.updateMany"),
      source.indexOf("return true;", source.indexOf("const retired = await tx.brandAsset.updateMany")),
    );
    assert.match(
      retirementUpdate,
      /lifecycleRevision:\s*asset\.lifecycleRevision/,
      "retirement update is fenced by the lifecycle revision observed inside the transaction",
    );
  }

  async function verifyAtomicDefaultClaimContract(): Promise<void> {
    const source = await readFile(
      path.join(process.cwd(), "src/lib/brand-assets.server.ts"),
      "utf8",
    );
    const defaultSelection = source.slice(
      source.indexOf("export async function setDefaultBrandPreference"),
      source.indexOf("export async function deleteBrandAssetIfUnreferenced"),
    );
    assert.match(
      defaultSelection,
      /prisma\.\$transaction\(async \(tx\) =>/,
      "default selection validates, claims, and upserts in one transaction",
    );
    assert.match(
      defaultSelection,
      /lifecycleRevision:\s*asset\.lifecycleRevision/,
      "default selection claims the lifecycle revision it observed",
    );
    assert.match(
      defaultSelection,
      /lifecycleRevision:\s*\{ increment: 1 \}/,
      "default selection advances the lifecycle revision before committing the preference",
    );
    assert.match(
      defaultSelection,
      /tx\.brandPreference\.upsert/,
      "default preference upsert shares the lifecycle-claim transaction",
    );
  }

  async function verifyEditorProjectRecoveryContract(): Promise<void> {
    const recoverySource = await readFile(
      path.join(process.cwd(), "src/lib/editor-project-brand-asset.server.ts"),
      "utf8",
    );
    const verificationSource = await readFile(
      path.join(process.cwd(), "src/lib/editor-project-brand-asset-verification.server.ts"),
      "utf8",
    );
    const projectsSource = await readFile(
      path.join(process.cwd(), "src/lib/editor-projects.ts"),
      "utf8",
    );
    assert.match(
      recoverySource,
      /getRecoverableBrandAssetFence\(userId,\s*assetId\)/,
      "project recovery resolves an owner-scoped lifecycle fence",
    );
    assert.match(
      recoverySource,
      /getRecoverableBrandAssetPath\(userId,\s*assetId\)/,
      "project recovery delegates trusted path resolution to the owner-scoped helper",
    );
    assert.match(
      recoverySource,
      /lstat\([\s\S]*\.isFile\(\)/,
      "project recovery requires the trusted Logo path to be a regular file",
    );
    const lifecycleAdvance = recoverySource.slice(
      recoverySource.indexOf("export async function advanceEditorProjectBrandAsset"),
    );
    assert.match(
      lifecycleAdvance,
      /tx\.brandAsset\.updateMany/,
      "project recovery advances Logo lifecycle through the project transaction client",
    );
    assert.match(
      lifecycleAdvance,
      /userId[\s\S]*lifecycleRevision:\s*fence\.lifecycleRevision/,
      "project recovery CAS requires both owner and observed lifecycle revision",
    );
    assert.match(
      lifecycleAdvance,
      /retiredAt:\s*null[\s\S]*lifecycleRevision:\s*\{ increment: 1 \}/,
      "project recovery activates the Logo and advances its lifecycle revision",
    );
    assert.doesNotMatch(
      recoverySource,
      /console\.(?:log|warn|error|info|debug)/,
      "project recovery never logs private ids or filesystem paths",
    );
    assert.match(
      verificationSource,
      /new AsyncLocalStorage<EditorProjectBrandAssetVerificationObserver>/,
      "project recovery verification scope is isolated per async call chain",
    );
    assert.doesNotMatch(
      verificationSource,
      /process\.env|globalThis|console\.|assetId|userId|storageKey|filePath/,
      "project recovery verification scope has no external switch, logging, or private identifier channel",
    );
    assert.deepEqual(
      [...verificationSource.matchAll(/"(after-asset-prepare|after-project-cas)"/g)].map((match) => match[1]),
      ["after-asset-prepare", "after-project-cas"],
      "project recovery verification exposes exactly the two approved observation steps",
    );
    const observationCalls = [
      ...projectsSource.matchAll(/observeEditorProjectBrandAssetVerificationStep\("(after-asset-prepare|after-project-cas)"\)/g),
    ];
    assert.deepEqual(
      observationCalls.map((match) => match[1]),
      ["after-asset-prepare", "after-project-cas"],
      "project updates contain exactly the two approved recovery observations",
    );
    const updateSource = projectsSource.slice(
      projectsSource.indexOf("export async function updateEditorProject"),
      projectsSource.indexOf("export async function archiveEditorProject"),
    );
    assert.match(
      updateSource,
      /prepareEditorProjectBrandAsset[\s\S]*observeEditorProjectBrandAssetVerificationStep\("after-asset-prepare"\)[\s\S]*prisma\.\$transaction/,
      "asset preparation observation precedes the project transaction",
    );
    assert.match(
      updateSource,
      /if \(updated\.count !== 1\)[\s\S]*observeEditorProjectBrandAssetVerificationStep\("after-project-cas"\)[\s\S]*advanceEditorProjectBrandAsset/,
      "project CAS observation follows the project write and precedes lifecycle advance",
    );

    for (const routePath of [
      "src/lib/editor-project-patch.ts",
      "src/app/api/editor-projects/route.ts",
    ]) {
      const routeSource = await readFile(path.join(process.cwd(), routePath), "utf8");
      assert.match(
        routeSource,
        /brand_asset_unavailable[\s\S]*ไม่พบไฟล์โลโก้ กรุณาอัปโหลดใหม่[\s\S]*status:\s*422/,
        `${routePath} maps unavailable Logo recovery without a project acknowledgement`,
      );
      assert.match(
        routeSource,
        /brand_asset_lifecycle_conflict[\s\S]*status:\s*409/,
        `${routePath} maps lifecycle CAS failure without a project acknowledgement`,
      );
    }
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

    const retirementWinsAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(transparentPng, "retirement-wins.png", "image/png"),
    });
    const retirementWinsConfig = {
      enabled: true,
      assetId: retirementWinsAsset.id,
      position: "top-right" as const,
      sizePct: 19,
      opacity: 0.8,
    };
    assert.equal(
      await service.deleteBrandAssetIfUnreferenced(USER_A, retirementWinsAsset.id),
      true,
      "the deterministic retirement-first fixture retires before default selection",
    );
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: retirementWinsAsset.id,
        config: retirementWinsConfig,
      }),
      "asset_not_found",
      404,
    );
    assert.equal(
      await prisma.brandPreference.findUnique({ where: { userId: USER_A } }),
      null,
      "retirement-first selection never creates a default preference",
    );

    const defaultWinsAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(transparentPng, "default-wins.png", "image/png"),
    });
    const defaultWinsConfig = {
      enabled: true,
      assetId: defaultWinsAsset.id,
      position: "bottom-left" as const,
      sizePct: 21,
      opacity: 0.7,
    };
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER task2_stale_retirement_after_default_validation
      BEFORE INSERT ON BrandPreference
      WHEN NEW.userId = '${USER_A}' AND NEW.defaultAssetId = '${defaultWinsAsset.id}'
      BEGIN
        UPDATE BrandAsset
        SET retiredAt = CURRENT_TIMESTAMP,
            lifecycleRevision = lifecycleRevision + 1
        WHERE id = NEW.defaultAssetId
          AND retiredAt IS NULL
          AND lifecycleRevision = 0;
      END
    `);
    try {
      await service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: defaultWinsAsset.id,
        config: defaultWinsConfig,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS task2_stale_retirement_after_default_validation",
      );
    }
    const defaultWinsRow = await prisma.brandAsset.findUniqueOrThrow({
      where: { id: defaultWinsAsset.id },
    });
    assert.equal(
      defaultWinsRow.retiredAt,
      null,
      "a stale retirement cannot retire an asset after default selection claims its revision",
    );
    assert.equal(
      defaultWinsRow.lifecycleRevision,
      1,
      "default selection owns the one committed lifecycle revision advance",
    );
    assert.equal(
      (await prisma.brandPreference.findUnique({ where: { userId: USER_A } }))?.defaultAssetId,
      defaultWinsAsset.id,
      "the committed default points to the active claimed asset",
    );
    await expectBrandError(
      () => service.deleteBrandAssetIfUnreferenced(USER_A, defaultWinsAsset.id),
      "asset_in_use",
      409,
    );
    await prisma.brandPreference.delete({ where: { userId: USER_A } });

    const rolledBackClaimAsset = await service.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(transparentPng, "rolled-back-default-claim.png", "image/png"),
    });
    const rolledBackClaimConfig = {
      enabled: true,
      assetId: rolledBackClaimAsset.id,
      position: "top-left" as const,
      sizePct: 20,
      opacity: 0.9,
    };
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER task2_reject_default_preference_upsert
      BEFORE INSERT ON BrandPreference
      WHEN NEW.userId = '${USER_A}' AND NEW.defaultAssetId = '${rolledBackClaimAsset.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced default preference failure');
      END
    `);
    try {
      await assert.rejects(() => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: rolledBackClaimAsset.id,
        config: rolledBackClaimConfig,
      }));
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS task2_reject_default_preference_upsert",
      );
    }
    assert.deepEqual(
      await prisma.brandAsset.findUniqueOrThrow({
        where: { id: rolledBackClaimAsset.id },
        select: { retiredAt: true, lifecycleRevision: true },
      }),
      { retiredAt: null, lifecycleRevision: 0 },
      "a failed preference upsert rolls back its lifecycle claim",
    );
    assert.equal(
      await prisma.brandPreference.findUnique({ where: { userId: USER_A } }),
      null,
      "a failed atomic default selection leaves no preference",
    );

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
    const pathBeforeRetire = await service.getBrandAssetPath(USER_A, resizedAsset.id);
    assert.equal(
      await service.deleteBrandAssetIfUnreferenced(USER_A, resizedAsset.id),
      true,
      "a mere JSON string mention does not block deletion",
    );
    const retired = await prisma.brandAsset.findUnique({ where: { id: resizedAsset.id } });
    assert.ok(retired?.retiredAt, "unreferenced deletion retires the row");
    assert.equal(retired.lifecycleRevision, 1, "retirement advances the lifecycle revision");
    assert.equal(existsSync(pathBeforeRetire!), true, "retirement preserves the normalized file");
    assert.equal(
      await service.getOwnedBrandAsset(USER_A, resizedAsset.id),
      null,
      "active metadata lookup hides retired assets",
    );
    assert.equal(
      (await service.getOwnedRecoverableBrandAsset(USER_A, resizedAsset.id))?.id,
      resizedAsset.id,
      "same-owner recovery can read retired metadata",
    );
    assert.equal(
      await service.getOwnedRecoverableBrandAsset(USER_B, resizedAsset.id),
      null,
      "cross-owner recovery hides retired metadata",
    );
    assert.equal(
      await service.getBrandAssetPath(USER_A, resizedAsset.id),
      null,
      "active path lookup hides retired assets",
    );
    assert.equal(
      await service.getRecoverableBrandAssetPath(USER_A, resizedAsset.id),
      pathBeforeRetire,
      "same-owner recovery resolves the retained file",
    );
    assert.equal(
      await service.getRecoverableBrandAssetPath(USER_B, resizedAsset.id),
      null,
      "cross-owner recovery hides the retained file path",
    );
    assert.deepEqual(
      await service.getRecoverableBrandAssetFence(USER_A, resizedAsset.id),
      {
        id: resizedAsset.id,
        storageKey: retired.storageKey,
        lifecycleRevision: 1,
        retiredAt: retired.retiredAt,
      },
      "same-owner recovery exposes the server-only lifecycle fence",
    );
    assert.equal(
      await service.getRecoverableBrandAssetFence(USER_B, resizedAsset.id),
      null,
      "cross-owner recovery hides the lifecycle fence",
    );
    assert.equal(
      await service.deleteBrandAssetIfUnreferenced(USER_A, resizedAsset.id),
      false,
      "repeated retirement is hidden as not found",
    );
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: resizedAsset.id,
        config: { ...replacementConfig, assetId: resizedAsset.id },
      }),
      "asset_not_found",
      404,
    );

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
    assert.equal(existsSync(alphaPath!), true, "draft-unreferenced retirement retains the normalized file");

    await prisma.brandAsset.update({
      where: { id: webpAsset.id },
      data: { retiredAt: new Date(), lifecycleRevision: { increment: 1 } },
    });
    assert.equal(
      await service.getDefaultBrandPreference(USER_A),
      null,
      "default collection lookup excludes a retired asset",
    );
    await expectBrandError(
      () => service.setDefaultBrandPreference({
        userId: USER_A,
        plan: "PRO",
        assetId: webpAsset.id,
        config: replacementConfig,
      }),
      "asset_not_found",
      404,
    );

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
    assert.ok(
      await prisma.brandAsset.findFirst({ where: { userId: USER_A, retiredAt: null } }),
      "account fixture retains an active asset before hard deletion",
    );
    assert.ok(
      await prisma.brandAsset.findFirst({ where: { userId: USER_A, retiredAt: { not: null } } }),
      "account fixture retains a retired asset before hard deletion",
    );
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    assert.equal(await prisma.brandAsset.count({ where: { userId: { in: [USER_A, USER_B] } } }), 0, "user deletion cascades brand asset rows");
    assert.equal(await prisma.brandPreference.count({ where: { userId: USER_A } }), 0, "user deletion cascades the default preference");
    await service.removeBrandAssetDirectoryForUser(USER_A);
    await service.removeBrandAssetDirectoryForUser(USER_B);
    assert.equal(existsSync(path.join(brandRoot, USER_A)), false, "post-user-delete cleanup removes user A's exact directory");
    assert.equal(existsSync(path.join(brandRoot, USER_B)), false, "post-user-delete cleanup removes user B's exact directory");
    assert.equal(existsSync(pathBeforeRetire!), false, "hard account cleanup removes retired files");
    await verifyRetirementRevisionFenceContract();
    await verifyAtomicDefaultClaimContract();
    await verifyEditorProjectRecoveryContract();

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
