import type { RelevanceTerms } from "@/lib/relevance-spec";

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
 */
export function buildKieImagePrompt(
  subject: string,
  opts?: { visualDirection?: string; terms?: RelevanceTerms | null },
): string {
  const subj = sanitize(subject);
  const dir = sanitize(opts?.visualDirection ?? "");
  const terms = opts?.terms ?? null;
  const domain =
    terms?.domainLabel && terms.domainLabel.toLowerCase() !== "general"
      ? sanitize(terms.domainLabel)
      : "";
  const concepts = (terms?.positive ?? []).map(sanitize).filter(Boolean).slice(0, 2);

  const parts: string[] = [];
  parts.push(`A cinematic, photorealistic vertical 9:16 photograph of ${subj || domain || "a relevant scene"}`);
  if (domain) parts.push(`in a ${domain} setting`);
  if (concepts.length) parts.push(`featuring ${concepts.join(" and ")}`);
  if (dir) parts.push(dir.replace(/[.?!]+$/g, ""));
  parts.push("natural lighting, realistic detail, sharp focus, no text, no watermark, no logo, no caption");
  return `${parts.join(", ")}.`;
}
