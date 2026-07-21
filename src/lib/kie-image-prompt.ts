import type { RelevanceTerms } from "@/lib/relevance-spec";
import {
  normalizeBrollRegionPreference,
  normalizeBrollVisualStyle,
  type BrollRegionPreference,
  type BrollVisualStyle,
} from "@/lib/broll-preferences";

function sanitize(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Build a content-aware text-to-image prompt for kie.ai b-roll generation.
 *
 * The old prompt was `${query}, cinematic photo, ...` where query was either a 2–5
 * word STOCK SEARCH keyword or a raw Thai subtitle — both produce generic, off-topic
 * images (the model gets a search box query, not a scene). This composes the per-caption
 * English subject with the script's already-computed relevance spec (visual domain +
 * concrete concepts) and visual direction, so the model receives an actual scene
 * description. Uses only data the fetch-stock route already holds — no extra LLM call.
 *
 * `region`/`style` are optional user preferences (see broll-preferences.ts): region
 * becomes an explicit, early people/setting clause (so it can't be truncated away and
 * survives even people-less scenes), and style swaps the opener + look line so the
 * chosen look actually changes the image instead of just appending hint words. Omitting
 * both keeps the original photorealistic template byte-compatible.
 */

// Style controls the OPENER (what kind of image) and the LOOK line (lighting/finish).
// "auto"/unknown falls back to today's photorealistic template so existing behavior is unchanged.
const STYLE_LOOKS: Record<Exclude<BrollVisualStyle, "auto">, { opener: string; look: string }> = {
  documentary: { opener: "A candid, documentary-style vertical 9:16 photograph of", look: "natural light, handheld observational feel, authentic unstaged detail, sharp focus" },
  cinematic:   { opener: "A cinematic vertical 9:16 film still of",                 look: "dramatic lighting, shallow depth of field, premium color grade, filmic contrast, sharp focus" },
  business:    { opener: "A clean, professional vertical 9:16 photograph of",       look: "bright modern lighting, crisp corporate aesthetic, realistic detail, sharp focus" },
  lifestyle:   { opener: "A warm, lifestyle vertical 9:16 photograph of",           look: "golden natural light, candid everyday mood, soft realistic detail, sharp focus" },
  tech:        { opener: "A sleek, modern vertical 9:16 photograph of",             look: "cool ambient lighting, high-tech atmosphere, precise clean detail, sharp focus" },
  minimal:     { opener: "A minimal, uncluttered vertical 9:16 photograph of",      look: "soft even light, generous negative space, simple composition, sharp focus" },
  surreal:     { opener: "A surreal, imaginative vertical 9:16 digital artwork of", look: "dreamlike atmosphere, unexpected juxtaposition, bold rich colors, painterly detail" },
};

const DEFAULT_LOOK = { opener: "A cinematic, photorealistic vertical 9:16 photograph of", look: "natural lighting, realistic detail, sharp focus" };

// Region becomes an explicit, conditional people clause near the head of the prompt —
// safe for people-less scenes ("any people shown…") and immune to tail truncation.
const REGION_CLAUSES: Record<Exclude<BrollRegionPreference, "auto">, string> = {
  asian: "any people shown are Asian (East or Southeast Asian), in an Asian setting",
  thai: "any people shown are Thai or Southeast Asian, in a Thailand local setting",
  european: "any people shown are European or Western, in a European or Western setting",
  global: "people shown are diverse and international",
  "no-people": "an unoccupied setting focused exclusively on objects and environment",
};

export function buildKieImagePrompt(
  subject: string,
  opts?: { visualDirection?: string; terms?: RelevanceTerms | null; region?: string | null; style?: string | null },
): string {
  const subj = sanitize(subject);
  const dir = sanitize(opts?.visualDirection ?? "");
  const terms = opts?.terms ?? null;
  const region = normalizeBrollRegionPreference(opts?.region);
  const style = normalizeBrollVisualStyle(opts?.style);
  const looks = style ? STYLE_LOOKS[style] : DEFAULT_LOOK;
  const domain =
    terms?.domainLabel && terms.domainLabel.toLowerCase() !== "general" ? sanitize(terms.domainLabel) : "";
  const concepts = (terms?.positive ?? []).map(sanitize).filter(Boolean).slice(0, 2);

  const parts: string[] = [];
  parts.push(`${looks.opener} ${subj || domain || "a relevant scene"}`);
  if (region) parts.push(REGION_CLAUSES[region]);
  if (domain) parts.push(`in a ${domain} setting`);
  if (concepts.length) parts.push(`featuring ${concepts.join(" and ")}`);
  if (dir) parts.push(dir.replace(/[.?!]+$/g, ""));
  // Use positive-only composition language. Some providers expose only one
  // prompt field and can turn even negated layout nouns into visual cues.
  parts.push("one unified edge-to-edge composition, one spatially continuous camera view captured at one decisive moment");
  parts.push(`${looks.look}, purely visual language-free surfaces, blank unmarked signs and labels`);
  return `${parts.join(", ")}.`;
}
