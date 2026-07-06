import type { RelevanceSpec } from "@/lib/relevance-spec";

export type BrollRegionPreference = "auto" | "asian" | "thai" | "european" | "global" | "no-people";
export type BrollVisualStyle = "auto" | "documentary" | "cinematic" | "business" | "lifestyle" | "tech" | "minimal";

export type BrollPreferenceInput = {
  brollRegionPreference?: BrollRegionPreference | string | null;
  brollVisualStyle?: BrollVisualStyle | string | null;
};

export const BROLL_REGION_OPTIONS: { value: BrollRegionPreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "asian", label: "เอเชีย" },
  { value: "thai", label: "ไทย" },
  { value: "european", label: "ยุโรป" },
  { value: "global", label: "Global" },
  { value: "no-people", label: "ไม่มีคน" },
];

export const BROLL_STYLE_OPTIONS: { value: BrollVisualStyle; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "documentary", label: "Doc" },
  { value: "cinematic", label: "Cinematic" },
  { value: "business", label: "Business" },
  { value: "lifestyle", label: "Lifestyle" },
  { value: "tech", label: "Tech" },
  { value: "minimal", label: "Minimal" },
];

type PreferenceHints = {
  instruction: string;
  positive: string[];
  avoid: string[];
  fallbackQueries: string[];
  domainLabel: string;
};

const REGION_HINTS: Record<Exclude<BrollRegionPreference, "auto">, PreferenceHints> = {
  asian: {
    instruction: "Prefer Asian people (East or Southeast Asian) and Asian urban, business, or lifestyle contexts whenever people or places appear. Never use Western/European-looking people.",
    positive: ["asian people", "asian city", "asian office", "east asian", "southeast asian", "asian business"],
    avoid: ["caucasian people", "western people", "european people", "blonde hair"],
    fallbackQueries: ["asian business people", "asian city street", "asian office workers"],
    domainLabel: "asian visual context",
  },
  thai: {
    instruction: "Prefer Thai or Southeast Asian people, Bangkok or Thailand local settings, and realistic local environments. If Thai-specific footage is unavailable, other Asian people and settings are acceptable — never Western/European-looking people.",
    positive: ["thai people", "thailand", "bangkok", "thai office", "southeast asian", "thai lifestyle"],
    avoid: ["caucasian people", "western people", "european people", "blonde hair"],
    fallbackQueries: [
      "bangkok city street", "thai office workers", "southeast asian people",
      // degrade path: thai unavailable → asian, never western
      "asian business people", "asian city street", "asian office workers",
    ],
    domainLabel: "thai visual context",
  },
  european: {
    instruction: "Prefer European or Western people, European city settings, and western office or lifestyle contexts whenever people or places appear. Never use Asian-looking people.",
    positive: ["european people", "european city", "western office", "european business", "european lifestyle"],
    avoid: ["asian people", "east asian people", "southeast asian people"],
    fallbackQueries: ["european city street", "european office workers", "european business people"],
    domainLabel: "european visual context",
  },
  global: {
    instruction: "Prefer diverse people, international cities, multicultural teams, and globally neutral environments.",
    positive: ["diverse people", "international city", "global office", "multicultural team", "diverse business"],
    avoid: [],
    fallbackQueries: ["diverse business team", "international city street", "multicultural office meeting"],
    domainLabel: "global visual context",
  },
  "no-people": {
    instruction: "Prefer objects, environments, hands, products, screens, and details; avoid visible faces or crowds unless the script requires people.",
    positive: ["objects", "environment", "hands", "workspace", "product close up", "city detail", "screen close up"],
    avoid: ["face", "portrait", "crowd", "people", "person", "man", "woman"],
    fallbackQueries: ["hands working desk", "office objects close up", "city environment detail"],
    domainLabel: "object and environment visuals",
  },
};

