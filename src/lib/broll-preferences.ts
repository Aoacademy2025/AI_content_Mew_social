import type { RelevanceSpec } from "@/lib/relevance-spec";
import {
  stylePackSnapshotFromJson,
  type ResolvedStockMood,
  type StylePackSnapshot,
} from "@/lib/style-pack-snapshot";
import type { PacingLevel } from "@/lib/style-pack-catalog";

export type { ResolvedStockMood } from "@/lib/style-pack-snapshot";

export type BrollRegionPreference = "auto" | "asian" | "thai" | "european" | "global" | "no-people";
export type BrollVisualStyle = "auto" | "documentary" | "cinematic" | "business" | "lifestyle" | "tech" | "minimal" | "surreal";

export type BrollPreferenceInput = {
  brollRegionPreference?: BrollRegionPreference | string | null;
  /** Pre-Style-Pack Step-2 menu. Kept on the wire for drafts saved before wave
   *  1; IGNORED entirely whenever a Stock Mood is present (ADR 0057: one style
   *  system, never two vocabularies fighting over the same query). */
  brollVisualStyle?: BrollVisualStyle | string | null;
  /** The pinned Style Pack's Stock Mood, snapshotted at publish time and
   *  resolved server-side (`stockMoodForProject`). `null`/absent = no pack. */
  stockMood?: ResolvedStockMood | null;
};

