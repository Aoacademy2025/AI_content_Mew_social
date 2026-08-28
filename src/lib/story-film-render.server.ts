import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { buildHeroSubtitleOverlayConfig } from "@/lib/hero-editorial";
import {
  captionsForStoryFilmEditorial,
  fallbackStoryFilmCaptionTrack,
  parseStoryFilmCaptionTrack,
  parseStoryFilmEditorialConfig,
  storyFilmSubtitleDesign,
  type StoryFilmCaptionTrack,
  type StoryFilmEditorialConfig,
} from "@/lib/story-film-editorial";
import { prepareRemotionBundlePublicDir } from "@/lib/render/remotion-public-dir";
import { runRender } from "@/lib/render/run-render";
import { probeVideoMedia } from "@/lib/video-media-probe.server";
import type { SubtitleOverlayConfig } from "@/remotion/types";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MAX_DURATION_MS = 180_000;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{8,160}$/;

type RenderSegment = {
  sceneKey: string;
  startMs: number;
  endMs: number;
  visualOwner: "broll" | "presenter";
  sourceKind: "image" | "video" | "presenter";
  sourcePath: string;
  sourceExcerpt: string;
};

export type StoryFilmRenderPlan = {
  projectId: string;
  jobId: string;
  durationMs: number;
  narrationPath: string;
  musicPath: string;
  outputPath: string;
  outputUrl: string;
  segments: RenderSegment[];
  editorial: StoryFilmEditorialConfig;
  captionTrack: StoryFilmCaptionTrack;
};

declare global {
  // eslint-disable-next-line no-var
  var __storyFilmEditorialBundleCache: { location: string | null; mtime: string } | undefined;
}

const editorialBundleCache = {
  get: () => global.__storyFilmEditorialBundleCache ?? { location: null, mtime: "" },
  set: (location: string | null, mtime: string) => {
    global.__storyFilmEditorialBundleCache = { location, mtime };
  },
};

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function runFfmpeg(args: string[], timeout = 10 * 60_000) {
  return new Promise<void>((resolve, reject) => {
    execFile(getFfmpegPath(), args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = stderr.trim().split("\n").slice(-12).join("\n");
      reject(new Error(`story_film_ffmpeg_failed: ${detail || error.message}`));
    });
  });
}

function leafFromMediaUrl(rawUrl: string, prefix: string) {
  if (!rawUrl.startsWith(prefix)) return null;
  let value = "";
  try { value = decodeURIComponent(rawUrl.slice(prefix.length)); } catch { return null; }
  if (!value || value !== path.basename(value) || /[\\/\0]/u.test(value)) return null;
  return value;
}

async function resolveLocalMedia(
  rawUrl: string,
  workspaceRoot: string,
  allowed: ReadonlyArray<"renders" | "music">,
) {
  const candidates: Array<{ directory: "renders" | "music"; prefix: string }> = [
    { directory: "renders", prefix: "/api/renders/" },
    { directory: "renders", prefix: "/renders/" },
    { directory: "music", prefix: "/api/music/" },
    { directory: "music", prefix: "/music/" },
  ];
  for (const candidate of candidates) {
    if (!allowed.includes(candidate.directory)) continue;
    const leaf = leafFromMediaUrl(rawUrl, candidate.prefix);
    if (!leaf) continue;
    const directory = path.resolve(workspaceRoot, "public", candidate.directory);
    const filePath = path.resolve(directory, leaf);
    if (!filePath.startsWith(`${directory}${path.sep}`)) break;
    const [realDirectory, realFile] = await Promise.all([fs.realpath(directory), fs.realpath(filePath)]);
    if (!realFile.startsWith(`${realDirectory}${path.sep}`)) throw new Error("story_film_media_path_escape");
    const stats = await fs.stat(realFile);
    if (!stats.isFile() || stats.size <= 0) throw new Error("story_film_media_missing");
    return realFile;
  }
  throw new Error("story_film_media_url_not_local");
}

