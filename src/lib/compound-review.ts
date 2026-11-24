// Compound auto-reviewer: deterministic safety guard + structured Gemini review.
//
// Why 2 layers?
//   1. `loanwordSpans()` matches via substring `indexOf`. Even a genuine Thai
//      compound can cause false merges in free running text if its edges are
//      grammatical function words or hyper-common standalone words (e.g. "มือใหม่"
//      inside "ล้างมือใหม่ๆ", or "รายได้" / "ที่ทำงาน"). Layer 1 rejects those
//      deterministically without spending LLM tokens.
//   2. Layer 2 asks Gemini (with structured JSON output) to classify safe
//      candidates into:
//        - "approve" → genuine fixed Thai compound, low false-merge risk (auto-applied)
//        - "reject"  → incidental adjacent words or risky substring (auto-denied)
//        - "review"  → genuinely borderline case kept for optional human review
//
// Pure & network-free except `reviewCompoundsWithLlm`, which takes an injected
// LLM caller so verification scripts stay deterministic.

export type CompoundReviewDecision = "approve" | "reject" | "review";

export interface CompoundReviewItem {
  word: string;
  decision: CompoundReviewDecision;
  source: "guard" | "ai";
  reason: string;
  frags: string[];
}

export interface CompoundSafetyResult {
  safe: boolean;
  code?: "invalid_thai" | "icu_already_whole" | "function_word_edge" | "common_pair_edge" | "dict_straddle";
  reason?: string;
  frags: string[];
}

const seg = new Intl.Segmenter("th", { granularity: "word" });

export function compoundIcuFrags(word: string): string[] {
  return [...seg.segment(word)]
    .filter((t) => (t as { isWordLike?: boolean }).isWordLike)
    .map((t) => t.segment);
}

// Pure grammatical function words / particles / prepositions / auxiliaries.
// If a candidate starts OR ends with one of these ICU segments, substring
// matching is too likely to glue across a real syntactic boundary.
// Verified against THAI_COMPOUNDS (all 30 curated seed entries pass).
const FUNCTION_WORD_EDGES = new Set([
  "ที่", "ไม่", "ได้", "ใน", "ของ", "จะ", "และ", "การ", "ความ", "มี", "ให้",
  "เป็น", "กับ", "ก็", "ว่า", "แต่", "นี้", "นั้น", "ต้อง", "กัน", "อยู่",
  "แล้ว", "ยัง", "ครับ", "ค่ะ", "คะ", "นะ", "เลย", "ด้วย", "จาก", "ถึง",
  "เพื่อ", "เพราะ", "ถ้า", "หรือ", "คือ", "ซึ่ง", "โดย", "ตาม", "ทั้ง",
  "แค่", "เพียง", "กว่า", "อย่าง", "อัน", "ส่วน", "เมื่อ", "จน", "จึง",
  "จึงจะ", "แต่ว่า", "เพราะว่า", "ถ้าหาก", "หรือว่า", "สำหรับ", "เกี่ยวกับ",
]);

// High-frequency standalone content words. A short 2-piece candidate whose
// BOTH edges come from this set (e.g. มือ|ใหม่, เงิน|เดือน, คน|ดี) has high
// running-text collision risk ("ล้างมือใหม่ๆ", "โอนเงินเดือนนี้").
// Single-side occurrence (e.g. มือ|อาชีพ, ขี้|น้อยใจ) is allowed to proceed to AI review.
const HYPER_COMMON_CONTENT_EDGES = new Set([
  "มือ", "ใหม่", "เก่า", "ดี", "มาก", "น้อย", "ใหญ่", "เล็ก", "ราย", "เงิน",
  "ค่า", "ใจ", "คน", "ตัว", "วัน", "ทำ", "มา", "ไป", "เอา", "ใช้", "ดู",
  "งาน", "หน้า", "หลัง", "ออก", "เข้า", "ขึ้น", "ลง", "น้ำ", "ทาง", "เรื่อง",
  "แบบ", "บ้าน", "เมือง", "ปี", "เดือน", "ซื้อ", "ขาย", "จ่าย", "ลด", "เพิ่ม",
  "รู้", "เห็น", "คิด", "พูด", "บอก", "ช่วย", "เปิด", "ปิด", "ส่ง", "รับ",
  "สร้าง", "ตัว", "เอง", "ทุก", "สุด", "จริง", "จัด", "อยาก", "ตอน", "เวลา",
]);

