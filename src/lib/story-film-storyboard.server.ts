import "server-only";

import {
  createGeminiContentPreflightAnalyzer,
  planNarrativeVisualWindows,
  type ContentPreflightAnalysis,
  type ContentPreflightAnalyzer,
  type NarrativeVisualWindow,
} from "@/lib/content-preflight.server";
import { prisma } from "@/lib/prisma";
import {
  STORY_FILM_PROJECT_CHARACTER_ENTITY_ID,
  placeProjectCharacterInAnalysis,
  projectCharacterPlanningDirection,
} from "@/lib/story-film-character-placement";

const STORYBOARD_VERSION = "hero-story-film-storyboard-v1";
const DEFAULT_SCENE_DURATION_SEC = 7;
const MIN_SCENE_DURATION_SEC = 4;
const MAX_SCENE_DURATION_SEC = 10;

const VISIBLE_MOTION = /\b(?:walk|run|turn|open|close|pour|fall|rise|move|enter|exit|reach|lift|drift|flow|drive|ride|fly|dance|fight|rain|splash|wave|push|pull|throw|jump|climb|crawl|swim|sweep|spin|shake|explode|collapse)\w*\b/iu;

export type StoryFilmStoryboardScene = {
  sceneKey: string;
  sequence: number;
  startMs: number;
  endMs: number;
  sourceExcerpt: string;
  subject: string;
  action: string;
  setting: string;
  emotion: string;
  emphasis: string;
  mediaPlan: "video" | "image_with_motion";
  visualOwner: "broll" | "presenter";
  motionReason: string;
  storyEntityIds: string[];
  characterDirectives: Array<{
    entityId: string;
    renderingDescription: string;
    recurringCharacterDescription: string | null;
    isRealPerson: boolean;
    isProjectCharacter: boolean;
  }>;
  grokPrompt: string;
};

export type StoryFilmStoryboard = {
  version: typeof STORYBOARD_VERSION;
  projectId: string;
  generationEpoch: number;
  aspectRatio: "9:16";
  presentationMode: "presenter_led" | "faceless";
  narrationDurationMs: number;
  contentDomain: string;
  dominantNarrativeMode: string;
  suggestedVisualFormatId: string;
  suggestedTreatment: {
    presetId: string;
    rationale: string;
  };
  storyEntities: ContentPreflightAnalysis["storyEntities"];
  scenes: StoryFilmStoryboardScene[];
};

/**
 * Presenter-led films remain visual stories instead of turning into talking
 * heads. Roughly one quarter of the beats reveal the uploaded presenter while
 * the remaining beats are generated B-roll. Faceless films never reserve a
 * presenter beat. Positions are spread deterministically across the timeline
 * so a rerun cannot silently change the edit rhythm.
 */
export function planStoryFilmVisualOwners(
  presentationMode: "presenter_led" | "faceless",
  sceneCount: number,
): Array<"broll" | "presenter"> {
  if (!Number.isSafeInteger(sceneCount) || sceneCount < 1) throw new Error("storyboard_scene_count_invalid");
  if (presentationMode === "faceless" || sceneCount === 1) return Array(sceneCount).fill("broll");
  const presenterCount = Math.max(1, Math.round(sceneCount * 0.25));
  const presenterScenes = new Set<number>();
  for (let index = 0; index < presenterCount; index += 1) {
    presenterScenes.add(Math.min(
      sceneCount - 1,
      Math.floor(((index + 0.5) * sceneCount) / presenterCount),
    ));
  }
  return Array.from({ length: sceneCount }, (_, sequence) => (
    presenterScenes.has(sequence) ? "presenter" : "broll"
  ));
}

function clampTargetSceneDuration(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_SCENE_DURATION_SEC;
  return Math.min(MAX_SCENE_DURATION_SEC, Math.max(MIN_SCENE_DURATION_SEC, seconds));
}

/**
 * The Narration Master owns the final timeline. Until word-level alignment is
 * available, source-length weighting keeps longer ideas on screen longer while
 * preserving contiguous, deterministic boundaries and the exact audio end.
 */
