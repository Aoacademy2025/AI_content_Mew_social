/**
 * Per-video content intent for generated and searched B-roll.
 *
 * This module owns WHO/WHERE constraints only. Brand Visual owns HOW a frame is
 * rendered (format, palette, light, composition and texture). Keeping those
 * concerns separate lets one Visual Beat carry both without two style prompts
 * fighting at the image-provider seam.
 */

export type SceneContentLocale = "narrative" | "thai" | "asian" | "european" | "global";
export type ScenePeoplePolicy = "narrative" | "avoid-visible-people";

export type SceneContentPolicy = {
  locale: SceneContentLocale;
  people: ScenePeoplePolicy;
};

export type ScenePolicyApplicability = "applied" | "not-applicable" | "story-conflict";

export type SceneContentPolicyWarning = {
  code: "story-locale-preserved";
  sceneIndex: number;
  message: string;
};

export type ScenePolicyBeat = {
  sourceExcerpt: string;
  subject: string;
  action: string;
  setting: string;
  emotion: string;
  emphasis: string;
  policyApplicability?: ScenePolicyApplicability;
  policyConflict?: string;
  sceneContentPolicy?: SceneContentPolicy;
  policyFallbackApplied?: boolean;
};

export const DEFAULT_SCENE_CONTENT_POLICY: SceneContentPolicy = Object.freeze({
  locale: "narrative",
  people: "narrative",
});

const LOCALES = new Set<SceneContentLocale>(["narrative", "thai", "asian", "european", "global"]);
const PEOPLE_POLICIES = new Set<ScenePeoplePolicy>(["narrative", "avoid-visible-people"]);

/** Backward-compatible adapter for saved Editor drafts and MCP callers. */
export function sceneContentPolicyFromPreference(raw: unknown): SceneContentPolicy {
  if (raw && typeof raw === "object") {
    const value = raw as { locale?: unknown; people?: unknown };
    const locale = typeof value.locale === "string" && LOCALES.has(value.locale as SceneContentLocale)
      ? value.locale as SceneContentLocale
      : DEFAULT_SCENE_CONTENT_POLICY.locale;
    const people = typeof value.people === "string" && PEOPLE_POLICIES.has(value.people as ScenePeoplePolicy)
      ? value.people as ScenePeoplePolicy
      : DEFAULT_SCENE_CONTENT_POLICY.people;
    return { locale, people };
  }
  switch (typeof raw === "string" ? raw.trim().toLowerCase() : "") {
    case "thai": return { locale: "thai", people: "narrative" };
    case "asian": return { locale: "asian", people: "narrative" };
    case "european": return { locale: "european", people: "narrative" };
    case "global": return { locale: "global", people: "narrative" };
    case "no-people": return { locale: "narrative", people: "avoid-visible-people" };
    default: return { ...DEFAULT_SCENE_CONTENT_POLICY };
  }
}

export function isDefaultSceneContentPolicy(policy: SceneContentPolicy): boolean {
  return policy.locale === "narrative" && policy.people === "narrative";
}

export function sceneContentPolicyIdentity(policy: SceneContentPolicy): string {
  return `${policy.locale}:${policy.people}`;
}

const LOCALE_DIRECTION: Record<Exclude<SceneContentLocale, "narrative">, {
  setting: string;
  person: string;
  marker: RegExp;
}> = {
  thai: {
    setting: "a credible Thai local context",
    person: "Thai or Southeast Asian",
    marker: /\b(?:thai|thailand|bangkok)\b/i,
  },
  asian: {
    setting: "a credible East or Southeast Asian local context",
    person: "East or Southeast Asian",
    marker: /\b(?:asian|asia|thai|thailand|bangkok|chinese|china|japanese|japan|korean|korea|vietnamese|vietnam)\b/i,
  },
  european: {
    setting: "a credible European local context",
    person: "European",
    marker: /\b(?:european|europe|french|france|german|germany|italian|italy|spanish|spain|british|britain|london|paris|berlin|rome)\b/i,
  },
  global: {
    setting: "a credible, culturally diverse international context",
    person: "culturally diverse",
    marker: /\b(?:international|global|multicultural|culturally diverse)\b/i,
  },
};

const THAI_STORY_LOCALE_RE = /\b(?:thai|thailand|bangkok|chiang mai|phuket)\b|ไทย|ประเทศไทย|กรุงเทพ|เชียงใหม่|ภูเก็ต/i;
const ASIAN_STORY_LOCALE_RE = /\b(?:asia|asian|china|chinese|japan|japanese|tokyo|korea|korean|seoul|vietnam|vietnamese|hanoi|singapore)\b|เอเชีย|จีน|ญี่ปุ่น|โตเกียว|เกาหลี|โซล|เวียดนาม|ฮานอย|สิงคโปร์/i;
const EUROPEAN_STORY_LOCALE_RE = /\b(?:europe|european|france|french|paris|germany|german|berlin|italy|italian|rome|spain|spanish|britain|british|london)\b|ยุโรป|ฝรั่งเศส|ปารีส|เยอรมนี|เบอร์ลิน|อิตาลี|โรม|สเปน|อังกฤษ|ลอนดอน/i;
const VISIBLE_PERSON_RE = /\b(?:person|people|man|men|woman|women|boy|girl|child|children|family|couple|crowd|team|worker|employee|customer|student|teacher|doctor|nurse|presenter|founder|creator|first-jobber|archaeologist|human figure|silhouette|portrait)\b/i;