// Exception: specific lexical prefixes like "เวลา" + "งาน" / "ว่าง" or "เพื่อน" + "บ้าน"
// are curated safe patterns only when not both hyper-common; keep "เวลา" out of
// HYPER_COMMON_CONTENT_EDGES? Wait: "เวลางาน" has เวลา|งาน — remove "เวลา" from
// HYPER_COMMON_CONTENT_EDGES so curated "เวลางาน" / "เวลาว่าง" pass Layer 1.
HYPER_COMMON_CONTENT_EDGES.delete("เวลา");

// Precomputed dictionary straddle index for fast batch checking of hundreds of
// pending compounds against `data/words_th.txt`.
export interface DictStraddleIndex {
  dict: Set<string>;
  dictArr: string[];
  maxLen: number;
}

export function buildDictStraddleIndex(dict: Set<string>): DictStraddleIndex {
  const dictArr: string[] = [];
  let maxLen = 2;
  for (const w of dict) {
    if (/^[ก-๙]+$/.test(w)) {
      dictArr.push(w);
      if (w.length > maxLen) maxLen = w.length;
    }
  }
  return { dict, dictArr, maxLen };
}

const COMMONISH_SHORT = new Set([
  "ได้", "ไป", "มา", "ให้", "ใจ", "ราย", "งาน", "ของ", "ค่า", "นาย",
  "ตัว", "ทำ", "คน", "ไม่", "ที่", "การ", "มี", "จน",
]);

function isCommonishWord(w: string): boolean {
  return w.length >= 3 || COMMONISH_SHORT.has(w);
}

function findStraddleHit(index: DictStraddleIndex, candidate: string): string | null {
  const { dict, dictArr, maxLen } = index;
  const straddleAt = (W: string, p: number, cs: number, ce: number): string | null => {
    if (p <= 0 || p >= W.length) return null;
    for (let a = Math.max(0, p - maxLen); a < p; a++) {
      for (let L = p - a + 1; a + L <= W.length && L <= maxLen; L++) {
        const sub = W.slice(a, a + L);
        if (a + L > p && dict.has(sub) && !(a <= cs && a + L >= ce) && isCommonishWord(sub)) {
          return `${W}(${sub})`;
        }
      }
    }
    return null;
  };

  for (const W of dictArr) {
    if (W.length <= candidate.length) continue;
    let from = 0;
    let idx: number;
    while ((idx = W.indexOf(candidate, from)) !== -1) {
      const s1 = straddleAt(W, idx, idx, idx + candidate.length);
      if (s1) return s1;
      const s2 = straddleAt(W, idx + candidate.length, idx, idx + candidate.length);
      if (s2) return s2;
      from = idx + 1;
    }
  }
  return null;
}

export function checkCompoundSafety(
  word: string,
  straddleIndex?: DictStraddleIndex | null,
): CompoundSafetyResult {
  const trimmed = typeof word === "string" ? word.trim() : "";
  const frags = trimmed ? compoundIcuFrags(trimmed) : [];
  if (!/^[ก-๙]{4,24}$/.test(trimmed)) {
    return { safe: false, code: "invalid_thai", reason: "ไม่ใช่คำไทยความยาว 4–24 ตัวอักษร", frags };
  }
  if (frags.length < 2) {
    return { safe: false, code: "icu_already_whole", reason: "ICU ตัดเป็นคำเดียวอยู่แล้ว", frags };
  }
  const first = frags[0];
  const last = frags[frags.length - 1];
  if (FUNCTION_WORD_EDGES.has(first) || FUNCTION_WORD_EDGES.has(last)) {
    const edge = FUNCTION_WORD_EDGES.has(first) ? first : last;
    return {
      safe: false,
      code: "function_word_edge",
      reason: `ขอบคำเป็นคำเชื่อม/คำเจอบ่อย "${edge}" เสี่ยงรวมคำผิดบริบท`,
      frags,
    };
  }
  if (
    frags.length === 2
    && trimmed.length <= 9
    && HYPER_COMMON_CONTENT_EDGES.has(first)
    && HYPER_COMMON_CONTENT_EDGES.has(last)
  ) {
    return {
      safe: false,
      code: "common_pair_edge",
      reason: `ทั้งสองชิ้น (${first}|${last}) เป็นคำทั่วไปเจอบ่อย เสี่ยงรวมข้ามคำ`,
      frags,
    };
  }
  if (straddleIndex) {
    const hit = findStraddleHit(straddleIndex, trimmed);
    if (hit) {
      return {
        safe: false,
        code: "dict_straddle",
        reason: `เสี่ยงตัดทับคำอื่นในพจนานุกรม (${hit})`,
        frags,
      };
    }
  }
  return { safe: true, frags };
}