const STYLE_HINTS: Record<Exclude<BrollVisualStyle, "auto">, PreferenceHints> = {
  documentary: {
    instruction: "Use realistic documentary footage, natural light, handheld or observational shots, and low-polish authentic scenes.",
    positive: ["documentary", "realistic", "natural light", "handheld", "observational", "candid"],
    avoid: ["studio portrait", "glamour", "overly staged"],
    fallbackQueries: ["documentary street footage", "realistic workplace scene", "candid daily life"],
    domainLabel: "documentary style",
  },
  cinematic: {
    instruction: "Use cinematic composition, dramatic lighting, shallow depth of field, slow motion, and polished premium visuals.",
    positive: ["cinematic", "dramatic lighting", "shallow depth of field", "slow motion", "wide shot", "premium"],
    avoid: ["flat lighting", "casual phone footage"],
    fallbackQueries: ["cinematic city night", "dramatic office lighting", "slow motion detail shot"],
    domainLabel: "cinematic style",
  },
  business: {
    instruction: "Use clean professional business visuals, offices, meetings, presentations, laptops, and executive work contexts.",
    positive: ["business", "office", "meeting", "presentation", "laptop", "professional", "executive"],
    avoid: ["party", "vacation", "random nature"],
    fallbackQueries: ["business team meeting", "professional office laptop", "executive presentation"],
    domainLabel: "business style",
  },
  lifestyle: {
    instruction: "Use warm lifestyle visuals, everyday people, home or city moments, natural movement, and approachable scenes.",
    positive: ["lifestyle", "everyday people", "home", "city life", "natural movement", "warm light"],
    avoid: ["corporate boardroom", "server room"],
    fallbackQueries: ["lifestyle city walk", "warm home detail", "everyday people cafe"],
    domainLabel: "lifestyle style",
  },
  tech: {
    instruction: "Use modern technology visuals, screens, devices, code, interfaces, server rooms, and clean digital workspaces.",
    positive: ["technology", "screens", "devices", "code", "interface", "server room", "digital workspace"],
    avoid: ["old equipment", "rustic", "random nature"],
    fallbackQueries: ["developer multiple screens", "server room lights", "technology interface close up"],
    domainLabel: "technology style",
  },
  minimal: {
    instruction: "Use clean minimal visuals, simple compositions, negative space, product details, soft light, and uncluttered scenes.",
    positive: ["minimal", "clean", "negative space", "simple composition", "soft light", "uncluttered"],
    avoid: ["busy crowd", "messy room", "visual clutter"],
    fallbackQueries: ["minimal desk setup", "clean product detail", "simple workspace light"],
    domainLabel: "minimal style",
  },
};

function isRegionPreference(v: string): v is BrollRegionPreference {
  return v === "auto" || v === "asian" || v === "thai" || v === "european" || v === "global" || v === "no-people";
}

function isVisualStyle(v: string): v is BrollVisualStyle {
  return v === "auto" || v === "documentary" || v === "cinematic" || v === "business" || v === "lifestyle" || v === "tech" || v === "minimal";
}

export function normalizeBrollRegionPreference(raw: unknown): Exclude<BrollRegionPreference, "auto"> | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return isRegionPreference(value) && value !== "auto" ? value : undefined;
}

export function normalizeBrollVisualStyle(raw: unknown): Exclude<BrollVisualStyle, "auto"> | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return isVisualStyle(value) && value !== "auto" ? value : undefined;
}

export function hasBrollPreference(input: BrollPreferenceInput): boolean {
  return Boolean(normalizeBrollRegionPreference(input.brollRegionPreference) || normalizeBrollVisualStyle(input.brollVisualStyle));
}