function latestArtifactByScene<T extends { sceneKey: string | null; kind: string }>(artifacts: T[]) {
  const latest = new Map<string, T>();
  for (const artifact of artifacts) {
    if (!artifact.sceneKey) continue;
    const key = `${artifact.kind}:${artifact.sceneKey}`;
    if (!latest.has(key)) latest.set(key, artifact);
  }
  return latest;
}

export async function buildStoryFilmRenderPlan(
  jobId: string,
  options: { workspaceRoot?: string } = {},
): Promise<StoryFilmRenderPlan> {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error("story_film_render_job_id_invalid");
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const job = await prisma.storyFilmGenerationJob.findUnique({
    where: { id: jobId },
    include: { project: { include: { presenterAsset: true } } },
  });
  if (!job || job.kind !== "final_render" || job.providerBackend !== "hero_render" || job.stage !== "final_render") {
    throw new Error("story_film_render_job_invalid");
  }
  const project = job.project;
  if (project.stage !== "final_render" || project.generationEpoch !== job.generationEpoch) {
    throw new Error("story_film_render_job_stale");
  }
  const durationMs = project.narrationDurationMs ?? 0;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    throw new Error("story_film_render_duration_invalid");
  }
  if (!project.narrationMasterUrl) throw new Error("story_film_render_narration_missing");
  if (!project.musicUrl) throw new Error("story_film_render_music_missing");

  const latestScene = await prisma.storyFilmScene.findFirst({
    where: { projectId: project.id },
    orderBy: [{ generationEpoch: "desc" }, { sequence: "asc" }],
  });
  if (!latestScene) throw new Error("story_film_render_storyboard_missing");
  const scenes = await prisma.storyFilmScene.findMany({
    where: { projectId: project.id, generationEpoch: latestScene.generationEpoch },
    orderBy: { sequence: "asc" },
  });
  if (scenes.length === 0
    || scenes[0].startMs !== 0
    || scenes.at(-1)?.endMs !== durationMs
    || scenes.some((scene, index) => (
      scene.sequence !== index
      || scene.endMs <= scene.startMs
      || (index > 0 && scene.startMs !== scenes[index - 1].endMs)
    ))) {
    throw new Error("story_film_render_timeline_invalid");
  }

  const artifacts = await prisma.storyFilmArtifact.findMany({
    where: {
      projectId: project.id,
      kind: { in: ["keyframe_image", "scene_video"] },
    },
    orderBy: { createdAt: "desc" },
  });
  const narrationArtifact = await prisma.storyFilmArtifact.findFirst({
    where: { projectId: project.id, kind: "narration_voice" },
    orderBy: { createdAt: "desc" },
  });
  const alignmentArtifact = await prisma.storyFilmArtifact.findFirst({
    where: { projectId: project.id, kind: "caption_alignment" },
    orderBy: { createdAt: "desc" },
  });
  const latest = latestArtifactByScene(artifacts);
  const presenterPath = project.presentationMode === "presenter_led"
    ? await resolveLocalMedia(
        project.presenterAsset?.storageUrl ?? "",
        workspaceRoot,
        ["renders"],
      )
    : null;
  const segments: RenderSegment[] = [];
  for (const scene of scenes) {
    const presenterOwned = project.presentationMode === "presenter_led" && scene.visualOwner === "presenter";
    if (presenterOwned) {
      if (!presenterPath) throw new Error(`story_film_presenter_missing:${scene.sceneKey}`);
      segments.push({
        sceneKey: scene.sceneKey,
        startMs: scene.startMs,
        endMs: scene.endMs,
        visualOwner: "presenter",
        sourceKind: "presenter",
        sourcePath: presenterPath,
        sourceExcerpt: scene.sourceExcerpt,
      });
      continue;
    }
    const video = latest.get(`scene_video:${scene.sceneKey}`);
    const image = latest.get(`keyframe_image:${scene.sceneKey}`);
    const source = scene.mediaPlan === "video" ? video : image;
    if (!source) throw new Error(`story_film_scene_artifact_missing:${scene.sceneKey}`);
    const sourceKind = source.kind === "scene_video" ? "video" : "image";
    segments.push({
      sceneKey: scene.sceneKey,
      startMs: scene.startMs,
      endMs: scene.endMs,
      visualOwner: "broll",
      sourceKind,
      sourcePath: await resolveLocalMedia(source.storageUrl, workspaceRoot, ["renders"]),
      sourceExcerpt: scene.sourceExcerpt,
    });
  }

  const outputName = `story-film-final-${job.id}.mp4`;
  const payload = parsePayload(job.payloadJson);
  let alignedCaptionTrack: StoryFilmCaptionTrack | null = null;
  if (alignmentArtifact) {
    try {
      const alignmentPath = await resolveLocalMedia(alignmentArtifact.storageUrl, workspaceRoot, ["renders"]);
      const alignmentDocument = JSON.parse(await fs.readFile(alignmentPath, "utf8")) as { track?: unknown };
      alignedCaptionTrack = parseStoryFilmCaptionTrack(alignmentDocument.track);
    } catch {
      alignedCaptionTrack = null;
    }
  }
  const storedCaptionTrack = alignedCaptionTrack ?? (narrationArtifact
    ? parseStoryFilmCaptionTrack(parsePayload(narrationArtifact.metadataJson).captionTrack)
    : null);
  return {
    projectId: project.id,
    jobId: job.id,
    durationMs,
    narrationPath: await resolveLocalMedia(project.narrationMasterUrl, workspaceRoot, ["renders"]),
    musicPath: await resolveLocalMedia(project.musicUrl, workspaceRoot, ["music"]),
    outputPath: path.join(workspaceRoot, "public", "renders", outputName),
    outputUrl: `/api/renders/${outputName}`,
    segments,
    editorial: parseStoryFilmEditorialConfig(payload.editorial, durationMs),
    captionTrack: storedCaptionTrack ?? fallbackStoryFilmCaptionTrack(segments),
  };
}