export const COMPOUND_REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          decision: { type: "string", enum: ["approve", "reject", "review"] },
          reason: { type: "string" },
        },
        required: ["word", "decision", "reason"],
      },
    },
  },
  required: ["items"],
};

export function buildCompoundReviewPrompt(
  candidates: { word: string; frags: string[] }[],
): string {
  const payload = candidates.map((c) => ({ word: c.word, split: c.frags.join("|") }));
  return [
    "You are a senior Thai linguist and subtitle QA reviewer.",
    "Our Thai subtitle engine merges approved compound words using substring matching (`indexOf`) so Chromium/ICU never splits them mid-word across lines or caption cards.",
    "",
    "For EACH candidate below, choose ONE decision:",
    '- "approve": Genuine fixed Thai lexical compound / set phrase that should ALWAYS stay together in subtitles AND has LOW risk of accidental false-merge inside unrelated sentences. Good examples: ขี้เกียจ, เวลางาน, โรงพยาบาล, เพื่อนร่วมงาน, โทรศัพท์มือถือ, ผลกระทบ, ความสัมพันธ์ (if safe), ต่างประเทศ, ประสิทธิภาพ, ผู้ประกอบการ, อัตโนมัติ, แรงบันดาลใจ.',
    '- "reject": NOT a fixed compound (just 2 ordinary words adjacent, verb+object, noun+modifier, personal phrase) OR HIGH risk of false-merging across a word boundary in unrelated text. Examples to reject: คนดี, งานดี, มือใหม่ (false-merges in ล้างมือใหม่ๆ), บ้านใหม่, วันนี้ดี, ทำเงิน, ใช้เงิน.',
    '- "review": ONLY for genuinely ambiguous / borderline cases where a human editor should decide. Keep "review" rare (only when truly uncertain).',
    "",
    "Rules:",
    "- Return JSON matching the schema `{ items: [{ word, decision, reason }] }`.",
    "- Every `word` MUST match one of the input words verbatim. Include ALL input words.",
    "- `reason` must be a concise Thai explanation (<= 55 chars).",
    "",
    "CANDIDATES:",
    JSON.stringify(payload),
  ].join("\n");
}

export function parseCompoundReviewResponse(
  raw: string,
  allowed: Set<string>,
): Map<string, { decision: CompoundReviewDecision; reason: string }> {
  const out = new Map<string, { decision: CompoundReviewDecision; reason: string }>();
  if (typeof raw !== "string" || !raw.trim()) return out;

  // Support both `{ items: [...] }` and a bare JSON array `[...]` fallback.
  let parsed: unknown = null;
  const trimmed = raw.trim();
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const objStart = trimmed.indexOf("{");
    const objEnd = trimmed.lastIndexOf("}");
    const arrStart = trimmed.indexOf("[");
    const arrEnd = trimmed.lastIndexOf("]");
    const trySlice = (s: number, e: number) => {
      if (s < 0 || e <= s) return null;
      try { return JSON.parse(trimmed.slice(s, e + 1)); } catch { return null; }
    };
    parsed = trySlice(objStart, objEnd) ?? trySlice(arrStart, arrEnd);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items))
      ? (parsed as { items: unknown[] }).items
      : [];

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const word = typeof (row as { word?: unknown }).word === "string" ? (row as { word: string }).word.trim() : "";
    const decision = (row as { decision?: unknown }).decision;
    const reason = typeof (row as { reason?: unknown }).reason === "string"
      ? (row as { reason: string }).reason.trim().slice(0, 100)
      : "";
    if (!word || !allowed.has(word)) continue;
    if (decision !== "approve" && decision !== "reject" && decision !== "review") continue;
    out.set(word, { decision, reason });
  }
  return out;
}

