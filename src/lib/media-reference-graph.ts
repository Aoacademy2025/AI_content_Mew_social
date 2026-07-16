import fs from "node:fs";
import {
  collectCanonicalMediaRefs,
  mediaRootPaths,
  parseCanonicalMediaRef,
  type CanonicalMediaRef,
  type MediaKey,
} from "@/lib/media-cleanup";
import { lowResPreviewFilenamesForRender } from "@/lib/low-res-preview-paths";
import { prisma } from "@/lib/prisma";
import {
  effectiveMediaExpiry,
  expiryForMedia,
  type MediaReference,
} from "@/lib/media-retention";
import { parseAvatarProviderCheckpoint } from "@/lib/mcp/avatar-provider-checkpoint";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";

export type MediaGraphError = {
  ownerKind: MediaReference["ownerKind"];
  ownerId: string;
  field: string;
  code: string;
};

export type MediaGraph = {
  refs: Map<string, MediaReference[]>;
  errors: MediaGraphError[];
  scannedOwners: Record<MediaReference["ownerKind"], number>;
};

export type MediaGraphBuildOptions = {
  workspaceRoot?: string;
  ignoreQuarantineRunIds?: ReadonlySet<string>;
  inFlightQuarantinedMedia?: ReadonlyMap<MediaKey, { mtimeMs: number }>;
};

type Owner = Pick<MediaReference, "ownerKind" | "ownerId">;
type ProjectScopedOwner = { userId: string; projectId: string | null };

const JSON_VIDEO_FIELDS = [
  "thumbnailConfig",
  "renderConfig",
  "generatedImages",
  "sceneMapping",
] as const;
const DIRECT_VIDEO_FIELDS = [
  "videoUrl",
  "avatarVideoUrl",
  "audioUrl",
  "thumbnail",
] as const;

function derivedKeys(ref: CanonicalMediaRef): MediaKey[] {
  if (ref.area === "renders") {
    return lowResPreviewFilenamesForRender(ref.filename).map(
      (filename): MediaKey => `renders/${filename}`,
    );
  }
  if (!ref.filename.endsWith(".normalized")) {
    return [`stocks/${ref.filename}.normalized`];
  }
  return [];
}