function seconds(ms: number) {
  return (ms / 1_000).toFixed(3);
}

async function renderSegment(segment: RenderSegment, destination: string) {
  const durationMs = segment.endMs - segment.startMs;
  const commonOutput = [
    "-an",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p",
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-t", seconds(durationMs),
    destination,
  ];
  if (segment.sourceKind === "presenter") {
    await runFfmpeg([
      "-y",
      "-ss", seconds(segment.startMs),
      "-i", segment.sourcePath,
      ...commonOutput,
    ]);
    return;
  }
  if (segment.sourceKind === "video") {
    await runFfmpeg([
      "-y",
      "-stream_loop", "-1",
      "-i", segment.sourcePath,
      ...commonOutput,
    ]);
    return;
  }
  const frameCount = Math.max(1, Math.round(durationMs * FPS / 1_000));
  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-framerate", String(FPS),
    "-i", segment.sourcePath,
    "-an",
    "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1,format=yuv420p`,
    "-frames:v", String(frameCount),
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    destination,
  ]);
}

async function validMaster(filePath: string, durationMs: number) {
  try {
    const [metadata, stats] = await Promise.all([probeVideoMedia(filePath), fs.stat(filePath)]);
    return Boolean(metadata
      && metadata.width === WIDTH
      && metadata.height === HEIGHT
      && metadata.durationMs <= MAX_DURATION_MS
      && Math.abs(metadata.durationMs - durationMs) <= 750
      && stats.isFile()
      && stats.size > 0);
  } catch {
    return false;
  }
}

function storyFilmBaseFingerprint(plan: StoryFilmRenderPlan) {
  return createHash("sha256").update(JSON.stringify({
    projectId: plan.projectId,
    durationMs: plan.durationMs,
    narrationPath: plan.narrationPath,
    musicPath: plan.musicPath,
    segments: plan.segments.map((segment) => ({
      sceneKey: segment.sceneKey,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceKind: segment.sourceKind,
      sourcePath: segment.sourcePath,
    })),
  })).digest("hex").slice(0, 24);
}

