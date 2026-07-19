// LLM-based Thai loanword detector — Pass 2 of the daily miner. Unlike the
// dictionary-oracle miner (loanword-mining.ts), this does NOT require the word to
// exist in any dict: the LLM proposes transliterations a naive Thai segmenter
// would break. To keep AUTO-APPLY safe (no human in the loop), every candidate
// must clear 4 guards before it can be added:
//   1. verbatim — appears EXACTLY in a real script  → kills hallucination
//   2. ICU actually mis-splits it (>=2 word-like tokens)
//   3. has a "gibberish" fragment (>=1 ICU piece not in the Thai dict)
//      → rejects two real Thai words the LLM glued together
//   4. Thai, >=4 chars, not already known (seed/store/denylist)
// Pure + network-free except mineWithLlm, which takes an injected LLM caller.

const seg = new Intl.Segmenter("th", { granularity: "word" });
const isThai = (s: string) => /[฀-๿]/.test(s);
const wordLikeFrags = (w: string) =>
  [...seg.segment(w)].filter((t) => (t as { isWordLike?: boolean }).isWordLike).map((t) => t.segment);

export function icuMisSplits(word: string): boolean {
  return wordLikeFrags(word).length >= 2;
}

// Guard 3: a genuine broken transliteration has at least one ICU fragment that is
// NOT a real Thai dictionary word. If every fragment is a dict word, it is more
// likely two native words stuck together (no space) → reject so we never force a
// wrong merge in real subtitles.
export function hasGibberishFragment(word: string, dict: Set<string>): boolean {
  return wordLikeFrags(word).some((f) => !dict.has(f));
}

export function buildMinerPrompt(scripts: string[]): string {
  const corpus = scripts.join("\n---\n").slice(0, 24000);
  return [
    "You are a Thai NLP assistant. Below are Thai short-video scripts.",
    "List every Thai *transliterated loanword* (foreign word written in Thai script:",
    "brand names, tech/business/medical/beauty/finance/food terms, etc.) that a naive",
    "Thai word segmenter would likely split mid-word. Return ONLY a JSON array of",
    "strings, each the FULL loanword exactly as written — no fragments, no native Thai",
    "words, no English, no phrases. Example: [\"แคปชัน\",\"คริปโต\",\"เดลิเวอรี\"]",
    "",
    "SCRIPTS:",
    corpus,
  ].join("\n");
}

export function parseMinerResponse(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function validateCandidates(
  words: string[],
  scripts: string[],
  covered: Set<string>,
  dict: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w) || covered.has(w)) continue;
    if (!isThai(w) || w.length < 4) continue;             // guard 4
    if (!scripts.some((s) => s.includes(w))) continue;     // guard 1: verbatim
    if (!icuMisSplits(w)) continue;                        // guard 2
    if (!hasGibberishFragment(w, dict)) continue;          // guard 3
    seen.add(w);
    out.push(w);
  }
  return out;
}

export async function mineWithLlm(
  scripts: string[],
  covered: Set<string>,
  dict: Set<string>,
  callLlm: (prompt: string) => Promise<string>,
): Promise<string[]> {
  if (scripts.length === 0) return [];
  try {
    const raw = await callLlm(buildMinerPrompt(scripts));
    return validateCandidates(parseMinerResponse(raw), scripts, covered, dict);
  } catch (e) {
    console.warn("[llm-loanwords] mine failed (fail-open):", e instanceof Error ? e.message : e);
    return [];
  }
}

// ── Native-compound RANKING (Part 2, optional noise-reducer) ──────────────────
// The dictionary-oracle compound miner (loanword-mining.ts mineCompoundCandidates)
// yields every dict word ICU split into all-real fragments — which includes both
// genuine fixed compounds (ขี้เกียจ, เวลางาน) AND incidental word sequences. This LLM
// pass keeps only the genuine compounds so the admin review queue stays low-noise. It
// never PROPOSES words (input is the miner's candidates), never AUTO-APPLIES anything
// (output still lands in pendingCompounds for human approval), and only ever narrows the
// list — every kept word must be one of the inputs (guards against hallucination).
export function buildCompoundRankPrompt(candidates: string[]): string {
  return [
    "You are a Thai NLP assistant. Below is a JSON array of Thai character sequences that",
    "a word segmenter split apart. For EACH, decide whether it is a GENUINE fixed lexical",
    "compound or set collocation that should stay as a SINGLE unit in subtitles",
    "(e.g. ขี้เกียจ, เวลางาน, โรงพยาบาล) — as opposed to two unrelated words that merely",
    "appeared next to each other. Return ONLY a JSON array containing the ones that ARE",
    "genuine compounds, each string EXACTLY as given — no new words, no fragments, no",
    "explanation.",
    "",
    "CANDIDATES:",
    JSON.stringify(candidates),
  ].join("\n");
}

export async function rankCompoundsWithLlm(
  candidates: string[],
  callLlm: (prompt: string) => Promise<string>,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const raw = await callLlm(buildCompoundRankPrompt(candidates));
    const allowed = new Set(candidates);
    const kept = parseMinerResponse(raw).filter((w) => allowed.has(w)); // never introduce non-candidates
    // A genuine subset → use it. Empty/garbled response → keep ALL for human review
    // (a flaky LLM must never silently discard candidates; the human gate is the backstop).
    return kept.length > 0 ? kept : candidates;
  } catch (e) {
    console.warn("[llm-compounds] rank failed (fail-open, keeping all):", e instanceof Error ? e.message : e);
    return candidates;
  }
}