export interface ReviewCompoundsOptions {
  dict?: Set<string> | null;
  straddleIndex?: DictStraddleIndex | null;
  batchSize?: number;
  callLlm?: ((prompt: string) => Promise<string>) | null;
}

export async function reviewCompoundsWithLlm(
  candidates: string[],
  opts: ReviewCompoundsOptions = {},
): Promise<CompoundReviewItem[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const w = typeof raw === "string" ? raw.trim() : "";
    if (!w || seen.has(w)) continue;
    seen.add(w);
    unique.push(w);
  }
  if (unique.length === 0) return [];

  const straddleIndex = opts.straddleIndex
    ?? (opts.dict ? buildDictStraddleIndex(opts.dict) : null);

  const results: CompoundReviewItem[] = [];
  const safeQueue: { word: string; frags: string[] }[] = [];

  for (const word of unique) {
    const safety = checkCompoundSafety(word, straddleIndex);
    if (!safety.safe) {
      results.push({
        word,
        decision: "reject",
        source: "guard",
        reason: safety.reason ?? "ไม่ผ่านเกณฑ์ความปลอดภัยคำประสม",
        frags: safety.frags,
      });
    } else {
      safeQueue.push({ word, frags: safety.frags });
    }
  }

  if (safeQueue.length === 0) return results;

  // Without an LLM caller (e.g. server Gemini key absent), keep guard-safe words
  // in "review" — never auto-approve without AI or human confirmation.
  if (!opts.callLlm) {
    for (const c of safeQueue) {
      results.push({
        word: c.word,
        decision: "review",
        source: "guard",
        reason: "ผ่านเกณฑ์ความปลอดภัย (รอ AI หรือแอดมินตรวจ)",
        frags: c.frags,
      });
    }
    return results;
  }

  const batchSize = Math.max(1, Math.min(50, opts.batchSize ?? 35));
  for (let i = 0; i < safeQueue.length; i += batchSize) {
    const batch = safeQueue.slice(i, i + batchSize);
    const allowed = new Set(batch.map((b) => b.word));
    try {
      const raw = await opts.callLlm(buildCompoundReviewPrompt(batch));
      const verdictMap = parseCompoundReviewResponse(raw, allowed);
      for (const c of batch) {
        const verdict = verdictMap.get(c.word);
        if (verdict) {
          results.push({
            word: c.word,
            decision: verdict.decision,
            source: "ai",
            reason: verdict.reason || (
              verdict.decision === "approve"
                ? "คำประสมแท้ ความเสี่ยงตัดผิดต่ำ"
                : verdict.decision === "reject"
                  ? "ไม่ใช่คำประสมคงที่หรือเสี่ยงตัดผิด"
                  : "คำก้ำกึ่ง รอคนยืนยัน"
            ),
            frags: c.frags,
          });
        } else {
          // Omitted by LLM → fail-safe to human review (never silently approve/drop).
          results.push({
            word: c.word,
            decision: "review",
            source: "ai",
            reason: "AI ไม่ได้ระบุผล เก็บไว้รอตรวจ",
            frags: c.frags,
          });
        }
      }
    } catch (e) {
      console.warn("[compound-review] LLM batch failed (keeping in review):", e instanceof Error ? e.message : e);
      for (const c of batch) {
        results.push({
          word: c.word,
          decision: "review",
          source: "ai",
          reason: "เรียก AI ไม่สำเร็จ เก็บไว้รอตรวจ",
          frags: c.frags,
        });
      }
    }
  }

  return results;
}