async function ensureStoryFilmBaseMaster(plan: StoryFilmRenderPlan, temporaryDirectory: string) {
  const rendersDirectory = path.dirname(plan.outputPath);
  const filename = `story-film-base-${plan.projectId}-${storyFilmBaseFingerprint(plan)}.mp4`;
  const basePath = path.join(rendersDirectory, filename);
  if (await validMaster(basePath, plan.durationMs)) {
    return { path: basePath, url: `/api/renders/${filename}`, recovered: true };
  }

  const segmentPaths: string[] = [];
  for (let index = 0; index < plan.segments.length; index += 1) {
    const segmentPath = path.join(temporaryDirectory, `segment-${String(index).padStart(3, "0")}.mp4`);
    await renderSegment(plan.segments[index], segmentPath);
    segmentPaths.push(segmentPath);
  }
  const concatList = path.join(temporaryDirectory, "segments.txt");
  await fs.writeFile(
    concatList,
    `${segmentPaths.map((item) => `file '${item.replace(/'/gu, "'\\''")}'`).join("\n")}\n`,
    "utf8",
  );
  const silentMaster = path.join(temporaryDirectory, "silent-master.mp4");
  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c:v", "copy",
    "-an",
    silentMaster,
  ]);

  const durationSec = seconds(plan.durationMs);
  const fadeDuration = Math.min(2, plan.durationMs / 3_000);
  const fadeStart = Math.max(0, plan.durationMs / 1_000 - fadeDuration);
  const stagedBase = path.join(rendersDirectory, `.${filename}.${process.pid}.tmp.mp4`);
  try {
    await runFfmpeg([
      "-y",
      "-i", silentMaster,
      "-i", plan.narrationPath,
      "-stream_loop", "-1",
      "-i", plan.musicPath,
      "-filter_complex",
      `[1:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS[voice];[2:a]volume=0.12,atrim=0:${durationSec},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`,
      "-map", "0:v:0",
      "-map", "[a]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", durationSec,
      "-movflags", "+faststart",
      stagedBase,
    ]);
    if (!await validMaster(stagedBase, plan.durationMs)) throw new Error("story_film_base_output_invalid");
    await fs.rename(stagedBase, basePath);
  } finally {
    await fs.rm(stagedBase, { force: true }).catch(() => {});
  }
  return { path: basePath, url: `/api/renders/${filename}`, recovered: false };
}

