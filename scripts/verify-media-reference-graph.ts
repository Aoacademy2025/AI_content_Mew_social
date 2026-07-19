import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { MediaReference } from "../src/lib/media-retention";

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "media-reference-graph-"));
const DATABASE_URL = `file:${join(FIXTURE_ROOT, "reference-graph.db")}`;
const NOW = new Date("2026-07-20T00:00:00.000Z");
const DAY_MS = 86_400_000;

process.env.DATABASE_URL = DATABASE_URL;
mkdirSync(join(FIXTURE_ROOT, "public", "renders"), { recursive: true });
mkdirSync(join(FIXTURE_ROOT, "stocks"), { recursive: true });
execFileSync(
  join(REPO_ROOT, "node_modules", ".bin", "prisma"),
  ["db", "push", "--skip-generate"],
  { cwd: REPO_ROOT, env: process.env, stdio: "pipe" },
);

function dateAtOffset(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function writeMedia(area: "renders" | "stocks", filename: string, mtime: Date): void {
  const root = area === "renders"
    ? join(FIXTURE_ROOT, "public", "renders")
    : join(FIXTURE_ROOT, "stocks");
  const filePath = join(root, filename);
  writeFileSync(filePath, `${area}/${filename}`);
  utimesSync(filePath, mtime, mtime);
}

function refsFor(graph: { refs: Map<string, MediaReference[]> }, key: string): MediaReference[] {
  const refs = graph.refs.get(key);
  assert.ok(refs, `expected graph key ${key}`);
  return refs;
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.user.createMany({
    data: [
      { id: "graph-free", name: "Graph Free", email: "graph-free@example.test", plan: "FREE" },
      { id: "graph-pro", name: "Graph Pro", email: "graph-pro@example.test", plan: "PRO" },
      { id: "graph-business", name: "Graph Business", email: "graph-business@example.test", plan: "BUSINESS" },
    ],
  });

  await prisma.video.createMany({
    data: [
      {
        id: "graph-gallery-live",
        userId: "graph-free",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/gallery-live.mp4",
        avatarVideoUrl: "/renders/video-avatar.mp4",
        audioUrl: "/api/renders/video-audio.mp3",
        thumbnail: "/api/renders/video-thumb.jpg",
        thumbnailConfig: JSON.stringify({ overlay: "/api/renders/thumbnail-overlay.png" }),
        renderConfig: JSON.stringify({
          bgVideos: [
            { src: "/api/stocks/nested-stock.mp4" },
            { src: "/api/stocks/hash%23stock.mp4" },
            { src: "/api/renders/query%3Fvideo.mp4" },
          ],
        }),
        generatedImages: JSON.stringify([{ url: "/api/stocks/generated-nested.png" }]),
        sceneMapping: JSON.stringify({ localUrl: "/api/stocks/scene-map.mp4" }),
        expiresAt: dateAtOffset(-2),
      },
      {
        id: "graph-shared-video",
        userId: "graph-pro",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/shared-owner.mp4",
        expiresAt: dateAtOffset(5),
      },
      {
        id: "graph-null-video",
        userId: "graph-free",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/null-protected.mp4",
        expiresAt: null,
      },
      {
        id: "graph-derived-video",
        userId: "graph-pro",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/derived-video.mp4",
        expiresAt: dateAtOffset(1),
      },
      {
        id: "graph-malformed-video",
        userId: "graph-free",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        renderConfig: "{not-json",
        expiresAt: dateAtOffset(1),
      },
      {
        id: "graph-unscoped-video",
        userId: "graph-pro",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/unscoped-video.mp4",
        expiresAt: dateAtOffset(-5),
      },
      {
        id: "graph-archived-video",
        userId: "graph-free",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/archived-video.mp4",
        expiresAt: dateAtOffset(-5),
      },
      {
        id: "graph-unrelated-critical-video",
        userId: "graph-pro",
        avatarModel: "none",
        voiceModel: "none",
        sceneCount: 1,
        videoUrl: "/api/renders/shared-criticality.mp4",
        expiresAt: dateAtOffset(-5),
      },
    ],
  });

  await prisma.videoJob.createMany({
    data: [
      {
        id: "graph-active-job",
        userId: "graph-free",
        status: "done",
        inputJson: "{}",
        outputJson: JSON.stringify({
          videoUrl: "/api/renders/active-job.mp4",
          preview: {
            voiceUrl: "/api/renders/active-voice.mp3",
            brollUrl: "/api/renders/shared-criticality.mp4",
          },
        }),
        mediaExpiresAt: dateAtOffset(-3),
      },
      {
        id: "graph-active-export-job",
        userId: "graph-business",
        status: "done",
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "/api/renders/active-export.mp4" }),
        mediaExpiresAt: dateAtOffset(-14),
      },
      {
        id: "graph-transition-preview-job",
        userId: "graph-free",
        status: "done",
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "/api/renders/active-job.mp4" }),
        mediaExpiresAt: dateAtOffset(3),
      },
      {
        id: "graph-unscoped-job",
        userId: "graph-free",
        status: "done",
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "/api/renders/unscoped-job.mp4" }),
        mediaExpiresAt: dateAtOffset(-5),
      },
      {
        id: "graph-null-job",
        userId: "graph-pro",
        status: "done",
        inputJson: "{}",
        outputJson: JSON.stringify({ videoUrl: "/api/renders/null-job.mp4" }),
        mediaExpiresAt: null,
      },
      {
        id: "graph-malformed-job",
        userId: "graph-free",
        status: "done",
        inputJson: "{}",
        outputJson: "{not-json",
        mediaExpiresAt: dateAtOffset(1),
      },
      {
        id: "graph-missing-output-job",
        userId: "graph-free",
        status: "done",
        inputJson: "{}",
        outputJson: null,
        mediaExpiresAt: dateAtOffset(1),
      },
      {
        id: "graph-processing-job",
        userId: "graph-free",
        status: "processing",
        inputJson: "{}",
        outputJson: "{ignored-because-not-done",
        mediaExpiresAt: null,
      },
      {
        id: "graph-provider-wait-job",
        userId: "graph-pro",
        status: "waiting_provider",
        inputJson: "{}",
        providerCheckpointJson: JSON.stringify({
          version: 1,
          provider: "heygen",
          phase: "tail_wait",
          providerStartedAt: "2026-07-19T22:00:00.000Z",
          providerDeadlineAt: "2026-07-20T00:30:00.000Z",
          baseUrl: "/api/renders/provider-base.mp4",
          voiceUrl: "/api/renders/provider-voice.mp3",
          audioDurationMs: 90_000,
          captions: [{ text: "provider", startMs: 0, endMs: 900 }],
          words: [],
          fullText: "provider",
          baseConfig: { voiceFile: "/api/renders/provider-voice.mp3" },
          avatar: {
            mode: "bookend-both",
            id: "avatar-provider",
            introSecs: 5,
            tailSecs: 5,
            layout: { scale: 1, offsetX: 0, offsetY: 0 },
            introVideoId: "hg-intro",
            introVideoUrl: "/api/renders/provider-intro.mp4",
            tailVideoId: "hg-tail",
          },
        }),
        providerNextPollAt: new Date("2026-07-20T00:00:30.000Z"),
        mediaExpiresAt: null,
      },
    ],
  });

  await prisma.editorProject.createMany({
    data: [
      {
        id: "graph-project-free-boundary",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/free-boundary.mp4" }),
      },
      {
        id: "graph-project-pro-boundary",
        userId: "graph-pro",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/pro-boundary.mp4" }),
      },
      {
        id: "graph-project-business-boundary",
        userId: "graph-business",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/business-boundary.mp4" }),
      },
      {
        id: "graph-project-saved",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/saved-does-not-renew.mp4" }),
        lastOpenedAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "graph-project-shared",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/shared-owner.mp4" }),
      },
      {
        id: "graph-project-active-job",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/active-job.mp4" }),
        activeJobId: "graph-active-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-active-export",
        userId: "graph-business",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/active-export.mp4" }),
        activeExportJobId: "graph-active-export-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-processing-active",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/processing-active-input.mp4" }),
        activeJobId: "graph-processing-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-export-transition",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/active-job.mp4" }),
        activeJobId: "graph-transition-preview-job",
        activeExportJobId: "graph-processing-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-cross-pointer",
        userId: "graph-business",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/active-job.mp4" }),
        activeJobId: "graph-active-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-latest-gallery",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/gallery-live.mp4" }),
        latestVideoId: "graph-gallery-live",
        updatedAt: NOW,
      },
      {
        id: "graph-project-unscoped-job",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/unscoped-job.mp4" }),
        activeJobId: "graph-unscoped-job",
        updatedAt: NOW,
      },
      {
        id: "graph-project-unscoped-video",
        userId: "graph-pro",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/unscoped-video.mp4" }),
        latestVideoId: "graph-unscoped-video",
        updatedAt: NOW,
      },
      {
        id: "graph-project-missing",
        userId: "graph-free",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/missing-unowned.mp4" }),
      },
      {
        id: "graph-project-malformed",
        userId: "graph-pro",
        draftJson: "{not-json",
      },
      {
        id: "graph-project-archived",
        userId: "graph-free",
        status: "archived",
        draftJson: JSON.stringify({ clipUrl: "/api/renders/archived-inflight-input.mp4" }),
        activeJobId: "graph-processing-job",
        latestVideoId: "graph-archived-video",
      },
    ],
  });

  await Promise.all([
    prisma.video.update({
      where: { id: "graph-gallery-live" },
      data: { projectId: "graph-project-latest-gallery" },
    }),
    prisma.video.update({
      where: { id: "graph-archived-video" },
      data: { projectId: "graph-project-archived" },
    }),
    prisma.videoJob.update({
      where: { id: "graph-active-job" },
      data: { projectId: "graph-project-active-job" },
    }),
    prisma.videoJob.update({
      where: { id: "graph-active-export-job" },
      data: { projectId: "graph-project-active-export" },
    }),
    prisma.videoJob.update({
      where: { id: "graph-transition-preview-job" },
      data: { projectId: "graph-project-export-transition" },
    }),
  ]);

  await prisma.renderJob.createMany({
    data: [
      {
        id: "graph-render-queued",
        userId: "graph-free",
        type: "RENDER",
        status: "QUEUED",
        payload: JSON.stringify({ config: { src: "/api/stocks/queued-stock.mp4" } }),
        videoUrl: "/api/renders/queued-output.mp4",
      },
      {
        id: "graph-render-running",
        userId: "graph-pro",
        type: "BURN",
        status: "RUNNING",
        payload: JSON.stringify({ source: "/api/renders/running-source.mp4" }),
        videoUrl: "/api/renders/running-output.mp4",
      },
      {
        id: "graph-render-malformed",
        userId: "graph-pro",
        type: "RENDER",
        status: "QUEUED",
        payload: "{not-json",
        videoUrl: "/api/renders/malformed-render-output.mp4",
      },
      {
        id: "graph-render-done",
        userId: "graph-free",
        type: "RENDER",
        status: "DONE",
        payload: "{ignored-because-done",
        videoUrl: "/api/renders/done-render.mp4",
      },
    ],
  });

  await prisma.generatedImage.createMany({
    data: [
      {
        id: "graph-generated-local",
        userId: "graph-free",
        prompt: "local",
        url: "/api/stocks/generated-image.png",
        imageModel: "test",
      },
      {
        id: "graph-generated-normalized",
        userId: "graph-free",
        prompt: "normalized",
        url: "/api/stocks/already.normalized",
        imageModel: "test",
      },
      {
        id: "graph-generated-external",
        userId: "graph-pro",
        prompt: "external",
        url: "https://cdn.example.test/external.png",
        imageModel: "test",
      },
      {
        id: "graph-generated-symlink",
        userId: "graph-pro",
        prompt: "symlink",
        url: "/api/renders/escape-link.mp4",
        imageModel: "test",
      },
      {
        id: "graph-generated-traversal",
        userId: "graph-business",
        prompt: "traversal",
        url: "/api/renders/%2e%2e%2foutside.mp4",
        imageModel: "test",
      },
    ],
  });
}