export async function buildMediaReferenceGraph(
  now = new Date(),
  options: MediaGraphBuildOptions = {},
): Promise<MediaGraph> {
  const refs = new Map<string, MediaReference[]>();
  const errors: MediaGraphError[] = [];
  const scannedOwners: MediaGraph["scannedOwners"] = {
    video: 0,
    "video-job": 0,
    "project-draft": 0,
    "render-job": 0,
    "generated-image": 0,
  };
  const roots = mediaRootPaths(options.workspaceRoot);
  const errorKeys = new Set<string>();
  let quarantinedMedia = new Map<MediaKey, { mtimeMs: number }>(options.inFlightQuarantinedMedia);

  function addError(owner: Owner, field: string, code: string): void {
    const identity = `${owner.ownerKind}\0${owner.ownerId}\0${field}\0${code}`;
    if (errorKeys.has(identity)) return;
    errorKeys.add(identity);
    errors.push({ ...owner, field, code });
  }

  async function safeQuery<T>(
    ownerKind: MediaReference["ownerKind"],
    query: () => Promise<T[]>,
  ): Promise<T[]> {
    try {
      const rows = await query();
      scannedOwners[ownerKind] = rows.length;
      return rows;
    } catch {
      addError({ ownerKind, ownerId: "*" }, "$query", "db_query_failed");
      return [];
    }
  }

  async function safeSupplementalQuery<T>(
    ownerKind: MediaReference["ownerKind"],
    field: string,
    query: () => Promise<T[]>,
  ): Promise<T[]> {
    try {
      return await query();
    } catch {
      addError({ ownerKind, ownerId: "*" }, field, "db_query_failed");
      return [];
    }
  }

  function addKey(key: MediaKey, reference: MediaReference): void {
    const current = refs.get(key) ?? [];
    const existing = current.find(
      (candidate) => candidate.ownerKind === reference.ownerKind && candidate.ownerId === reference.ownerId,
    );
    if (existing) {
      if (reference.alwaysProtect) existing.alwaysProtect = true;
      if (reference.critical) existing.critical = true;
      return;
    }
    current.push({ ...reference });
    refs.set(key, current);
  }

  function addCanonicalRef(
    canonicalRef: CanonicalMediaRef,
    reference: MediaReference,
    field: string,
  ): Set<MediaKey> {
    const keys = new Set<MediaKey>([canonicalRef.key]);
    addKey(canonicalRef.key, reference);

    for (const derivedKey of derivedKeys(canonicalRef)) {
      const [area, ...filenameParts] = derivedKey.split("/");
      const filename = filenameParts.join("/");
      const encodedFilename = encodeURIComponent(filename);
      const derived = parseCanonicalMediaRef(
        area === "renders"
          ? `/api/renders/${encodedFilename}`
          : `/api/stocks/${encodedFilename}`,
        roots,
      );
      if (derived.kind === "error") {
        addError(reference, field, derived.code);
        continue;
      }
      if (derived.kind !== "reference") {
        addError(reference, field, "media_path_invalid");
        continue;
      }
      keys.add(derived.ref.key);
      addKey(derived.ref.key, reference);
    }
    return keys;
  }

  function collectOwnerValue(
    value: unknown,
    reference: MediaReference,
    field: string,
  ): { canonicalRefs: CanonicalMediaRef[]; keys: Set<MediaKey> } {
    const collected = collectCanonicalMediaRefs(value, roots);
    for (const code of collected.errors) addError(reference, field, code);

    const canonicalRefs = new Map<MediaKey, CanonicalMediaRef>();
    for (const canonicalRef of collected.refs) canonicalRefs.set(canonicalRef.key, canonicalRef);
    const keys = new Set<MediaKey>();
    for (const canonicalRef of canonicalRefs.values()) {
      for (const key of addCanonicalRef(canonicalRef, reference, field)) keys.add(key);
    }
    return { canonicalRefs: [...canonicalRefs.values()], keys };
  }

  function parseJsonOwnerField(
    raw: string | null,
    reference: MediaReference,
    field: string,
  ): unknown | null {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      addError(reference, field, "malformed_json");
      return null;
    }
  }

  try {
    const { buildQuarantinedMediaIndex } = await import("./media-quarantine");
    const persistedQuarantined = await buildQuarantinedMediaIndex(roots.workspaceRoot, {
      ignoreRunIds: options.ignoreQuarantineRunIds,
    });
    for (const [key, record] of persistedQuarantined) {
      if (!quarantinedMedia.has(key)) quarantinedMedia.set(key, { mtimeMs: record.mtimeMs });
    }
  } catch {
    addError(
      { ownerKind: "project-draft", ownerId: "*" },
      "$quarantine",
      "quarantine_manifest_invalid",
    );
  }

  const [videos, videoJobs, inFlightVideoJobs, projects, renderJobs, generatedImages] = await Promise.all([
    safeQuery("video", () => prisma.video.findMany({
      select: {
        id: true,
        userId: true,
        projectId: true,
        expiresAt: true,
        videoUrl: true,
        avatarVideoUrl: true,
        audioUrl: true,
        thumbnail: true,
        thumbnailConfig: true,
        renderConfig: true,
        generatedImages: true,
        sceneMapping: true,
      },
    })),
    safeQuery("video-job", () => prisma.videoJob.findMany({
      where: { status: { in: ["done", "waiting_provider"] } },
      select: {
        id: true,
        userId: true,
        projectId: true,
        status: true,
        outputJson: true,
        mediaExpiresAt: true,
        providerCheckpointJson: true,
      },
    })),
    safeSupplementalQuery("video-job", "$inputQuery", () => prisma.videoJob.findMany({
      where: { status: { in: ["queued", "processing"] } },
      select: {
        id: true,
        inputJson: true,
      },
    })),
    safeQuery("project-draft", () => prisma.editorProject.findMany({
      select: {
        id: true,
        userId: true,
        status: true,
        draftJson: true,
        activeJobId: true,
        activeExportJobId: true,
        latestVideoId: true,
        user: { select: { plan: true } },
      },
    })),
    safeQuery("render-job", () => prisma.renderJob.findMany({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
      select: {
        id: true,
        payload: true,
        videoUrl: true,
      },
    })),
    safeQuery("generated-image", () => prisma.generatedImage.findMany({
      select: {
        id: true,
        url: true,
      },
    })),
  ]);

  const videoKeysById = new Map<string, Set<MediaKey>>();
  const videoOwnerById = new Map<string, ProjectScopedOwner>();
  for (const video of videos) {
    const reference: MediaReference = {
      ownerKind: "video",
      ownerId: video.id,
      expiresAt: video.expiresAt,
    };
    const ownerKeys = new Set<MediaKey>();
    for (const field of DIRECT_VIDEO_FIELDS) {
      const fieldReference = field === "videoUrl"
        ? { ...reference, critical: true }
        : reference;
      for (const key of collectOwnerValue(video[field], fieldReference, field).keys) ownerKeys.add(key);
    }
    for (const field of JSON_VIDEO_FIELDS) {
      const parsed = parseJsonOwnerField(video[field], reference, field);
      for (const key of collectOwnerValue(parsed, reference, field).keys) ownerKeys.add(key);
    }
    videoKeysById.set(video.id, ownerKeys);
    videoOwnerById.set(video.id, { userId: video.userId, projectId: video.projectId });
  }

  const videoJobKeysById = new Map<string, Set<MediaKey>>();
  const videoJobOwnerById = new Map<string, ProjectScopedOwner>();
  for (const job of inFlightVideoJobs) {
    const reference: MediaReference = {
      ownerKind: "video-job",
      ownerId: job.id,
      expiresAt: null,
      alwaysProtect: true,
    };
    const input = parseJsonOwnerField(job.inputJson, reference, "inputJson");
    collectOwnerValue(input, reference, "inputJson");
  }
  for (const job of videoJobs) {
    const waitingForProvider = job.status === "waiting_provider";
    const reference: MediaReference = {
      ownerKind: "video-job",
      ownerId: job.id,
      expiresAt: waitingForProvider ? null : job.mediaExpiresAt,
      alwaysProtect: waitingForProvider || undefined,
    };
    if (waitingForProvider) {
      const checkpoint = parseAvatarProviderCheckpoint(job.providerCheckpointJson);
      const ownerKeys = new Set<MediaKey>();
      if (!checkpoint) {
        addError(reference, "providerCheckpointJson", job.providerCheckpointJson ? "malformed_json" : "missing_json");
      } else {
        const checkpointMedia = {
          baseUrl: checkpoint.baseUrl,
          voiceUrl: checkpoint.voiceUrl,
          introVideoUrl: checkpoint.avatar.introVideoUrl,
          tailVideoUrl: checkpoint.avatar.tailVideoUrl,
        };
        for (const [field, value] of Object.entries(checkpointMedia)) {
          for (const key of collectOwnerValue(value, reference, `providerCheckpointJson.${field}`).keys) ownerKeys.add(key);
        }
      }
      videoJobKeysById.set(job.id, ownerKeys);
      videoJobOwnerById.set(job.id, { userId: job.userId, projectId: job.projectId });
      continue;
    }
    if (job.outputJson === null) {
      addError(reference, "outputJson", "missing_json");
      videoJobKeysById.set(job.id, new Set());
      videoJobOwnerById.set(job.id, { userId: job.userId, projectId: job.projectId });
      continue;
    }
    const output = parseJsonOwnerField(job.outputJson, reference, "outputJson");
    const ownerKeys = new Set<MediaKey>();
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const finalVideoUrl = (output as Record<string, unknown>).videoUrl;
      for (const key of collectOwnerValue(
        finalVideoUrl,
        { ...reference, critical: true },
        "outputJson.videoUrl",
      ).keys) ownerKeys.add(key);
    }
    for (const key of collectOwnerValue(output, reference, "outputJson").keys) ownerKeys.add(key);
    videoJobKeysById.set(job.id, ownerKeys);
    videoJobOwnerById.set(job.id, { userId: job.userId, projectId: job.projectId });
  }

  const activePointerIds = [...new Set(projects.flatMap(
    (project) => [project.activeJobId, project.activeExportJobId].filter(
      (jobId): jobId is string => Boolean(jobId),
    ),
  ))];
  const inFlightJobById = new Map<string, ProjectScopedOwner & { mediaExpiresAt: Date | null }>();
  if (activePointerIds.length > 0) {
    try {
      const inFlightJobs = await prisma.videoJob.findMany({
        where: {
          id: { in: activePointerIds },
          status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] },
        },
        select: {
          id: true,
          userId: true,
          projectId: true,
          mediaExpiresAt: true,
        },
      });
      for (const job of inFlightJobs) {
        inFlightJobById.set(job.id, {
          userId: job.userId,
          projectId: job.projectId,
          mediaExpiresAt: job.mediaExpiresAt,
        });
      }
    } catch {
      addError({ ownerKind: "video-job", ownerId: "*" }, "$activeQuery", "db_query_failed");
    }
  }

  for (const renderJob of renderJobs) {
    const reference: MediaReference = {
      ownerKind: "render-job",
      ownerId: renderJob.id,
      expiresAt: null,
      alwaysProtect: true,
    };
    const payload = parseJsonOwnerField(renderJob.payload, reference, "payload");
    collectOwnerValue(payload, reference, "payload");
    collectOwnerValue(renderJob.videoUrl, reference, "videoUrl");
  }

  for (const image of generatedImages) {
    const reference: MediaReference = {
      ownerKind: "generated-image",
      ownerId: image.id,
      expiresAt: null,
      alwaysProtect: true,
    };
    collectOwnerValue(image.url, reference, "url");
  }

  for (const project of projects) {
    const owner: Owner = { ownerKind: "project-draft", ownerId: project.id };
    const ownerRef: MediaReference = { ...owner, expiresAt: null };
    const draft = parseJsonOwnerField(project.draftJson, ownerRef, "draftJson");
    const collected = collectCanonicalMediaRefs(draft, roots);
    for (const code of collected.errors) addError(owner, "draftJson", code);

    const activeOwnerKeys = new Map<MediaKey, boolean>();
    const inFlightExpiries: Array<{ expiresAt: Date | null }> = [];
    const exactProjectOwnerMatches = (candidate: ProjectScopedOwner): boolean =>
      candidate.userId === project.userId && candidate.projectId === project.id;
    const ownerConflictsWithProject = (candidate: ProjectScopedOwner): boolean =>
      candidate.userId !== project.userId ||
      (candidate.projectId !== null && candidate.projectId !== project.id);
    const addExactOwnerKeys = (
      keys: Iterable<MediaKey>,
      ownerKind: "video" | "video-job",
      ownerId: string,
    ): void => {
      for (const key of keys) {
        const exactOwnerIsCritical = refs.get(key)?.some((ref) =>
          ref.ownerKind === ownerKind && ref.ownerId === ownerId && ref.critical === true
        ) ?? false;
        activeOwnerKeys.set(key, activeOwnerKeys.get(key) === true || exactOwnerIsCritical);
      }
    };
    for (const [field, jobId] of [
      ["activeJobId", project.activeJobId],
      ["activeExportJobId", project.activeExportJobId],
    ] as const) {
      if (!jobId) continue;
      const doneOwner = videoJobOwnerById.get(jobId);
      const inFlightOwner = inFlightJobById.get(jobId);
      if (doneOwner) {
        if (exactProjectOwnerMatches(doneOwner)) {
          addExactOwnerKeys(videoJobKeysById.get(jobId) ?? [], "video-job", jobId);
        } else if (ownerConflictsWithProject(doneOwner)) {
          addError(owner, field, "owner_mismatch");
        }
      }
      if (inFlightOwner) {
        // An unscoped in-flight job may still be actively consuming every direct draft file.
        // Preserve it conservatively; unlike frozen done/latest expiry, null cannot shorten life.
        if (ownerConflictsWithProject(inFlightOwner)) {
          addError(owner, field, "owner_mismatch");
        } else if (project.status !== "archived") {
          inFlightExpiries.push({ expiresAt: inFlightOwner.mediaExpiresAt });
        }
      }
    }
    if (project.latestVideoId) {
      const latestVideoOwner = videoOwnerById.get(project.latestVideoId);
      if (latestVideoOwner && exactProjectOwnerMatches(latestVideoOwner)) {
        addExactOwnerKeys(videoKeysById.get(project.latestVideoId) ?? [], "video", project.latestVideoId);
      } else if (latestVideoOwner && ownerConflictsWithProject(latestVideoOwner)) {
        addError(owner, "latestVideoId", "owner_mismatch");
      }
    }
    if (project.status !== "archived") {
      for (const [key, critical] of activeOwnerKeys) {
        addKey(key, {
          ...owner,
          expiresAt: null,
          alwaysProtect: true,
          critical: critical || undefined,
        });
      }
    }

    const uniqueDirectRefs = new Map<MediaKey, CanonicalMediaRef>();
    for (const canonicalRef of collected.refs) uniqueDirectRefs.set(canonicalRef.key, canonicalRef);
    for (const canonicalRef of uniqueDirectRefs.values()) {
      if (inFlightExpiries.length > 0) {
        addCanonicalRef(
          canonicalRef,
          {
            ...owner,
            expiresAt: effectiveMediaExpiry(inFlightExpiries),
          },
          "draftJson",
        );
        continue;
      }
      if (activeOwnerKeys.has(canonicalRef.key)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(canonicalRef.absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const quarantined = code === "ENOENT" || code === "ENOTDIR"
          ? quarantinedMedia.get(canonicalRef.key)
          : undefined;
        if (quarantined && Number.isFinite(quarantined.mtimeMs)) {
          addCanonicalRef(
            canonicalRef,
            {
              ...owner,
              expiresAt: expiryForMedia(project.user.plan, new Date(quarantined.mtimeMs)),
            },
            "draftJson",
          );
          continue;
        }
        addError(
          owner,
          "draftJson",
          code === "ENOENT" || code === "ENOTDIR" ? "media_file_missing" : "media_file_stat_failed",
        );
        continue;
      }
      if (stat.isSymbolicLink()) {
        addError(owner, "draftJson", "media_path_symlink");
        continue;
      }
      if (!stat.isFile()) {
        addError(owner, "draftJson", "media_path_invalid");
        continue;
      }

      const reference: MediaReference = {
        ...owner,
        expiresAt: expiryForMedia(project.user.plan, stat.mtime),
      };
      addCanonicalRef(canonicalRef, reference, "draftJson");
    }
  }

  // The clock becomes part of eligibility in Task 5. Validate it now so callers cannot build
  // a graph with an unusable clock and then accidentally treat it as complete.
  if (!Number.isFinite(now.getTime())) {
    addError({ ownerKind: "project-draft", ownerId: "*" }, "$clock", "invalid_clock");
  }

  return { refs, errors, scannedOwners };
}
