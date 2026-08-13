import type { RelevanceSpec } from "@/lib/relevance-spec";

export type BrollRegionPreference = "auto" | "asian" | "thai" | "european" | "global" | "no-people";
export type BrollVisualStyle = "auto" | "documentary" | "cinematic" | "business" | "lifestyle" | "tech" | "minimal" | "surreal";

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
  { value: "surreal", label: "Surreal" },
];

type PreferenceHints = {
  instruction: string;
  // `positive` holds SETTING/scene terms only for region hints, so it never
  // people-loads the ranker's "prefer footage of" list (see augment* below).
  positive: string[];
  // People vocabulary kept for region fidelity but INTENTIONALLY excluded from
  // positiveConcepts — region qualifies people, it must not manufacture them.
  peopleContext?: string[];
  avoid: string[];
  fallbackQueries: string[];
  domainLabel: string;
};

const REGION_HINTS: Record<Exclude<BrollRegionPreference, "auto">, PreferenceHints> = {
  asian: {
    instruction: "When people appear in a shot, make them Asian (East or Southeast Asian); do NOT add or prefer people for object, nature, or scene shots — match the subtitle's content first. Show Asian cities, streets, and local settings when a location appears; never use Western/European-looking people.",
    positive: ["asian city", "asian street", "asian office", "asian market", "asian architecture", "asian lifestyle scene"],
    peopleContext: ["asian people", "east asian", "southeast asian", "asian business"],
    avoid: ["caucasian people", "western people", "european people", "blonde hair"],
    // Mix of settings + one people option (kept for genuinely-people scenes).
    fallbackQueries: ["asian city street", "asian market stall", "asian city detail", "bangkok street scene", "asian office workers"],
    domainLabel: "asian visual context",
  },
  thai: {
    instruction: "When people appear in a shot, make them Thai or Southeast Asian; do NOT add or prefer people for object, nature, or scene shots — match the subtitle's content first. Show Bangkok or Thailand local settings when a location appears; if Thai footage is unavailable, other Asian settings are fine — never Western/European-looking people.",
    positive: ["thailand", "bangkok", "thai street", "thai market", "thai office", "thai city scene"],
    peopleContext: ["thai people", "southeast asian", "thai business", "thai lifestyle"],
    avoid: ["caucasian people", "western people", "european people", "blonde hair"],
    fallbackQueries: [
      "bangkok street scene", "thai market stall", "bangkok city detail",
      // degrade path: thai unavailable → asian setting, never western
      "asian city street", "thai office workers",
    ],
    domainLabel: "thai visual context",
  },
  european: {
    instruction: "When people appear in a shot, make them European or Western; do NOT add or prefer people for object, nature, or scene shots — match the subtitle's content first. Show European cities and local settings when a location appears; never use Asian-looking people.",
    positive: ["european city", "european street", "western office", "european architecture", "european plaza"],
    peopleContext: ["european people", "western people", "european business"],
    avoid: ["asian people", "east asian people", "southeast asian people"],
    fallbackQueries: ["european city street", "european street detail", "european architecture", "european office workers"],
    domainLabel: "european visual context",
  },
  global: {
    instruction: "Prefer diverse, international cities and globally neutral environments; when people appear in a shot, show a multicultural mix — do not force people into object or scene shots.",
    positive: ["international city", "global cityscape", "modern office", "international architecture"],
    peopleContext: ["diverse people", "multicultural team", "diverse business"],
    avoid: [],
    fallbackQueries: ["international city street", "modern office space", "diverse business team"],
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
  surreal: {
    instruction: "Use surreal, imaginative, dreamlike visuals with unexpected juxtapositions and bold artistic composition.",
    positive: ["surreal", "dreamlike", "imaginative", "abstract", "bold colors", "artistic"],
    avoid: ["plain office", "corporate stock photo"],
    fallbackQueries: ["surreal abstract art", "dreamlike landscape", "creative light installation"],
    domainLabel: "surreal artistic style",
  },
};

function isRegionPreference(v: string): v is BrollRegionPreference {
  return v === "auto" || v === "asian" || v === "thai" || v === "european" || v === "global" || v === "no-people";
}

function isVisualStyle(v: string): v is BrollVisualStyle {
  return v === "auto" || v === "documentary" || v === "cinematic" || v === "business" || v === "lifestyle" || v === "tech" || v === "minimal" || v === "surreal";
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

/** Legacy stock-search styles are meaningful for stock and AutoMix footage.
 * Hero-only images get their identity from the pinned Brand/Project Visual
 * Context; sending both vocabularies lets the legacy style fight the selected
 * visual format in downstream prompts. */
export function shouldSendLegacyBrollVisualStyle(source: unknown): boolean {
  return source !== "kie-image";
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
      : "Treat the region setting as a qualifier for people and place queries ONLY: when a shot shows people or a location (city, street, office, school, market, home), give it the requested region/local context. Never introduce people into object, nature, product, or abstract scene shots — match the subtitle's content first."
    : "";
  const analysisGuardrail = region && region !== "no-people"
    ? "Do not add people the script doesn't imply; the region setting only qualifies queries that are already about people or places."
    : "";
  return [
    "B-ROLL VISUAL PREFERENCE:",
    hints.instruction,
    regionConstraint,
    analysisGuardrail,
    "Use this to steer query wording, visualDirection, and safe fallback queries while keeping every query filmable and relevant to the subtitle.",
  ].filter(Boolean).join("\n");
}

export function appendBrollPreferenceToDirection(direction: string, input: BrollPreferenceInput): string {
  const hints = collectPreferenceHints(input);
  if (!hints) return direction;
  const suffix = hints.instruction.replace(/\s+/g, " ").trim();
  const MAX = 320;
  const MIN_BASE = 160;
  const budget = Math.max(MIN_BASE, MAX - suffix.length - 1);
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

// Kept broad on purpose: any genuine person/role/social noun here should earn
// the region qualifier (see applyBrollPreferenceToSearchQuery). Each entry is
// a full word behind \b...\b boundaries so partial matches (e.g. "manager"
// via "age") can't sneak in — only add whole words here, never fragments.
//
// NOTE: player, speaker, driver, coach, vendor, runner were REMOVED (round-2
// review) — they're polysemous nouns that mean OBJECTS/DEVICES at least as
// often as people ("video player", "bluetooth speaker", "usb driver", "coach
// bus", "software vendor", "carpet runner"), which both wrongly added the
// region prefix to object queries AND, worse, got stripped as "people words"
// in the no-people path, deleting the actual subject of the query. Do not
// re-add them without a query-context disambiguator.
export const PEOPLE_WORD_RE =
  /\b(people|person|persons|man|woman|men|women|face|faces|portrait|portraits|crowd|crowds|student|students|worker|workers|team|teams|employee|employees|teacher|teachers|doctor|doctors|patient|patients|customer|customers|meeting|meetings|interview|interviews|presentation|presentations|audience|audiences|colleague|colleagues|family|families|couple|couples|friend|friends|kid|kids|child|children|chef|chefs|musician|musicians|athlete|athletes|engineer|engineers|ceo|ceos|founder|founders|commuter|commuters|pedestrian|pedestrians|tourist|tourists|farmer|farmers|artist|artists|handshake|handshakes|nurse|nurses|waiter|waiters|waitress|waitresses|barista|baristas|dancer|dancers|singer|singers|shopper|shoppers|passenger|passengers)\b/gi;

// Non-global twin of PEOPLE_WORD_RE for stateless `.test()` (global flag carries
// lastIndex between calls and would flap true/false).
export const PEOPLE_WORD_TEST_RE = new RegExp(PEOPLE_WORD_RE.source, "i");

// Place / setting vocabulary — a query about a location legitimately carries a
// regional look. Pure object/nature/abstract queries do NOT.
const PLACE_WORD_RE = /\b(city|cities|street|streets|office|offices|school|schools|home|homes|house|houses|market|markets|temple|temples|shop|shops|store|stores|restaurant|restaurants|cafe|cafes|crowd|crowds|team|teams|workplace|workplaces|building|buildings|road|roads|park|parks|station|stations|village|villages|town|towns|neighborhood|neighborhoods|neighbourhood|neighbourhoods|downtown|skyline|cityscape|classroom|classrooms|apartment|apartments|hospital|hospitals|factory|factories|mall|malls|airport|airports|hotel|hotels|studio|studios)\b/i;

function mentionsPeopleOrPlace(query: string): boolean {
  return PEOPLE_WORD_TEST_RE.test(query) || PLACE_WORD_RE.test(query);
}

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
  // Region is a qualifier for people/place shots — leave pure object, nature,
  // and abstract queries untouched (e.g. "growth chart" must NOT become
  // "asian growth chart", which returns photos of people on stock sites).
  if (!mentionsPeopleOrPlace(clean)) return clean;
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