async function main(): Promise<void> {
  writeMedia("renders", "free-boundary.mp4", dateAtOffset(-3));
  writeMedia("renders", "pro-boundary.mp4", dateAtOffset(-7));
  writeMedia("renders", "business-boundary.mp4", dateAtOffset(-14));
  writeMedia("renders", "saved-does-not-renew.mp4", dateAtOffset(-20));
  writeMedia("renders", "shared-owner.mp4", dateAtOffset(-10));
  writeMedia("renders", "active-job.mp4", dateAtOffset(-14));
  writeMedia("renders", "unscoped-job.mp4", dateAtOffset(-1));
  writeMedia("renders", "unscoped-video.mp4", dateAtOffset(-1));
  writeMedia("renders", "archived-inflight-input.mp4", dateAtOffset(-20));
  writeMedia("renders", "provider-base.mp4", dateAtOffset(-20));
  writeMedia("renders", "provider-voice.mp3", dateAtOffset(-20));
  writeMedia("renders", "provider-intro.mp4", dateAtOffset(-20));
  const outsideTarget = join(FIXTURE_ROOT, "outside.mp4");
  writeFileSync(outsideTarget, "outside");
  symlinkSync(outsideTarget, join(FIXTURE_ROOT, "public", "renders", "escape-link.mp4"));
  const ancestorRoot = join(FIXTURE_ROOT, "ancestor-symlink-root");
  const escapedPublicRoot = join(FIXTURE_ROOT, "escaped-public");
  mkdirSync(ancestorRoot);
  mkdirSync(join(escapedPublicRoot, "renders"), { recursive: true });
  writeFileSync(join(escapedPublicRoot, "renders", "ancestor-escape.mp4"), "escaped");
  symlinkSync(escapedPublicRoot, join(ancestorRoot, "public"));

  process.chdir(FIXTURE_ROOT);
  const [prismaModule, graphModule, cleanupModule, retentionModule, quarantineModule] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/media-reference-graph"),
    import("../src/lib/media-cleanup"),
    import("../src/lib/media-retention"),
    import("../src/lib/media-quarantine"),
  ]);
  prisma = prismaModule.prisma;
  await seed(prisma);

  const roots = cleanupModule.mediaRootPaths(FIXTURE_ROOT);
  const valid = cleanupModule.parseCanonicalMediaRef(
    "https://app.example.test/api/renders/free-boundary.mp4?download=1#preview",
    roots,
  );
  assert.equal(valid.kind, "reference");
  if (valid.kind === "reference") {
    assert.equal(valid.ref.key, "renders/free-boundary.mp4");
  }
  for (const unsafe of [
    "/api/renders/subdir/evil.mp4",
    "/api/renders/%2e%2e%2fevil.mp4",
    "/api/renders/subdir%2Fevil.mp4",
    "/api/renders/%255c%252e%252e%255cevil.mp4",
    "https://app.example.test/api/renders/%2e%2e/evil.mp4",
    "https://app.example.test\\api\\renders\\evil.mp4",
    "https://app.example.test/api/renders\\evil.mp4",
    "https://app.example.test/api/\trenders/evil.mp4",
    "/api/renders\\evil.mp4",
    "/api/\trenders/evil.mp4",
    "/api/renders/bad%09name.mp4",
    "/api/renders/bad\u0001name.mp4",
    "/api/renders/bad%7fname.mp4",
  ]) {
    assert.equal(
      cleanupModule.parseCanonicalMediaRef(unsafe, roots).kind,
      "error",
      `unsafe local media ref must fail: ${unsafe}`,
    );
  }
  assert.equal(
    cleanupModule.parseCanonicalMediaRef("/api/renders/escape-link.mp4", roots).kind,
    "error",
    "symlink media ref must fail",
  );
  assert.equal(
    cleanupModule.parseCanonicalMediaRef(
      "/api/renders/ancestor-escape.mp4",
      cleanupModule.mediaRootPaths(ancestorRoot),
    ).kind,
    "error",
    "a symlinked configured-root ancestor must fail",
  );
  assert.equal(
    cleanupModule.parseCanonicalMediaRef("https://cdn.example.test/external.mp4", roots).kind,
    "ignored",
    "arbitrary external URLs are not graph errors",
  );

  const graph = await graphModule.buildMediaReferenceGraph(NOW);

  assert.deepEqual(graph.scannedOwners, {
    video: 8,
    "video-job": 8,
    "project-draft": 16,
    "render-job": 3,
    "generated-image": 5,
  });

  for (const [key, expectedOwner, expectedExpiry] of [
    ["renders/free-boundary.mp4", "graph-project-free-boundary", NOW],
    ["renders/pro-boundary.mp4", "graph-project-pro-boundary", NOW],
    ["renders/business-boundary.mp4", "graph-project-business-boundary", NOW],
  ] as const) {
    const ref = refsFor(graph, key).find((candidate) => candidate.ownerId === expectedOwner);
    assert.ok(ref, `${key} must have its project owner`);
    assert.equal(ref.expiresAt?.toISOString(), expectedExpiry.toISOString());
    assert.equal(retentionModule.mediaReferenceIsLive(ref, NOW), true, "exact boundary remains live");
  }

  const savedRef = refsFor(graph, "renders/saved-does-not-renew.mp4").find(
    (ref) => ref.ownerId === "graph-project-saved",
  );
  assert.equal(
    savedRef?.expiresAt?.toISOString(),
    dateAtOffset(-17).toISOString(),
    "project save/open timestamps never renew media",
  );

  const galleryRefs = refsFor(graph, "renders/gallery-live.mp4");
  assert.equal(
    galleryRefs.find((ref) => ref.ownerKind === "video")?.expiresAt?.toISOString(),
    dateAtOffset(-2).toISOString(),
  );
  assert.equal(
    galleryRefs.find((ref) => ref.ownerKind === "video")?.critical,
    true,
    "Video.videoUrl is marked as a critical final playback reference",
  );
  assert.equal(
    refsFor(graph, "renders/video-audio.mp3").find((ref) => ref.ownerKind === "video")?.critical,
    undefined,
    "non-final Video media is not marked critical",
  );
  assert.equal(
    galleryRefs.some((ref) =>
      ref.ownerKind === "project-draft" &&
      ref.ownerId === "graph-project-latest-gallery" &&
      ref.alwaysProtect === true &&
      ref.critical === true
    ),
    true,
    "a non-archived latestVideo pointer fail-closes and preserves final-media criticality",
  );
  assert.equal(
    graph.errors.some((error) => error.ownerId === "graph-project-latest-gallery"),
    false,
    "a missing draft file supplied by latestVideoId uses the canonical Video expiry",
  );

  for (const [key, ownerId, projectId, expiry] of [
    ["renders/active-job.mp4", "graph-active-job", "graph-project-active-job", dateAtOffset(-3)],
    ["renders/active-export.mp4", "graph-active-export-job", "graph-project-active-export", dateAtOffset(-14)],
  ] as const) {
    const refs = refsFor(graph, key);
    const jobRef = refs.find((ref) => ref.ownerKind === "video-job" && ref.ownerId === ownerId);
    assert.equal(jobRef?.expiresAt?.toISOString(), expiry.toISOString());
    assert.equal(
      refs.some((ref) =>
        ref.ownerKind === "project-draft" &&
        ref.ownerId === projectId &&
        ref.alwaysProtect === true &&
        ref.critical === true
      ),
      true,
      "a non-archived active job/export pointer fail-closes and preserves final-media criticality",
    );
    assert.equal(
      graph.errors.some((error) => error.ownerId === projectId),
      false,
      "active job ownership avoids a false missing-file graph error",
    );
  }
  assert.equal(
    refsFor(graph, "renders/active-job.mp4").find(
      (ref) => ref.ownerKind === "video-job" && ref.ownerId === "graph-active-job",
    )?.critical,
    true,
    "top-level VideoJob outputJson.videoUrl is marked critical",
  );
  assert.equal(
    refsFor(graph, "renders/active-voice.mp3").find(
      (ref) => ref.ownerKind === "video-job" && ref.ownerId === "graph-active-job",
    )?.critical,
    undefined,
    "nested non-final VideoJob media is not marked critical",
  );
  for (const key of ["renders/provider-base.mp4", "renders/provider-voice.mp3", "renders/provider-intro.mp4"]) {
    const providerRef = refsFor(graph, key).find((ref) => ref.ownerId === "graph-provider-wait-job");
    assert.equal(providerRef?.ownerKind, "video-job", `${key} belongs to the waiting provider job`);
    assert.equal(providerRef?.alwaysProtect, true, `${key} is protected for the full provider wait`);
    assert.equal(providerRef?.expiresAt, null, `${key} has no cleanup deadline while waiting`);
  }
  assert.equal(
    refsFor(graph, "renders/preview-active-job-720p.mp4").some((ref) =>
      ref.ownerKind === "project-draft" &&
      ref.ownerId === "graph-project-active-job" &&
      ref.alwaysProtect === true
    ),
    true,
    "active project containment covers derived preview keys",
  );
  assert.equal(
    refsFor(graph, "renders/archived-video.mp4").some((ref) => ref.ownerKind === "project-draft"),
    false,
    "an archived project does not indefinitely protect its expired latest video",
  );
  const archivedInFlightRef = refsFor(graph, "renders/archived-inflight-input.mp4").find(
    (ref) => ref.ownerKind === "project-draft" && ref.ownerId === "graph-project-archived",
  );
  assert.equal(
    archivedInFlightRef?.expiresAt?.toISOString(),
    dateAtOffset(-17).toISOString(),
    "an archived project's in-flight pointer does not create indefinite draft protection",
  );
  assert.notEqual(archivedInFlightRef?.alwaysProtect, true);
  const sharedCriticalityProjectRef = refsFor(graph, "renders/shared-criticality.mp4").find(
    (ref) => ref.ownerKind === "project-draft" && ref.ownerId === "graph-project-active-job",
  );
  assert.equal(sharedCriticalityProjectRef?.alwaysProtect, true);
  assert.notEqual(
    sharedCriticalityProjectRef?.critical,
    true,
    "critical lineage comes from the exact pointer owner, not an unrelated owner sharing the key",
  );

  const processingActiveRef = refsFor(graph, "renders/processing-active-input.mp4").find(
    (ref) => ref.ownerId === "graph-project-processing-active",
  );
  assert.equal(processingActiveRef?.ownerKind, "project-draft");
  assert.equal(processingActiveRef?.expiresAt, null, "in-flight job expiry protects project inputs");
  assert.equal(
    graph.errors.some((error) => error.ownerId === "graph-project-processing-active"),
    false,
    "an in-flight active job prevents a false missing-file graph error",
  );
  const exportTransitionRef = refsFor(graph, "renders/active-job.mp4").find(
    (ref) => ref.ownerId === "graph-project-export-transition",
  );
  assert.equal(
    exportTransitionRef?.expiresAt,
    null,
    "in-flight export protection wins over the done preview's key-specific expiry",
  );
  const crossPointerRef = refsFor(graph, "renders/active-job.mp4").find(
    (ref) => ref.ownerId === "graph-project-cross-pointer",
  );
  assert.equal(crossPointerRef?.expiresAt?.toISOString(), NOW.toISOString());
  assert.ok(
    graph.errors.some((error) =>
      error.ownerId === "graph-project-cross-pointer" &&
      error.field === "activeJobId" &&
      error.code === "owner_mismatch"
    ),
    "cross-owner pointers fail closed instead of substituting another owner's expiry",
  );

  for (const [key, projectId, expectedExpiry] of [
    ["renders/unscoped-job.mp4", "graph-project-unscoped-job", dateAtOffset(2)],
    ["renders/unscoped-video.mp4", "graph-project-unscoped-video", dateAtOffset(6)],
  ] as const) {
    const keyRefs = refsFor(graph, key);
    const projectRef = keyRefs.find((ref) => ref.ownerId === projectId);
    assert.equal(
      projectRef?.expiresAt?.toISOString(),
      expectedExpiry.toISOString(),
      "same-user unscoped legacy pointers retain the mtime+plan project fallback",
    );
    assert.equal(
      retentionModule.effectiveMediaExpiry(keyRefs)?.toISOString(),
      expectedExpiry.toISOString(),
      "an earlier frozen unscoped owner expiry cannot shorten project retention",
    );
  }

  const sharedRefs = refsFor(graph, "renders/shared-owner.mp4");
  assert.deepEqual(new Set(sharedRefs.map((ref) => ref.ownerKind)), new Set(["video", "project-draft"]));
  assert.equal(
    retentionModule.effectiveMediaExpiry(sharedRefs)?.toISOString(),
    dateAtOffset(5).toISOString(),
    "multiple owners use the latest expiry",
  );
  assert.equal(retentionModule.effectiveMediaExpiry(refsFor(graph, "renders/null-protected.mp4")), null);
  assert.equal(retentionModule.effectiveMediaExpiry(refsFor(graph, "renders/null-job.mp4")), null);

  for (const key of [
    "renders/queued-output.mp4",
    "stocks/queued-stock.mp4",
    "renders/running-source.mp4",
    "renders/running-output.mp4",
  ]) {
    assert.equal(
      refsFor(graph, key).some((ref) => ref.ownerKind === "render-job" && ref.alwaysProtect === true),
      true,
      `${key} must be always protected while queued/running`,
    );
  }
  assert.equal(graph.refs.has("renders/done-render.mp4"), false, "terminal RenderJobs are not active owners");
  assert.equal(
    refsFor(graph, "stocks/generated-image.png").some(
      (ref) => ref.ownerKind === "generated-image" && ref.alwaysProtect === true,
    ),
    true,
  );

  const sourceRef = refsFor(graph, "renders/derived-video.mp4")[0];
  for (const key of [
    "renders/preview-derived-video-540p.mp4",
    "renders/preview-derived-video-720p.mp4",
  ]) {
    assert.deepEqual(refsFor(graph, key)[0], sourceRef, `${key} inherits its source protection`);
  }
  const stockSourceRef = refsFor(graph, "stocks/nested-stock.mp4")[0];
  assert.deepEqual(
    refsFor(graph, "stocks/nested-stock.mp4.normalized")[0],
    stockSourceRef,
    "normalized stock companion inherits source protection",
  );
  assert.equal(
    graph.refs.has("stocks/already.normalized.normalized"),
    false,
    "normalized companions are not recursively derived",
  );
  assert.ok(graph.refs.has("stocks/hash#stock.mp4"));
  assert.ok(
    graph.refs.has("stocks/hash#stock.mp4.normalized"),
    "derived stock keys preserve decoded URL-reserved basename characters",
  );
  assert.ok(graph.refs.has("renders/query?video.mp4"));
  assert.ok(
    graph.refs.has("renders/preview-query?video-720p.mp4"),
    "derived preview keys preserve decoded URL-reserved basename characters",
  );

  for (const key of [
    "renders/video-avatar.mp4",
    "renders/video-audio.mp3",
    "renders/video-thumb.jpg",
    "renders/thumbnail-overlay.png",
    "stocks/generated-nested.png",
    "stocks/scene-map.mp4",
  ]) {
    assert.ok(graph.refs.has(key), `Video media/nested config reference missing: ${key}`);
  }

  for (const expected of [
    { ownerKind: "video", ownerId: "graph-malformed-video", field: "renderConfig", code: "malformed_json" },
    { ownerKind: "video-job", ownerId: "graph-malformed-job", field: "outputJson", code: "malformed_json" },
    { ownerKind: "video-job", ownerId: "graph-missing-output-job", field: "outputJson", code: "missing_json" },
    { ownerKind: "project-draft", ownerId: "graph-project-malformed", field: "draftJson", code: "malformed_json" },
    { ownerKind: "render-job", ownerId: "graph-render-malformed", field: "payload", code: "malformed_json" },
    { ownerKind: "generated-image", ownerId: "graph-generated-symlink", field: "url", code: "media_path_symlink" },
    { ownerKind: "generated-image", ownerId: "graph-generated-traversal", field: "url", code: "media_path_invalid" },
    { ownerKind: "project-draft", ownerId: "graph-project-missing", field: "draftJson", code: "media_file_missing" },
  ] as const) {
    assert.ok(
      graph.errors.some((error) => Object.entries(expected).every(
        ([field, value]) => error[field as keyof typeof error] === value,
      )),
      `missing graph error ${JSON.stringify(expected)}`,
    );
  }
  assert.equal(
    graph.errors.some((error) => error.ownerId === "graph-processing-job" || error.ownerId === "graph-render-done"),
    false,
    "inactive owner JSON is outside the selected graph",
  );
  assert.equal(
    graph.errors.some((error) => error.ownerId === "graph-generated-external"),
    false,
    "external URLs are ignored without a graph error",
  );

  const incompleteCleanupPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
    olderThanDays: 1,
    includeStocks: true,
  });
  assert.ok(
    incompleteCleanupPlan.graphErrors.length > 0,
    "recognized DB parser/path errors remain visible to dry-run review",
  );
  assert.equal(
    incompleteCleanupPlan.candidates.length,
    0,
    "recognized DB parser/path errors cannot produce a movable manifest",
  );

  await Promise.all([
    prisma.generatedImage.deleteMany({
      where: { id: { in: ["graph-generated-symlink", "graph-generated-traversal"] } },
    }),
    prisma.video.deleteMany({ where: { id: "graph-malformed-video" } }),
    prisma.videoJob.deleteMany({
      where: { id: { in: ["graph-malformed-job", "graph-missing-output-job"] } },
    }),
    prisma.editorProject.deleteMany({
      where: {
        id: {
          in: [
            "graph-project-cross-pointer",
            "graph-project-missing",
            "graph-project-malformed",
          ],
        },
      },
    }),
    prisma.renderJob.deleteMany({ where: { id: "graph-render-malformed" } }),
  ]);
  writeMedia("renders", "null-protected.mp4", dateAtOffset(-30));
  const leafTarget = join(FIXTURE_ROOT, "cleanup-leaf-target.mp4");
  writeFileSync(leafTarget, "leaf-target");
  utimesSync(leafTarget, dateAtOffset(-30), dateAtOffset(-30));
  const leafLink = join(FIXTURE_ROOT, "public", "renders", "unreferenced-link.mp4");
  symlinkSync(leafTarget, leafLink);
  writeMedia("renders", "swap-after-plan.mp4", dateAtOffset(-30));

  const safeLegacyPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: FIXTURE_ROOT,
    now: NOW,
    olderThanDays: 1,
    includeStocks: true,
  });
  assert.equal(safeLegacyPlan.graphErrors.length, 0);
  assert.equal(
    safeLegacyPlan.candidates.some((candidate) => candidate.absolutePath === leafLink),
    false,
    "an unreferenced leaf symlink is never followed or selected",
  );
  assert.equal(
    safeLegacyPlan.candidates.some((candidate) => candidate.absolutePath.endsWith("null-protected.mp4")),
    false,
    "a legitimate referenced file remains protected",
  );
  const swapPath = join(FIXTURE_ROOT, "public", "renders", "swap-after-plan.mp4");
  const swapCandidate = safeLegacyPlan.candidates.find((candidate) => candidate.absolutePath === swapPath);
  assert.ok(swapCandidate, "regular old file is selected before the swap regression");
  rmSync(swapPath);
  symlinkSync(leafTarget, swapPath);
  const swappedPlan = {
    ...safeLegacyPlan,
    candidates: [swapCandidate],
    manifestSha256: quarantineModule.manifestSha256ForRecords([swapCandidate]),
  };
  await assert.rejects(
    cleanupModule.applyMediaCleanupPlan(swappedPlan, swappedPlan.manifestSha256, { now: NOW }),
    /invalid media manifest record/,
    "apply rechecks with no-follow semantics after planning",
  );
  assert.equal(lstatSync(swapPath).isSymbolicLink(), true, "swapped symlink is left untouched");

  const rootSymlinkCwd = join(FIXTURE_ROOT, "cleanup-root-symlink");
  const rootSymlinkTarget = join(FIXTURE_ROOT, "cleanup-root-target");
  mkdirSync(join(rootSymlinkCwd, "public"), { recursive: true });
  mkdirSync(join(rootSymlinkCwd, "stocks"), { recursive: true });
  mkdirSync(rootSymlinkTarget);
  symlinkSync(rootSymlinkTarget, join(rootSymlinkCwd, "public", "renders"));
  const rootSymlinkPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: rootSymlinkCwd,
    now: NOW,
    olderThanDays: 1,
  });
  assert.ok(
    rootSymlinkPlan.graphErrors.some((error) => error.code === "media_path_symlink"),
    "a symlinked media root makes planning incomplete",
  );
  assert.equal(rootSymlinkPlan.candidates.length, 0);

  const ancestorSymlinkCwd = join(FIXTURE_ROOT, "cleanup-ancestor-symlink");
  const ancestorPublicTarget = join(FIXTURE_ROOT, "cleanup-ancestor-public-target");
  mkdirSync(ancestorSymlinkCwd);
  mkdirSync(join(ancestorSymlinkCwd, "stocks"));
  mkdirSync(join(ancestorPublicTarget, "renders"), { recursive: true });
  symlinkSync(ancestorPublicTarget, join(ancestorSymlinkCwd, "public"));
  const ancestorSymlinkPlan = await cleanupModule.getMediaCleanupPlan({
    cwd: ancestorSymlinkCwd,
    now: NOW,
    olderThanDays: 1,
  });
  assert.ok(
    ancestorSymlinkPlan.graphErrors.some((error) => error.code === "media_path_outside_root"),
    "a symlinked media-root ancestor makes planning incomplete",
  );
  assert.equal(ancestorSymlinkPlan.candidates.length, 0);

  console.log("PASS media reference graph");
}

let prisma: PrismaClient | undefined;
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (prisma) await prisma.$disconnect();
    } finally {
      process.chdir(REPO_ROOT);
      rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    }
  });
