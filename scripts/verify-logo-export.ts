// Run with a disposable database that has already received `prisma db push`:
// DATABASE_URL=file:/tmp/heroai-logo-export.db \
// BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-export \
// npx tsx scripts/verify-logo-export.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const requestedBrandRoot = process.env.BRAND_ASSET_ROOT
  || path.join(tmpdir(), "heroai-brand-assets-export");
const brandRoot = mkdtempSync(path.resolve(`${requestedBrandRoot}-`));
const workspaceRoot = mkdtempSync(path.join(tmpdir(), "heroai-logo-export-workspace-"));
const rendersRoot = path.join(workspaceRoot, "public", "renders");
process.env.BRAND_ASSET_ROOT = brandRoot;

const USER_A = "logo-export-user-a";
const USER_B = "logo-export-user-b";
const PROJECT_A = "logo-export-project-a";
const PROJECT_B = "logo-export-project-b";

function imageFile(bytes: Buffer, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

async function main(): Promise<void> {
  const [{ prisma }, brandAssets, logoExport, { buildMediaReferenceGraph }] = await Promise.all([
    import("../src/lib/prisma"),
    import("@/lib/brand-assets.server"),
    import("../src/lib/logo-export.server"),
    import("@/lib/media-reference-graph"),
  ]);

  async function expectBrandError(
    task: () => Promise<unknown>,
    code: InstanceType<typeof brandAssets.BrandAssetError>["code"],
    status: number,
    message?: RegExp,
  ): Promise<void> {
    let caught: unknown;
    try {
      await task();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof brandAssets.BrandAssetError, `${code} should throw BrandAssetError`);
    assert.equal(caught.code, code, `${code} should expose a stable error code`);
    assert.equal(caught.status, status, `${code} should expose HTTP ${status}`);
    if (message) assert.match(caught.message, message);
  }

  try {
    await prisma.videoJob.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.brandAsset.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.editorProject.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });

    await prisma.user.createMany({
      data: [
        { id: USER_A, name: "Logo Export A", email: "logo-export-a@example.test", plan: "PRO" },
        { id: USER_B, name: "Logo Export B", email: "logo-export-b@example.test", plan: "BUSINESS" },
      ],
    });
    await prisma.editorProject.createMany({
      data: [
        { id: PROJECT_A, userId: USER_A, title: "Logo export A" },
        { id: PROJECT_B, userId: USER_B, title: "Logo export B" },
      ],
    });

    const sourcePngA = await sharp({
      create: {
        width: 96,
        height: 48,
        channels: 4,
        background: { r: 12, g: 80, b: 190, alpha: 0.6 },
      },
    }).png().toBuffer();
    const sourcePngB = await sharp({
      create: {
        width: 72,
        height: 36,
        channels: 4,
        background: { r: 220, g: 70, b: 20, alpha: 0.8 },
      },
    }).png().toBuffer();
    const assetA = await brandAssets.saveBrandAsset({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      file: imageFile(sourcePngA, "logo-a.png"),
    });
    const assetB = await brandAssets.saveBrandAsset({
      userId: USER_B,
      plan: "BUSINESS",
      projectId: PROJECT_B,
      file: imageFile(sourcePngB, "logo-b.png"),
    });
    const assetPathA = await brandAssets.getBrandAssetPath(USER_A, assetA.id);
    const assetPathB = await brandAssets.getBrandAssetPath(USER_B, assetB.id);
    assert.ok(assetPathA && assetPathB);
    const normalizedSourceA = readFileSync(assetPathA);

    assert.equal(await logoExport.stageLogoForExport({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      rawLogoOverlay: undefined,
      rendersRoot,
    }), null, "an absent logo is a no-op");
    assert.equal(await logoExport.stageLogoForExport({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      rawLogoOverlay: {
        enabled: false,
        assetId: assetA.id,
        position: "top-left",
        sizePct: 18,
        opacity: 0.9,
      },
      rendersRoot,
    }), null, "a disabled logo is a no-op");
    assert.equal(await logoExport.stageLogoForExport({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      rawLogoOverlay: {
        enabled: true,
        assetId: assetA.id,
        position: "not-a-position",
        sizePct: 18,
        opacity: 0.9,
      },
      rendersRoot,
    }), null, "a malformed enabled logo is never staged");

    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "FREE",
        projectId: PROJECT_A,
        rawLogoOverlay: {
          enabled: true,
          assetId: assetA.id,
          position: "top-left",
          sizePct: 18,
          opacity: 0.9,
        },
        rendersRoot,
      }),
      "plan_required",
      403,
    );

    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        rawLogoOverlay: {
          enabled: true,
          assetId: assetB.id,
          position: "top-left",
          sizePct: 18,
          opacity: 0.9,
        },
        rendersRoot,
      }),
      "asset_not_found",
      404,
    );
    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_B,
        rawLogoOverlay: {
          enabled: true,
          assetId: assetA.id,
          position: "top-left",
          sizePct: 18,
          opacity: 0.9,
        },
        rendersRoot,
      }),
      "project_not_found",
      404,
    );

    const stagedA = await logoExport.stageLogoForExport({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      rawLogoOverlay: {
        enabled: true,
        assetId: assetA.id,
        position: "bottom-center",
        sizePct: 999,
        opacity: -5,
        src: "https://attacker.example/logo.webp",
        path: "/etc/passwd",
        storageKey: "other-user/secret.webp",
        originalName: "secret.webp",
      },
      rendersRoot,
    });
    assert.ok(stagedA, "PRO can stage a logo snapshot");
    assert.deepEqual(Object.keys(stagedA.trusted).sort(), [
      "intrinsicHeight",
      "intrinsicWidth",
      "opacity",
      "position",
      "sizePct",
      "src",
    ], "the worker receives only the trusted render shape");
    assert.match(
      stagedA.trusted.src,
      /^\/api\/renders\/logo-snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i,
      "the worker URL is a random flat render URL",
    );
    assert.equal(stagedA.snapshotPath, path.join(rendersRoot, path.basename(stagedA.trusted.src)));
    assert.equal(stagedA.trusted.position, "bottom-center");
    assert.equal(stagedA.trusted.sizePct, 35, "oversized logos are clamped");
    assert.equal(stagedA.trusted.opacity, 0.2, "opacity below policy is clamped");
    assert.equal(stagedA.trusted.intrinsicWidth, 96);
    assert.equal(stagedA.trusted.intrinsicHeight, 48);
    assert.deepEqual(readFileSync(stagedA.snapshotPath), normalizedSourceA, "snapshot bytes equal the normalized source at staging time");

    writeFileSync(assetPathA, Buffer.from("source replaced after staging"));
    assert.deepEqual(readFileSync(stagedA.snapshotPath), normalizedSourceA, "replacing the private source cannot mutate the snapshot");
    rmSync(assetPathA);
    assert.deepEqual(readFileSync(stagedA.snapshotPath), normalizedSourceA, "deleting the private source cannot remove the snapshot");
    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_A,
        rawLogoOverlay: {
          enabled: true,
          assetId: assetA.id,
          position: "center",
          sizePct: 18,
          opacity: 0.9,
        },
        rendersRoot,
      }),
      "asset_not_found",
      404,
      /อัปโหลด.*ใหม่/u,
    );

    const stagedB = await logoExport.stageLogoForExport({
      userId: USER_B,
      plan: "BUSINESS",
      projectId: PROJECT_B,
      rawLogoOverlay: {
        enabled: true,
        assetId: assetB.id,
        position: "middle-right",
        sizePct: 20,
        opacity: 0.75,
      },
      rendersRoot,
    });
    assert.ok(stagedB, "BUSINESS can stage a logo snapshot");
    assert.equal(stagedB.trusted.intrinsicWidth, 72);
    assert.equal(stagedB.trusted.intrinsicHeight, 36);

    writeFileSync(assetPathA, normalizedSourceA);
    const failedQueueStage = await logoExport.stageLogoForExport({
      userId: USER_A,
      plan: "PRO",
      projectId: PROJECT_A,
      rawLogoOverlay: {
        enabled: true,
        assetId: assetA.id,
        position: "top-right",
        sizePct: 18,
        opacity: 0.9,
      },
      rendersRoot,
    });
    assert.ok(failedQueueStage);
    try {
      throw new Error("simulated queue failure");
    } catch {
      await logoExport.removeLogoSnapshot(failedQueueStage.snapshotPath);
    }
    assert.equal(existsSync(failedQueueStage.snapshotPath), false, "queue failure cleanup removes the staged snapshot");

    await prisma.videoJob.createMany({
      data: [
        {
          id: "logo-export-queued-job",
          userId: USER_B,
          projectId: PROJECT_B,
          type: "export",
          status: "queued",
          inputJson: JSON.stringify({
            mode: "export",
            subtitleOverlayConfig: { logoOverlay: stagedB.trusted },
          }),
        },
        {
          id: "logo-export-processing-job",
          userId: USER_A,
          projectId: PROJECT_A,
          type: "export",
          status: "processing",
          inputJson: JSON.stringify({
            mode: "export",
            source: stagedA.trusted.src,
          }),
        },
      ],
    });
    const graph = await buildMediaReferenceGraph(new Date(), { workspaceRoot });
    for (const [jobId, snapshotPath] of [
      ["logo-export-queued-job", stagedB.snapshotPath],
      ["logo-export-processing-job", stagedA.snapshotPath],
    ] as const) {
      const key = `renders/${path.basename(snapshotPath)}`;
      const ref = graph.refs.get(key)?.find((candidate) =>
        candidate.ownerKind === "video-job" && candidate.ownerId === jobId
      );
      assert.equal(ref?.alwaysProtect, true, `${jobId} input is always protected`);
    }

    const routeSource = readFileSync(
      path.join(process.cwd(), "src", "app", "api", "videos", "jobs", "route.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      routeSource,
      /subtitleOverlayConfig:\s*body\.subtitleOverlayConfig/,
      "the raw browser subtitle object is never queued",
    );
    assert.match(routeSource, /delete\s+subtitleOverlayConfig\.logoOverlay/);
    assert.match(routeSource, /rawLogoOverlay:\s*rawLogoOverlay/);
    assert.match(routeSource, /subtitleOverlayConfig\.logoOverlay\s*=\s*stagedLogo\.trusted/);
    const durableMarker = routeSource.indexOf("jobIsDurable = true");
    const pointerUpdate = routeSource.indexOf("await prisma.editorProject.updateMany", durableMarker);
    assert.ok(durableMarker >= 0 && pointerUpdate > durableMarker, "job creation becomes durable before the project-pointer update");
    assert.match(
      routeSource,
      /if\s*\(!jobIsDurable\s*&&\s*snapshotPath\)/,
      "only pre-durable failures remove the snapshot",
    );

    await logoExport.removeLogoSnapshot(stagedA.snapshotPath);
    await logoExport.removeLogoSnapshot(stagedB.snapshotPath);
    console.log("logo-export: all checks passed");
  } finally {
    await prisma.$disconnect();
    rmSync(brandRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