function mergeUnique(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const t = item.trim().toLowerCase().replace(/\s+/g, " ");
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function collectPreferenceHints(input: BrollPreferenceInput): PreferenceHints | null {
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  const style = normalizeBrollVisualStyle(input.brollVisualStyle);
  if (!region && !style) return null;

  const regionHint = region ? REGION_HINTS[region] : null;
  const styleHint = style ? STYLE_HINTS[style] : null;
  return {
    instruction: [regionHint?.instruction, styleHint?.instruction].filter(Boolean).join(" "),
    positive: mergeUnique(regionHint?.positive, styleHint?.positive),
    avoid: mergeUnique(regionHint?.avoid, styleHint?.avoid),
    fallbackQueries: mergeUnique(regionHint?.fallbackQueries, styleHint?.fallbackQueries),
    domainLabel: [regionHint?.domainLabel, styleHint?.domainLabel].filter(Boolean).join(", ") || "b-roll preference",
  };
}

export function brollPreferencePromptBlock(input: BrollPreferenceInput): string {
  const hints = collectPreferenceHints(input);
  if (!hints) return "";
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  const regionConstraint = region
    ? region === "no-people"
      ? "Treat the no-people setting as a hard search constraint: avoid visible faces, portraits, crowds, and full-body people unless the subtitle is impossible without a person."
      : "Treat the region setting as a strong search constraint: every people, place, office, school, lifestyle, or city query must carry the requested region/local context."
    : "";
  return [
    "B-ROLL VISUAL PREFERENCE:",
    hints.instruction,
    regionConstraint,
    "Use this to steer query wording, visualDirection, and safe fallback queries while keeping every query filmable and relevant to the subtitle.",
  ].join("\n");
}

export function appendBrollPreferenceToDirection(direction: string, input: BrollPreferenceInput): string {
  const hints = collectPreferenceHints(input);
  if (!hints) return direction;
  const suffix = hints.instruction.replace(/\s+/g, " ").trim();
  const MAX = 320;
  const budget = Math.max(0, MAX - suffix.length - 1);
  const base = direction.trim().replace(/\s+/g, " ").slice(0, budget).trimEnd();
  return [base, suffix].filter(Boolean).join(" ");
}

export function brollPreferenceInstruction(input: BrollPreferenceInput): string {
  return collectPreferenceHints(input)?.instruction ?? "";
}

export function augmentRelevanceSpecWithBrollPreference(
  spec: RelevanceSpec | null,
  input: BrollPreferenceInput,
): RelevanceSpec | null {
  const hints = collectPreferenceHints(input);
  if (!hints) return spec;
  return {
    visualDomain: spec?.visualDomain || hints.domainLabel,
    positiveConcepts: mergeUnique(spec?.positiveConcepts, hints.positive).slice(0, 24),
    avoidConcepts: mergeUnique(spec?.avoidConcepts, hints.avoid).slice(0, 24),
    safeFallbackQueries: mergeUnique(spec?.safeFallbackQueries, hints.fallbackQueries).slice(0, 14),
  };
}

const REGION_SEARCH_CONSTRAINTS: Partial<Record<BrollRegionPreference, { required: string; aliases: string[] }>> = {
  thai: {
    required: "thai",
    aliases: ["thai", "thailand", "bangkok", "southeast asian"],
  },
  asian: {
    required: "asian",
    aliases: ["asian", "east asian", "southeast asian", "thai", "thailand", "bangkok", "japanese", "korean", "chinese"],
  },
  european: {
    required: "european",
    aliases: ["european", "europe", "western"],
  },
  global: {
    required: "diverse",
    aliases: ["diverse", "global", "international", "multicultural"],
  },
};

const PEOPLE_WORD_RE = /\b(people|person|persons|man|woman|men|women|face|faces|portrait|portraits|crowd|crowds|student|students|worker|workers|team|teams|employee|employees|teacher|teachers|doctor|doctors|patient|patients|customer|customers)\b/gi;

function hasConstraintAlias(query: string, aliases: string[]): boolean {
  const normalized = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return aliases.some((alias) => normalized.includes(` ${alias.toLowerCase()} `));
}

export function applyBrollPreferenceToSearchQuery(query: string, input: BrollPreferenceInput): string {
  const clean = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!clean) return "";

  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  if (!region) return clean;

  if (region === "no-people") {
    const withoutPeople = clean.replace(PEOPLE_WORD_RE, "").replace(/\s+/g, " ").trim();
    const base = withoutPeople || clean;
    return hasConstraintAlias(base, ["no people", "empty", "object", "objects", "hands", "workspace", "detail"])
      ? base
      : `${base} no people`;
  }

  const constraint = REGION_SEARCH_CONSTRAINTS[region];
  if (!constraint || hasConstraintAlias(clean, constraint.aliases)) return clean;
  return `${constraint.required} ${clean}`;
}

export function applyBrollPreferenceToSearchQueries(
  queries: string[],
  input: BrollPreferenceInput,
): string[] {
  const out: string[] = [];
  for (const query of queries) {
    const preferred = applyBrollPreferenceToSearchQuery(query, input);
    if (preferred && !out.includes(preferred)) out.push(preferred);
  }
  return out;
}
