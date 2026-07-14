// Run with a disposable database that has already received `prisma db push`:
// DATABASE_URL=file:/tmp/heroai-logo-export.db \
// BRAND_ASSET_ROOT=/tmp/heroai-brand-assets-export \
// npx tsx scripts/verify-logo-export.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const PROJECT_ARCHIVED = "logo-export-project-archived";

function imageFile(bytes: Buffer, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

async function main(): Promise<void> {
  const [{ prisma }, brandAssets, logoExport, { buildMediaReferenceGraph }, orchestrator] = await Promise.all([
    import("../src/lib/prisma"),
    import("@/lib/brand-assets.server"),
    import("../src/lib/logo-export.server"),
    import("@/lib/media-reference-graph"),
    import("../src/lib/mcp/orchestrator"),
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
        { id: PROJECT_ARCHIVED, userId: USER_A, title: "Archived logo export", status: "archived" },
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
    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: PROJECT_ARCHIVED,
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
    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: "",
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
    await expectBrandError(
      () => logoExport.stageLogoForExport({
        userId: USER_A,
        plan: "PRO",
        projectId: "   ",
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
    const logoInput = {
      enabled: true,
      assetId: assetA.id,
      position: "top-right",
      sizePct: 18,
      opacity: 0.9,
    } as const;
    const snapshotsBeforeFailedCreate = new Set(
      readdirSync(rendersRoot).filter((filename) => filename.startsWith("logo-snapshot-")),
    );
    const failedJobId = "logo-export-forced-create-failure";
    let failedSnapshotPath: string | null = null;
    await assert.rejects(
      () => logoExport.createDurableExportWithStagedLogo({
        staging: {
          userId: USER_A,
          plan: "PRO",
          projectId: PROJECT_A,
          rawLogoOverlay: logoInput,
          rendersRoot,
        },
        createDurableJob: async (trustedLogo) => {
          assert.ok(trustedLogo, "staging completes before durable creation is attempted");
          failedSnapshotPath = path.join(rendersRoot, path.basename(trustedLogo.src));
          assert.equal(existsSync(failedSnapshotPath), true, "the snapshot exists during create");
          return prisma.videoJob.create({
            data: {
              id: failedJobId,
              userId: "missing-logo-export-user",
              projectId: PROJECT_A,
              type: "export",
              status: "queued",
              inputJson: JSON.stringify({ logoOverlay: trustedLogo }),
            },
          });
        },
      }),
    );
    assert.ok(failedSnapshotPath);
    assert.equal(existsSync(failedSnapshotPath), false, "a real durable-create failure removes the staged snapshot");
    assert.equal(await prisma.videoJob.findUnique({ where: { id: failedJobId } }), null, "failed creation leaves no durable job");
    assert.deepEqual(
      new Set(readdirSync(rendersRoot).filter((filename) => filename.startsWith("logo-snapshot-"))),
      snapshotsBeforeFailedCreate,
      "failed creation leaves no new snapshot behind",
    );

    const durableJobId = "logo-export-durable-before-pointer-failure";
    let durableSnapshotPath: string | null = null;
    await assert.rejects(
      () => logoExport.createDurableExportWithStagedLogo({
        staging: {
          userId: USER_A,
          plan: "PRO",
          projectId: PROJECT_A,
          rawLogoOverlay: logoInput,
          rendersRoot,
        },
        createDurableJob: async (trustedLogo) => {
          assert.ok(trustedLogo);
          durableSnapshotPath = path.join(rendersRoot, path.basename(trustedLogo.src));
          return prisma.videoJob.create({
            data: {
              id: durableJobId,
              userId: USER_A,
              projectId: PROJECT_A,
              type: "export",
              status: "queued",
              inputJson: JSON.stringify({ logoOverlay: trustedLogo }),
            },
          });
        },
        afterDurableJobCreated: async () => {
          throw new Error("simulated project-pointer failure");
        },
      }),
      /simulated project-pointer failure/,
    );
    assert.ok(await prisma.videoJob.findUnique({ where: { id: durableJobId } }), "successful create leaves a durable queued job");
    assert.ok(durableSnapshotPath);
    assert.equal(existsSync(durableSnapshotPath), true, "post-create pointer failure retains the referenced snapshot");
    await prisma.videoJob.delete({ where: { id: durableJobId } });
    await logoExport.removeLogoSnapshot(durableSnapshotPath);

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

    const sourceJob = await prisma.videoJob.create({
      data: {
        id: "logo-export-telemetry-source",
        userId: USER_B,
        projectId: PROJECT_B,
        type: "create",
        status: "done",
        progress: 100,
        inputJson: JSON.stringify({ previewMode: true }),
        outputJson: JSON.stringify({
          version: 2,
          mode: "preview",
          videoUrl: "/api/renders/logo-telemetry-preview.mp4",
          preview: {
            captions: [{ text: "logo telemetry", startMs: 0, endMs: 45_000 }],
            config: {},
            voiceUrl: "/api/renders/logo-telemetry-voice.wav",
            audioDurationMs: 45_000,
            fullText: "logo telemetry",
          },
        }),
      },
    });

    function telemetryExportCaller(label: string) {
      return {
        async post<T>(requestPath: string): Promise<T> {
          if (requestPath === "/api/videos/render") return { jobId: `render-${label}` } as T;
          if (requestPath === "/api/videos") return { id: `video-${label}` } as T;
          throw new Error(`unexpected POST ${requestPath}`);
        },
        async patch<T>(requestPath: string): Promise<T> {
          throw new Error(`unexpected PATCH ${requestPath}`);
        },
        async get<T>(requestPath: string): Promise<T> {
          if (requestPath.startsWith("/api/videos/render-progress")) {
            return {
              progress: 100,
              videoUrl: `/api/renders/${label}.mp4`,
              error: null,
              stage: "done",
            } as T;
          }
          throw new Error(`unexpected GET ${requestPath}`);
        },
      };
    }

    async function runTelemetryExport(
      label: string,
      logoOverlay: unknown,
      recordTelemetryEvent: (userId: string | null, input: unknown) => Promise<unknown>,
    ) {
      const exportJob = await prisma.videoJob.create({
        data: {
          id: `logo-export-telemetry-${label}`,
          userId: USER_B,
          projectId: PROJECT_B,
          type: "export",
          status: "processing",
          inputJson: JSON.stringify({
            mode: "export",
            sourceJobId: sourceJob.id,
            subtitleOverlayConfig: {
              videoUrl: "/api/renders/logo-telemetry-preview.mp4",
              ...(logoOverlay === undefined ? {} : { logoOverlay }),
            },
          }),
        },
      });
      await orchestrator.runOrchestrator(exportJob.id, USER_B, {
        caller: telemetryExportCaller(label),
        refundOneClip: async () => {},
        sleep: async () => {},
        recordTelemetryEvent,
      } as never);
      await new Promise((resolve) => setImmediate(resolve));
      return prisma.videoJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    }

    const completionEvents: Array<{ userId: string | null; input: Record<string, unknown> }> = [];
    let resolveCompletionStatus: (status: string) => void = () => {};
    const completionStatusObserved = new Promise<string>((resolve) => {
      resolveCompletionStatus = resolve;
    });
    const captureTelemetry = async (userId: string | null, input: unknown) => {
      const telemetryInput = input as Record<string, unknown>;
      completionEvents.push({ userId, input: telemetryInput });
      if (telemetryInput.name === "logo_overlay_export_completed") {
        const completed = await prisma.videoJob.findUnique({
          where: { id: "logo-export-telemetry-with-logo" },
          select: { status: true },
        });
        resolveCompletionStatus(completed?.status ?? "missing");
      }
    };
    const withoutLogo = await runTelemetryExport("without-logo", undefined, captureTelemetry);
    assert.equal(withoutLogo.status, "done", "a logo-free export still finalizes");
    assert.equal(
      completionEvents.some((event) => event.input.name === "logo_overlay_export_completed"),
      false,
      "logo-free exports do not record logo completion",
    );

    const untrustedLogo = await runTelemetryExport("untrusted-logo", {
      ...stagedB.trusted,
      src: "https://attacker.example/logo.webp",
    }, captureTelemetry);
    assert.equal(untrustedLogo.status, "done", "an untrusted test fixture still reaches finalization");
    assert.equal(
      completionEvents.some((event) => event.input.name === "logo_overlay_export_completed"),
      false,
      "untrusted logo config does not record logo completion",
    );

    const withLogo = await runTelemetryExport("with-logo", stagedB.trusted, captureTelemetry);
    assert.equal(withLogo.status, "done", "a trusted-logo export finalizes");
    const logoCompletionEvents = completionEvents.filter(
      (event) => event.input.name === "logo_overlay_export_completed",
    );
    assert.equal(logoCompletionEvents.length, 1, "trusted-logo completion is recorded exactly once");
    assert.equal(logoCompletionEvents[0].userId, USER_B);
    assert.deepEqual(logoCompletionEvents[0].input, {
      name: "logo_overlay_export_completed",
      category: "product",
      source: "server",
      status: "done",
      properties: {
        position: "middle-right",
        durationBucket: "30-60s",
      },
    });
    assert.equal(
      await completionStatusObserved,
      "done",
      "completion telemetry is invoked only after the durable job is done",
    );

    const completionBuilder = (
      orchestrator as typeof orchestrator & {
        buildLogoExportCompletedTelemetryProperties?: (
          subtitleOverlayConfig: unknown,
          durationMs: unknown,
        ) => Record<string, unknown> | null;
      }
    ).buildLogoExportCompletedTelemetryProperties;
    assert.equal(typeof completionBuilder, "function", "server completion payload builder is exported");
    const completionProperties = completionBuilder!({
      logoOverlay: {
        ...stagedB.trusted,
        assetId: assetB.id,
        filename: "secret.png",
        url: "https://private.example/logo.webp",
        storageKey: "private/logo.webp",
        originalName: "secret.png",
      },
    }, 45_000);
    assert.deepEqual(completionProperties, {
      position: "middle-right",
      durationBucket: "30-60s",
    });
    for (const forbidden of [
      "assetId",
      "filename",
      "src",
      "url",
      "storageKey",
      "originalName",
    ]) {
      assert.equal(forbidden in completionProperties!, false, `completion telemetry leaked ${forbidden}`);
    }
    assert.equal(
      completionBuilder!({
        logoOverlay: {
          ...stagedB.trusted,
          src: "https://attacker.example/logo.webp",
        },
      }, 45_000),
      null,
      "untrusted logo shapes do not produce completion telemetry",
    );

    let thrownTelemetryAttempts = 0;
    const thrownTelemetryJob = await runTelemetryExport(
      "telemetry-throws",
      stagedB.trusted,
      (() => {
        thrownTelemetryAttempts += 1;
        throw new Error("simulated synchronous telemetry failure");
      }) as never,
    );
    assert.ok(thrownTelemetryAttempts > 0, "the throwing telemetry seam is exercised");
    assert.equal(
      thrownTelemetryJob.status,
      "done",
      "synchronously thrown telemetry cannot fail export finalization",
    );

    let rejectedTelemetryAttempts = 0;
    const rejectedTelemetryJob = await runTelemetryExport(
      "telemetry-rejects",
      stagedB.trusted,
      () => {
        rejectedTelemetryAttempts += 1;
        return Promise.reject(new Error("simulated rejected telemetry write"));
      },
    );
    assert.ok(rejectedTelemetryAttempts > 0, "the rejected telemetry seam is exercised");
    assert.equal(
      rejectedTelemetryJob.status,
      "done",
      "rejected telemetry cannot fail export finalization",
    );

    let pendingTelemetryAttempts = 0;
    const pendingTelemetryRun = runTelemetryExport(
      "telemetry-pending",
      stagedB.trusted,
      () => {
        pendingTelemetryAttempts += 1;
        return new Promise(() => {});
      },
    );
    const pendingTelemetryJob = await Promise.race([
      pendingTelemetryRun,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("pending telemetry delayed finalization")), 500);
      }),
    ]);
    assert.ok(pendingTelemetryAttempts > 0, "the pending telemetry seam is exercised");
    assert.equal(
      pendingTelemetryJob.status,
      "done",
      "pending telemetry cannot delay export finalization",
    );

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
    assert.match(routeSource, /createDurableExportWithStagedLogo/);
    assert.match(routeSource, /subtitleOverlayConfig\.logoOverlay\s*=\s*trustedLogo/);

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