function storyFilmMediaOrigin() {
  const raw = process.env.RENDER_INTERNAL_BASE_URL?.trim()
    || `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("story_film_render_media_origin_invalid");
  return raw.replace(/\/$/u, "");
}

async function renderWithHeroEditorialEngine(
  jobId: string,
  config: SubtitleOverlayConfig,
  rendersDir: string,
) {
  const renderer = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);
  const { cancel, cancelSignal } = renderer.makeCancelSignal();
  const result = await runRender({
    isSubtitleOverlay: true,
    isShortVideo: false,
    isAvatarMode: false,
    resolvedSubtitleConfig: config,
    resolvedShortConfig: null,
    resolvedScenes: null,
    audioUrl: null,
    captionsData: null,
    avatarVideoUrl: null,
    durationInFrames: config.durationInFrames,
    customWidth: WIDTH,
    customHeight: HEIGHT,
    fps: FPS,
    requestedJpegQuality: 90,
    entryPoint: path.resolve(process.cwd(), "src", "remotion", "index.tsx"),
    bundlePublicDir: prepareRemotionBundlePublicDir(process.cwd()),
    rendersDir,
    bundleCache: editorialBundleCache,
  }, {
    jobId: `story-film-editorial-${jobId}`,
    cancelSignal,
    cancel,
    onProgress: (progress) => {
      if (Math.round(progress) % 10 === 0) console.log(`[story-film-render] editorial ${Math.round(progress)}% job=${jobId}`);
    },
  });
  const leaf = leafFromMediaUrl(result.videoUrl, "/api/renders/");
  if (!leaf) throw new Error("story_film_editorial_output_url_invalid");
  return path.join(rendersDir, leaf);
}

type StoryFilmRenderOptions = {
  workspaceRoot?: string;
  /** Test seam; production always uses the shared Hero Remotion renderer above. */
  editorialRenderer?: (config: SubtitleOverlayConfig) => Promise<string>;
};

export async function renderStoryFilmFinal(
  jobId: string,
  options: StoryFilmRenderOptions = {},
) {
  const plan = await buildStoryFilmRenderPlan(jobId, options);
  await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
  if (await validMaster(plan.outputPath, plan.durationMs)) {
    const [metadata, stats] = await Promise.all([probeVideoMedia(plan.outputPath), fs.stat(plan.outputPath)]);
    return {
      storageUrl: plan.outputUrl,
      mimeType: "video/mp4",
      sizeBytes: stats.size,
      width: metadata!.width,
      height: metadata!.height,
      durationMs: metadata!.durationMs,
      metadata: {
        adapter: "hero_render",
        editorialEngine: "hero_remotion_subtitle_overlay",
        segmentCount: plan.segments.length,
        recovered: true,
        subtitlesEnabled: plan.editorial.subtitlesEnabled,
        subtitleStylePreset: plan.editorial.subtitleStylePreset,
        headlineEnabled: plan.editorial.headlineHook.enabled,
        captionTimingSource: plan.captionTrack.source,
        textOverlayCount: plan.editorial.textOverlays.length,
      },
    };
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hero-story-film-render-"));
  const stagedOutput = path.join(
    path.dirname(plan.outputPath),
    `.${path.basename(plan.outputPath)}.${process.pid}.tmp.mp4`,
  );
  let disposableEditorialOutput: string | null = null;
  try {
    const baseMaster = await ensureStoryFilmBaseMaster(plan, temporaryDirectory);
    const captions = captionsForStoryFilmEditorial({
      editorial: plan.editorial,
      track: plan.captionTrack,
      scenes: plan.segments,
    });
    const needsEditorialRender = captions.length > 0 || plan.editorial.headlineHook.enabled;
    if (needsEditorialRender) {
      const config = buildHeroSubtitleOverlayConfig({
        baseVideoUrl: new URL(baseMaster.url, storyFilmMediaOrigin()).toString(),
        captions,
        durationMs: plan.durationMs,
        fps: FPS,
        design: storyFilmSubtitleDesign(plan.editorial),
        headlineHook: plan.editorial.headlineHook,
      });
      const editorialOutput = options.editorialRenderer
        ? await options.editorialRenderer(config)
        : await renderWithHeroEditorialEngine(jobId, config, path.dirname(plan.outputPath));
      if (!options.editorialRenderer) disposableEditorialOutput = editorialOutput;
      await fs.copyFile(editorialOutput, stagedOutput);
    } else {
      await fs.copyFile(baseMaster.path, stagedOutput);
    }

    const metadata = await probeVideoMedia(stagedOutput);
    if (!metadata
      || metadata.width !== WIDTH
      || metadata.height !== HEIGHT
      || metadata.durationMs > MAX_DURATION_MS
      || Math.abs(metadata.durationMs - plan.durationMs) > 750) {
      throw new Error("story_film_render_output_invalid");
    }
    const stats = await fs.stat(stagedOutput);
    if (!stats.isFile() || stats.size <= 0) throw new Error("story_film_render_output_empty");
    await fs.rename(stagedOutput, plan.outputPath);
    return {
      storageUrl: plan.outputUrl,
      mimeType: "video/mp4",
      sizeBytes: stats.size,
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
      metadata: {
        adapter: "hero_render",
        editorialEngine: "hero_remotion_subtitle_overlay",
        baseMasterReused: baseMaster.recovered,
        segmentCount: plan.segments.length,
        presenterSegments: plan.segments.filter((segment) => segment.visualOwner === "presenter").length,
        brollSegments: plan.segments.filter((segment) => segment.visualOwner === "broll").length,
        subtitlesEnabled: plan.editorial.subtitlesEnabled,
        subtitleMode: plan.editorial.subtitleMode,
        subtitleStylePreset: plan.editorial.subtitleStylePreset,
        headlineEnabled: plan.editorial.headlineHook.enabled,
        captionTimingSource: plan.captionTrack.source,
        captionCount: captions.length,
        textOverlayCount: plan.editorial.textOverlays.length,
      },
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stagedOutput, { force: true }).catch(() => {});
    if (disposableEditorialOutput) await fs.rm(disposableEditorialOutput, { force: true }).catch(() => {});
  }
}