export function planStoryFilmTimedWindows(input: {
  narrativeSource: string;
  narrationDurationMs: number;
  targetSceneDurationSec?: number;
}): NarrativeVisualWindow[] {
  if (!Number.isSafeInteger(input.narrationDurationMs)
    || input.narrationDurationMs <= 0
    || input.narrationDurationMs > 180_000) {
    throw new Error("narration_duration_invalid");
  }
  const targetSceneDurationSec = clampTargetSceneDuration(input.targetSceneDurationSec);
  const sceneCount = Math.max(1, Math.ceil(input.narrationDurationMs / (targetSceneDurationSec * 1_000)));
  const planned = planNarrativeVisualWindows(input.narrativeSource, sceneCount);
  if (planned.length !== sceneCount) throw new Error("storyboard_window_count_invalid");
  const weights = planned.map((window) => Math.max(1, Array.from(window.text).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsedWeight = 0;
  let startMs = 0;
  return planned.map((window, index) => {
    elapsedWeight += weights[index];
    const endMs = index === planned.length - 1
      ? input.narrationDurationMs
      : Math.max(startMs + 1, Math.round(input.narrationDurationMs * elapsedWeight / totalWeight));
    const timed = { text: window.text, startMs, endMs };
    startMs = endMs;
    return timed;
  });
}

function mediaPlanForBeat(
  beat: ContentPreflightAnalysis["beats"][number],
  explicitVideo: boolean | undefined,
) {
  const motionText = `${beat.action} ${beat.sceneIntensity}`;
  const video = explicitVideo ?? VISIBLE_MOTION.test(motionText);
  return {
    mediaPlan: video ? "video" as const : "image_with_motion" as const,
    motionReason: explicitVideo === true
      ? "The reviewed Storyboard explicitly assigns AI video to this scene."
      : explicitVideo === false
        ? "The reviewed Storyboard explicitly keeps this scene as an image with editorial motion."
        : video
          ? "The beat depends on visible subject or environment movement."
          : "The beat reads as one strong cinematic frame; editorial camera motion is sufficient.",
  };
}

function escapedProviderAlias(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function realPersonProviderAliases(entity: ContentPreflightAnalysis["storyEntities"][number]) {
  const aliases = new Set<string>([entity.properName.trim()]);
  [entity.renderingDescription, entity.recurringCharacterDescription].forEach((description) => {
    if (!description) return;
    description.split(",").forEach((part) => {
      const candidate = part.trim();
      const words = candidate.split(/\s+/u);
      if (
        words.length >= 1
        && words.length <= 4
        && !/^(?:a|an|the)$/iu.test(words[0] ?? "")
        && words.every((word) => /^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(word))
      ) {
        aliases.add(candidate);
      }
    });
  });
  return [...aliases].filter(Boolean).sort((left, right) => right.length - left.length);
}

function safeRealPersonDescriptions(entity: ContentPreflightAnalysis["storyEntities"][number]) {
  const traits = entity.durableAttributes
    .map((attribute) => attribute.trim())
    .filter(Boolean)
    .join("; ");
  const suffix = traits ? ` with continuity traits: ${traits}` : "";
  return {
    renderingDescription: `a real person${suffix}`,
    recurringCharacterDescription: `the same real person${suffix}`,
  };
}

function scrubProviderAliases(value: string, aliases: string[]) {
  return aliases.reduce((result, alias) => {
    const escaped = escapedProviderAlias(alias);
    if (!escaped) return result;
    return result.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"),
      (_match, prefix: string) => `${prefix}the same real person`,
    );
  }, value);
}

function grokPromptForBeat(
  beat: ContentPreflightAnalysis["beats"][number],
  characterDirectives: StoryFilmStoryboardScene["characterDirectives"],
  providerAliases: string[],
) {
  const clean = (value: string) => scrubProviderAliases(value, providerAliases);
  const projectCharacters = characterDirectives.filter((item) => item.isProjectCharacter);
  const focalCharacters = characterDirectives.filter((item) => !item.isProjectCharacter);
  const characters = characterDirectives.length > 0
    ? `Character continuity: ${characterDirectives.map((item) => item.recurringCharacterDescription || item.renderingDescription).join("; ")}.`
    : "";
  const subject = focalCharacters.length > 0
    ? focalCharacters.map((item) => item.recurringCharacterDescription || item.renderingDescription).join(" and ")
    : clean(beat.subject);
  const projectCharacterPresence = projectCharacters.length > 0
    ? `Supporting creator presence: ${projectCharacters.map((item) => item.recurringCharacterDescription || item.renderingDescription).join(" and ")} is clearly visible in a natural secondary position as an observer or participant, without replacing the focal subject.`
    : "";
  return [
    "Vertical 9:16 cinematic short-film frame, one continuous story moment, photorealistic production still.",
    `Subject: ${subject}.`,
    `Action: ${clean(beat.action)}.`,
    `Setting: ${clean(beat.setting)}.`,
    `Emotion: ${clean(beat.emotion)}.`,
    `Visual emphasis: ${clean(beat.emphasis)}.`,
    characters,
    projectCharacterPresence,
    "Preserve stated counts, relationships, wardrobe and physical details. No montage, split screen, collage, captions, subtitles, logos or watermarks.",
  ].filter(Boolean).join(" ");
}

export function buildStoryFilmStoryboardDocument(input: {
  projectId: string;
  generationEpoch: number;
  presentationMode: "presenter_led" | "faceless";
  narrationDurationMs: number;
  windows: NarrativeVisualWindow[];
  analysis: ContentPreflightAnalysis;
  videoSceneKeys?: string[];
}): StoryFilmStoryboard {
  if (input.analysis.beats.length !== input.windows.length) throw new Error("storyboard_beat_count_invalid");
  const validSceneKeys = new Set(input.analysis.beats.map((_, sequence) => (
    `scene-${String(sequence + 1).padStart(2, "0")}`
  )));
  const explicitVideoSceneKeys = input.videoSceneKeys === undefined
    ? undefined
    : new Set(input.videoSceneKeys);
  if (explicitVideoSceneKeys && (
    explicitVideoSceneKeys.size !== input.videoSceneKeys?.length
      || [...explicitVideoSceneKeys].some((sceneKey) => !validSceneKeys.has(sceneKey))
  )) {
    throw new Error("storyboard_video_scene_key_invalid");
  }
  const entities = new Map(input.analysis.storyEntities.map((entity) => [entity.entityId, entity]));
  const globalRealPersonAliases = input.analysis.storyEntities.flatMap((entity) => (
    entity.isRealPerson ? realPersonProviderAliases(entity) : []
  ));
  const visualOwners = planStoryFilmVisualOwners(input.presentationMode, input.analysis.beats.length);
  const scenes = input.analysis.beats.map((beat, sequence) => {
    const window = input.windows[sequence];
    if (!Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs)) {
      throw new Error("storyboard_timing_missing");
    }
    const providerAliases = [...globalRealPersonAliases];
    const characterDirectives = beat.entityRefs.flatMap((entityId) => {
      const entity = entities.get(entityId);
      if (entity?.isRealPerson) providerAliases.push(...realPersonProviderAliases(entity));
      const safeDescription = entity?.isRealPerson ? safeRealPersonDescriptions(entity) : null;
      return entity ? [{
        entityId,
        renderingDescription: safeDescription?.renderingDescription ?? entity.renderingDescription,
        recurringCharacterDescription: safeDescription?.recurringCharacterDescription
          ?? entity.recurringCharacterDescription
          ?? null,
        isRealPerson: entity.isRealPerson,
        isProjectCharacter: entity.entityId === STORY_FILM_PROJECT_CHARACTER_ENTITY_ID,
      }] : [];
    });
    return {
      sceneKey: `scene-${String(sequence + 1).padStart(2, "0")}`,
      sequence,
      startMs: window.startMs!,
      endMs: window.endMs!,
      sourceExcerpt: window.text,
      subject: beat.subject,
      action: beat.action,
      setting: beat.setting,
      emotion: beat.emotion,
      emphasis: beat.emphasis,
      ...mediaPlanForBeat(beat, explicitVideoSceneKeys?.has(`scene-${String(sequence + 1).padStart(2, "0")}`)),
      visualOwner: visualOwners[sequence],
      storyEntityIds: [...beat.entityRefs],
      characterDirectives,
      grokPrompt: grokPromptForBeat(beat, characterDirectives, providerAliases),
    };
  });
  return {
    version: STORYBOARD_VERSION,
    projectId: input.projectId,
    generationEpoch: input.generationEpoch,
    aspectRatio: "9:16",
    presentationMode: input.presentationMode,
    narrationDurationMs: input.narrationDurationMs,
    contentDomain: input.analysis.contentDomain,
    dominantNarrativeMode: input.analysis.dominantNarrativeMode,
    suggestedVisualFormatId: input.analysis.suggestedVisualFormatId,
    suggestedTreatment: {
      presetId: input.analysis.rankedTreatmentPresetIds[0],
      rationale: input.analysis.treatmentRecommendationRationale,
    },
    storyEntities: input.analysis.storyEntities,
    scenes,
  };
}

export async function planStoryFilmStoryboardJob(
  jobId: string,
  analyzer?: ContentPreflightAnalyzer,
): Promise<StoryFilmStoryboard> {
  const job = await prisma.storyFilmGenerationJob.findUnique({
    where: { id: jobId },
    include: { project: true },
  });
  if (!job
    || job.kind !== "storyboard_plan"
    || job.providerBackend !== "hero_text"
    || job.stage !== "storyboard") {
    throw new Error("storyboard_job_invalid");
  }
  if (job.project.stage !== "storyboard"
    || job.project.generationEpoch !== job.generationEpoch
    || !job.project.narrationDurationMs) {
    throw new Error("storyboard_job_stale");
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(job.payloadJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {}
  const windows = planStoryFilmTimedWindows({
    narrativeSource: job.project.narrativeSource,
    narrationDurationMs: job.project.narrationDurationMs,
    targetSceneDurationSec: Number(payload.targetSceneDurationSec),
  });
  const resolvedAnalyzer = analyzer ?? createGeminiContentPreflightAnalyzer(job.project.userId);
  const revisionInstruction = typeof payload.revisionInstruction === "string"
    ? payload.revisionInstruction.trim().slice(0, 2_000)
    : "";
  const videoSceneKeys = payload.videoSceneKeys === undefined
    ? undefined
    : Array.isArray(payload.videoSceneKeys)
      && payload.videoSceneKeys.every((value): value is string => typeof value === "string")
      ? payload.videoSceneKeys
      : (() => { throw new Error("storyboard_video_scene_key_invalid"); })();
  const projectCharacter = job.project.characterProfileId
    ? await prisma.storyFilmCharacterProfile.findFirst({
        where: { id: job.project.characterProfileId, userId: job.project.userId },
        select: { name: true, identityNotes: true },
      })
    : null;
  const eligibleBeatIndexes = planStoryFilmVisualOwners(
    job.project.presentationMode === "presenter_led" ? "presenter_led" : "faceless",
    windows.length,
  ).flatMap((owner, index) => owner === "broll" ? [index] : []);
  const visualDirections = [
    revisionInstruction
      ? `Visual revision direction for this storyboard: ${revisionInstruction}`
      : "",
    projectCharacter
      ? projectCharacterPlanningDirection({ character: projectCharacter, eligibleBeatIndexes })
      : "",
  ].filter(Boolean).join("\n\n");
  const analyzed = await resolvedAnalyzer.analyze({
    kind: "creator-script",
    text: visualDirections
      ? `${job.project.narrativeSource}\n\n${visualDirections}`
      : job.project.narrativeSource,
    windows,
  });
  const analysis = projectCharacter
    ? placeProjectCharacterInAnalysis({
        analysis: analyzed,
        character: projectCharacter,
        eligibleBeatIndexes,
      })
    : analyzed;
  return buildStoryFilmStoryboardDocument({
    projectId: job.project.id,
    generationEpoch: job.generationEpoch,
    presentationMode: job.project.presentationMode === "presenter_led" ? "presenter_led" : "faceless",
    narrationDurationMs: job.project.narrationDurationMs,
    windows,
    analysis,
    videoSceneKeys,
  });
}

export async function persistStoryFilmStoryboardScenes(document: StoryFilmStoryboard) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.storyFilmScene.findMany({
      where: { projectId: document.projectId, generationEpoch: document.generationEpoch },
      orderBy: { sequence: "asc" },
    });
    if (existing.length > 0) {
      if (existing.length !== document.scenes.length
        || existing.some((scene, index) => scene.sceneKey !== document.scenes[index]?.sceneKey)) {
        throw new Error("storyboard_scene_set_conflict");
      }
      return;
    }
    await tx.storyFilmScene.createMany({
      data: document.scenes.map((scene) => ({
        projectId: document.projectId,
        generationEpoch: document.generationEpoch,
        sceneKey: scene.sceneKey,
        sequence: scene.sequence,
        startMs: scene.startMs,
        endMs: scene.endMs,
        sourceExcerpt: scene.sourceExcerpt,
        grokPrompt: scene.grokPrompt,
        mediaPlan: scene.mediaPlan,
        visualOwner: scene.visualOwner,
        characterDirectivesJson: JSON.stringify(scene.characterDirectives),
      })),
    });
  });
}
