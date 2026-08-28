import type { ContentPreflightAnalysis } from "@/lib/content-preflight.server";

export const STORY_FILM_PROJECT_CHARACTER_ENTITY_ID = "story-film-project-character";

export type StoryFilmProjectCharacterIdentity = {
  name: string;
  identityNotes: string | null;
};

function normalizedName(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function evenlySpaced<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count >= items.length) return [...items];
  return Array.from({ length: count }, (_, index) => (
    items[Math.min(items.length - 1, Math.floor(((index + 0.5) * items.length) / count))]
  ));
}

function desiredAppearanceCount(eligibleCount: number) {
  if (eligibleCount >= 12) return 3;
  if (eligibleCount >= 5) return 2;
  return eligibleCount > 0 ? 1 : 0;
}

export function projectCharacterPlanningDirection(input: {
  character: StoryFilmProjectCharacterIdentity;
  eligibleBeatIndexes: number[];
}) {
  return [
    "Selected Story Character direction for visual planning only; do not treat this as spoken narration.",
    `Create exactly one real-person Story Entity for ${input.character.name} with entityId exactly \"${STORY_FILM_PROJECT_CHARACTER_ENTITY_ID}\".`,
    input.character.identityNotes
      ? `Stable identity notes: ${input.character.identityNotes}`
      : "Describe the selected creator as one stable adult real person; identity is locked later by private reference images.",
    `Eligible zero-based B-roll beat indexes: ${input.eligibleBeatIndexes.join(", ") || "none"}.`,
    "Place this entity in a minority of eligible beats where a creator can naturally exist in the story world, as a clearly visible supporting observer or participant.",
    "The selected Story Character must not replace the focal subject, must not appear in every beat, and must never stand in for another named person, athlete, engineer, robot, object, or place.",
    `Add \"${STORY_FILM_PROJECT_CHARACTER_ENTITY_ID}\" to entityRefs only for those selected supporting appearances.`,
  ].join("\n");
}

/**
 * Bind one pinned Character Profile to one stable Story Entity marker.
 *
 * Gemini chooses contextually suitable appearances. This normalizer then
 * enforces the eligible B-roll boundary, strips unsafe assignments to other
 * real-person beats, and supplies a deterministic sparse fallback when the
 * analyzer omits the requested marker.
 */
export function placeProjectCharacterInAnalysis(input: {
  analysis: ContentPreflightAnalysis;
  character: StoryFilmProjectCharacterIdentity;
  eligibleBeatIndexes: number[];
}): ContentPreflightAnalysis {
  const eligibleIndexes = new Set(input.eligibleBeatIndexes);
  const normalizedCharacterName = normalizedName(input.character.name);
  const matchedEntity = input.analysis.storyEntities.find((entity) => (
    entity.entityId === STORY_FILM_PROJECT_CHARACTER_ENTITY_ID
      || normalizedName(entity.entityId) === normalizedCharacterName
      || normalizedName(entity.properName) === normalizedCharacterName
  ));
  const projectCharacterAliases = new Set([
    STORY_FILM_PROJECT_CHARACTER_ENTITY_ID,
    ...(matchedEntity ? [matchedEntity.entityId] : []),
  ]);
  const entitiesById = new Map(input.analysis.storyEntities.map((entity) => [entity.entityId, entity]));
  const durableAttributes = [
    "adult real creator",
    ...(matchedEntity?.durableAttributes ?? []),
  ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 16);

  const eligibleCandidates = input.analysis.beats.flatMap((beat, index) => {
    if (!eligibleIndexes.has(index)) return [];
    const hasAnotherRealPerson = beat.entityRefs.some((entityId) => {
      if (projectCharacterAliases.has(entityId)) return false;
      return entitiesById.get(entityId)?.isRealPerson === true;
    });
    return hasAnotherRealPerson ? [] : [index];
  });
  const desiredCount = desiredAppearanceCount(eligibleCandidates.length);
  const analyzerSelections = eligibleCandidates.filter((index) => (
    input.analysis.beats[index].entityRefs.some((entityId) => projectCharacterAliases.has(entityId))
  ));
  const storyWorldCandidates = eligibleCandidates.filter((index) => (
    input.analysis.beats[index].entityRefs.some((entityId) => !projectCharacterAliases.has(entityId))
  ));
  const selectedIndexes = new Set<number>(evenlySpaced(analyzerSelections, desiredCount));
  const fillFrom = [
    ...storyWorldCandidates.filter((index) => !selectedIndexes.has(index)),
    ...eligibleCandidates.filter((index) => (
      !selectedIndexes.has(index) && !storyWorldCandidates.includes(index)
    )),
  ];
  for (const index of evenlySpaced(fillFrom, desiredCount - selectedIndexes.size)) {
    selectedIndexes.add(index);
  }

  const projectCharacter = {
    entityId: STORY_FILM_PROJECT_CHARACTER_ENTITY_ID,
    properName: input.character.name,
    entityType: "person" as const,
    durableAttributes,
    renderingDescription: "an adult real creator with a stable recognizable identity",
    recurringCharacterDescription: selectedIndexes.size >= 2
      ? "the same adult real creator with a stable recognizable identity"
      : null,
    isRealPerson: true,
  };
  return {
    ...input.analysis,
    storyEntities: [
      ...input.analysis.storyEntities.filter((entity) => !projectCharacterAliases.has(entity.entityId)),
      projectCharacter,
    ],
    beats: input.analysis.beats.map((beat, index) => ({
      ...beat,
      entityRefs: [
        ...beat.entityRefs.filter((entityId) => !projectCharacterAliases.has(entityId)),
        ...(selectedIndexes.has(index) ? [STORY_FILM_PROJECT_CHARACTER_ENTITY_ID] : []),
      ],
    })),
  };
}

export function sceneUsesProjectCharacter(characterDirectivesJson: string) {
  try {
    const directives = JSON.parse(characterDirectivesJson) as unknown;
    return Array.isArray(directives) && directives.some((directive) => (
      directive
        && typeof directive === "object"
        && !Array.isArray(directive)
        && (
          (directive as { isProjectCharacter?: unknown }).isProjectCharacter === true
          || (directive as { entityId?: unknown }).entityId === STORY_FILM_PROJECT_CHARACTER_ENTITY_ID
        )
    ));
  } catch {
    return false;
  }
}