export const BROLL_REGION_OPTIONS: { value: BrollRegionPreference; label: string }[] = [
  { value: "auto", label: "ตามเนื้อหา" },
  { value: "asian", label: "เน้นเอเชีย" },
  { value: "thai", label: "เน้นไทย" },
  { value: "european", label: "เน้นยุโรป" },
  { value: "global", label: "นานาชาติ" },
  { value: "no-people", label: "หลีกเลี่ยงคน" },
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

export function hasBrollPreference(input: BrollPreferenceInput): boolean {
  return Boolean(
    normalizeBrollRegionPreference(input.brollRegionPreference)
    || effectiveStockMood(input)
    || normalizeBrollVisualStyle(input.brollVisualStyle),
  );
}

/** The mood, if the caller supplied one. A mood always wins over the legacy
 *  style — every read of the style goes through `effectiveVisualStyle`. */
function effectiveStockMood(input: BrollPreferenceInput): ResolvedStockMood | null {
  return input.stockMood ?? null;
}

function effectiveVisualStyle(input: BrollPreferenceInput): Exclude<BrollVisualStyle, "auto"> | undefined {
  return effectiveStockMood(input) ? undefined : normalizeBrollVisualStyle(input.brollVisualStyle);
}

/** The mood expressed in the same shape as a legacy style hint, so it lands on
 *  exactly the wave-0 rails (prompt block, ranker spec, visual direction) with
 *  no second code path to keep in sync. */
function stockMoodHints(mood: ResolvedStockMood): PreferenceHints {
  return {
    instruction: mood.direction,
    positive: mood.positive,
    avoid: mood.avoid,
    fallbackQueries: mood.fallbackQueries,
    domainLabel: `${mood.queryToken} visual mood`,
  };
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
  const mood = effectiveStockMood(input);
  const style = effectiveVisualStyle(input);
  if (!region && !mood && !style) return null;

  const regionHint = region ? REGION_HINTS[region] : null;
  // The mood occupies the style slot: same rails, one vocabulary.
  const styleHint = mood ? stockMoodHints(mood) : style ? STYLE_HINTS[style] : null;
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
    // The ranker prompt only ever sees positiveConcepts.slice(0, 12) and
    // avoidConcepts.slice(0, 8) (fetch-stock/route.ts), so appending the
    // preference hints AFTER the model's own concepts sliced them straight back
    // off again — the ranker never saw the preference at all (F7 cause #5).
    // Lead with the strongest preference hints; the model's concepts keep the
    // rest of the budget, and the remaining hints trail behind them.
    positiveConcepts: mergeUnique(hints.positive.slice(0, 4), spec?.positiveConcepts, hints.positive).slice(0, 24),
    avoidConcepts: mergeUnique(hints.avoid, spec?.avoidConcepts).slice(0, 24),
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

/** One stock-search word per visual style — the ONE token that changes the
 *  candidate pool on Pexels/Pixabay. Deliberately a single common word: stock
 *  search engines match tags, so a phrase ("dramatic lighting shallow depth of
 *  field") narrows a query to nothing while one tag word re-sorts the pool. */
export const STYLE_QUERY_TOKENS: Record<Exclude<BrollVisualStyle, "auto">, string> = {
  documentary: "documentary",
  cinematic: "cinematic",
  business: "business",
  lifestyle: "lifestyle",
  tech: "technology",
  minimal: "minimal",
  surreal: "surreal",
};

/** A PRIMARY query is one the creator should see their style in (the per-scene
 *  query and its LLM alternatives). A FALLBACK query is a widening/safety net
 *  that runs only because the primaries came back empty — narrowing it with the
 *  style token would defeat the widening, so style is never applied there.
 *  Region applies to BOTH: it is a correctness constraint, not a flavour. */
export type ApplyQueryOptions = { role: "primary" | "fallback" };

export function applyBrollPreferenceToSearchQuery(
  query: string,
  input: BrollPreferenceInput,
  options: ApplyQueryOptions = { role: "primary" },
): string {
  const clean = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!clean) return "";

  let out = clean;
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  if (region === "no-people") {
    const withoutPeople = clean.replace(PEOPLE_WORD_RE, "").replace(/\s+/g, " ").trim();
    const base = withoutPeople || clean;
    out = hasConstraintAlias(base, ["no people", "empty", "object", "objects", "hands", "workspace", "detail"])
      ? base
      : `${base} no people`;
  } else if (region) {
    const constraint = REGION_SEARCH_CONSTRAINTS[region];
    // Region is a qualifier for people/place shots — leave pure object, nature,
    // and abstract queries untouched (e.g. "growth chart" must NOT become
    // "asian growth chart", which returns photos of people on stock sites).
    if (constraint && !hasConstraintAlias(clean, constraint.aliases) && mentionsPeopleOrPlace(clean)) {
      out = `${constraint.required} ${clean}`;
    }
  }

  // One flavour token per primary query — the pinned pack's Stock Mood when the
  // project has one, else the legacy Step-2 style. Never both.
  const mood = effectiveStockMood(input);
  const style = effectiveVisualStyle(input);
  const token = mood ? mood.queryToken.trim().toLowerCase() : style ? STYLE_QUERY_TOKENS[style] : "";
  if (token && options.role === "primary") {
    if (!hasConstraintAlias(out, [token])) out = `${out} ${token}`;
  }
  return out;
}

export function applyBrollPreferenceToSearchQueries(
  queries: string[],
  input: BrollPreferenceInput,
  options: ApplyQueryOptions = { role: "primary" },
): string[] {
  const out: string[] = [];
  for (const query of queries) {
    const preferred = applyBrollPreferenceToSearchQuery(query, input, options);
    if (preferred && !out.includes(preferred)) out.push(preferred);
  }
  return out;
}

/** Cache discriminator for the managed-stock 24h search cache: two different
 *  preferences must never be served each other's cached answer (F7 cause #2).
 *  Empty for "no preference", which keeps every existing cache entry valid. */
export function brollPreferenceCacheVariant(input: BrollPreferenceInput): string {
  const region = normalizeBrollRegionPreference(input.brollRegionPreference);
  const mood = effectiveStockMood(input);
  const style = effectiveVisualStyle(input);
  // "m=<packId>" REPLACES "s=<style>" when a pack is pinned: the two never
  // co-exist in a query, so they must never co-exist in the cache key either.
  const flavour = mood ? `m=${mood.packId}` : style ? `s=${style}` : "";
  return [region ? `r=${region}` : "", flavour].filter(Boolean).join(";");
}

/** The pinned Style Pack snapshot one video job renders with, from immutable
 *  JSON snapshots only (ADR 0005 — never re-resolved from the catalog).
 *  `stockMoodForProject` and `pacingForProject` are both readers over this ONE
 *  precedence, so a pack can never show one facet from the per-clip context
 *  and another from the Brand Revision recipe.
 *
 *  Precedence: the per-clip pinned Project Visual Context wins over the Brand
 *  Revision's recipe, because a creator who changed the pack for THIS clip has
 *  already overruled the brand default. Neither carrying a pack = no snapshot.
 *  Every failure mode (missing, unreadable, wrong-shaped JSON) returns `null`:
 *  a Style Pack is a flavour, never a reason for a render to stop. */
function resolvedStylePackSnapshot(input: {
  projectVisualContextJson: string | null;
  brandRevisionRecipeJson: string | null;
}): StylePackSnapshot | null {
  return stylePackSnapshotFromJson(input.projectVisualContextJson)
    ?? stylePackSnapshotFromJson(input.brandRevisionRecipeJson);
}

/** Resolve the Stock Mood one video job should search with. See
 *  `resolvedStylePackSnapshot` for precedence and fail-open behaviour. */
export function stockMoodForProject(input: {
  projectVisualContextJson: string | null;
  brandRevisionRecipeJson: string | null;
}): ResolvedStockMood | null {
  const snapshot = resolvedStylePackSnapshot(input);
  return snapshot ? { packId: snapshot.id, ...snapshot.stockMood } : null;
}

/** Resolve the Pacing one video job's B-roll window cadence and AI-gen/auto-mix
 *  min-hold should use — the SAME precedence and post-pin read as
 *  `stockMoodForProject` (see `resolvedStylePackSnapshot`), never a second
 *  lookup path. `null` means "no pack pinned" (neither source carries one, or
 *  the snapshot is unreadable) — deliberately NOT defaulted to `"normal"`
 *  here: a caller that needs a cadence multiplier can treat `null` as ×1
 *  (`"normal"`'s own multiplier), but a caller deciding whether to send an
 *  explicit `minHoldSec` override MUST be able to tell "no pack, defer to the
 *  operator's env default" apart from "a pack is pinned and its pacing
 *  happens to be normal" — collapsing both to `"normal"` made the min-hold
 *  override fire unconditionally and silently override `STOCK_MIN_HOLD_SEC`
 *  even with no pack pinned at all. Pacing is a cadence hint, never a reason
 *  for a render to stop. */
export function pacingForProject(input: {
  projectVisualContextJson: string | null;
  brandRevisionRecipeJson: string | null;
}): PacingLevel | null {
  return resolvedStylePackSnapshot(input)?.pacing ?? null;
}