function hasStoryLocaleConflict(text: string, locale: SceneContentLocale): boolean {
  if (locale === "narrative" || locale === "global") return false;
  const thai = THAI_STORY_LOCALE_RE.test(text);
  const asian = ASIAN_STORY_LOCALE_RE.test(text);
  const european = EUROPEAN_STORY_LOCALE_RE.test(text);
  if (locale === "thai") return european || (asian && !thai);
  if (locale === "asian") return european;
  return thai || asian;
}

/** Prompt contract consumed only by the Content Preflight analyzer. */
export function sceneContentPolicyPromptBlock(policy: SceneContentPolicy): string {
  if (isDefaultSceneContentPolicy(policy)) return "";
  const lines = [
    "CREATOR-SELECTED SCENE CONTENT POLICY (controls WHO and WHERE, never rendering style):",
  ];
  if (policy.locale !== "narrative") {
    const direction = LOCALE_DIRECTION[policy.locale];
    lines.push(
      `Preferred context: ${direction.setting}; when a beat already contains a visible person, portray them as ${direction.person}.`,
      "Apply this only to people or localizable places already supported by the B-roll window. Never introduce a person merely to express locale.",
      "If the Narrative Source explicitly names a different city, country or culture, preserve that story fact, set policyApplicability to story-conflict, and briefly state policyConflict. Otherwise set policyApplicability to applied when the preference shapes subject/setting, or not-applicable for objects, nature and abstract scenes that have no meaningful local context.",
    );
  }
  if (policy.people === "avoid-visible-people") {
    lines.push(
      "Do not put visible faces, portraits, crowds, full bodies, silhouettes or human figures in any beat. Tell the story through objects, environments, screens, product details, or a close-up of hands without a face/body. Output fields must describe only what is present; never name an excluded person in order to negate them.",
    );
  }
  return lines.join("\n");
}

function noVisiblePeopleFallback<T extends ScenePolicyBeat>(beat: T): T & ScenePolicyBeat {
  const visiblePersonMentioned = VISIBLE_PERSON_RE.test([
    beat.subject,
    beat.action,
    beat.setting,
    beat.emphasis,
  ].join(" "));
  if (!visiblePersonMentioned) return beat;
  return {
    ...beat,
    subject: "story-relevant objects, environmental details, and a close-up of hands when useful",
    action: "one meaningful object interaction conveys the described event in a single frozen moment",
    setting: VISIBLE_PERSON_RE.test(beat.setting)
      ? "a story-relevant environment with clear physical details"
      : beat.setting,
    emphasis: VISIBLE_PERSON_RE.test(beat.emphasis)
      ? "the clearest story-relevant object or environmental detail"
      : beat.emphasis,
    policyFallbackApplied: true,
  };
}

/**
 * Deterministic backstop after remote analysis. Production prompting should do
 * the semantic work; this function guarantees that a missed preference cannot
 * silently disappear before Brand Visual compilation.
 */
export function applySceneContentPolicy<T extends ScenePolicyBeat>(
  beats: readonly T[],
  rawPolicy: unknown,
): { beats: Array<T & ScenePolicyBeat>; warnings: SceneContentPolicyWarning[] } {
  const policy = sceneContentPolicyFromPreference(rawPolicy);
  const warnings: SceneContentPolicyWarning[] = [];
  const resolvedBeats = beats.map((inputBeat, sceneIndex) => {
    let beat: T & ScenePolicyBeat = { ...inputBeat, sceneContentPolicy: policy };
    if (policy.people === "avoid-visible-people") {
      beat = noVisiblePeopleFallback(beat);
    }
    if (policy.locale === "narrative") return beat;

    const combined = [beat.sourceExcerpt, beat.subject, beat.setting].join(" ");
    const storyConflict = beat.policyApplicability === "story-conflict"
      || Boolean(beat.policyConflict?.trim())
      || hasStoryLocaleConflict(combined, policy.locale);
    if (storyConflict) {
      warnings.push({
        code: "story-locale-preserved",
        sceneIndex,
        message: `ฉากที่ ${sceneIndex + 1} ระบุสถานที่หรือวัฒนธรรมชัดเจน ระบบจึงคงตามเนื้อหาเดิม`,
      });
      return { ...beat, policyApplicability: "story-conflict" as const };
    }
    if (beat.policyApplicability === "not-applicable") return beat;

    const direction = LOCALE_DIRECTION[policy.locale];
    const subject = VISIBLE_PERSON_RE.test(beat.subject) && !direction.marker.test(beat.subject)
      ? `${beat.subject}, portrayed as ${direction.person}`
      : beat.subject;
    const setting = direction.marker.test(beat.setting)
      ? beat.setting
      : `${beat.setting}, grounded in ${direction.setting}`;
    return { ...beat, subject, setting, policyApplicability: "applied" as const };
  });
  return { beats: resolvedBeats, warnings };
}

export function sceneContentPolicyWarnings(beats: readonly ScenePolicyBeat[]): SceneContentPolicyWarning[] {
  return beats.flatMap((beat, sceneIndex) => beat.policyApplicability === "story-conflict"
    ? [{
        code: "story-locale-preserved" as const,
        sceneIndex,
        message: `ฉากที่ ${sceneIndex + 1} ระบุสถานที่หรือวัฒนธรรมชัดเจน ระบบจึงคงตามเนื้อหาเดิม`,
      }]
    : []);
}
