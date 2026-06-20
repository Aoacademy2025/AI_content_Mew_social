// Verify the B-roll LLM ranker response parser degrades gracefully on Gemini's
// real-world failure modes (off-by-count, truncation, garbage) instead of
// discarding the whole batch. Run: `npx tsx scripts/verify-llm-rank-parse.ts`
import { parseLlmRankResponse } from "../src/lib/llm-rank-parse";

let passed = 0;
function eq(name: string, got: number[], want: number[]) {
  const ok = got.length === want.length && got.every((v, i) => v === want[i]);
  if (!ok) throw new Error(`FAIL: ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  console.log(`PASS: ${name}`);
  passed++;
}

const cc3 = [5, 5, 5]; // 3 keywords, 5 candidates each (max idx 4)

// 1) perfect keyed object
eq("keyed: perfect", parseLlmRankResponse('{"0":2,"1":0,"2":4}', 3, cc3), [2, 0, 4]);

// 2) THE KEY WIN — a dropped middle entry only nulls THAT index, no positional shift
eq("keyed: missing middle key → aligned, others kept", parseLlmRankResponse('{"0":2,"2":4}', 3, cc3), [2, -1, 4]);

// 3) extra / out-of-range key is ignored, no crash
eq("keyed: extra out-of-range key ignored", parseLlmRankResponse('{"0":1,"1":2,"2":3,"5":9}', 3, cc3), [1, 2, 3]);

// 4) truncated keyed object (token cap cut the tail, no closing brace) → salvage complete pairs
eq("keyed: truncated tail salvaged", parseLlmRankResponse('{"0": 2, "1": 0, "2":', 3, cc3), [2, 0, -1]);

// 5) back-compat: a plain integer array of EXACTLY expectedCount is used positionally
eq("array: exact length back-compat", parseLlmRankResponse("[2,0,4]", 3, cc3), [2, 0, 4]);

// 6) a wrong-length plain array is NOT positionally salvaged (would mis-align) → all -1
eq("array: off-by-one length → all -1 (no misalign)", parseLlmRankResponse("[2,0]", 3, cc3), [-1, -1, -1]);

// 7) pure prose / refusal → all -1 (fail-open)
eq("garbage prose → all -1", parseLlmRankResponse("I'm sorry, I can't rank these.", 3, cc3), [-1, -1, -1]);

// 8) out-of-range index clamps to last candidate; negatives → -1
eq("keyed: clamp over-range + negative", parseLlmRankResponse('{"0":99,"1":1,"2":-1}', 3, cc3), [4, 1, -1]);

// 9) markdown-fenced keyed object is still parsed
eq("keyed: markdown fence", parseLlmRankResponse("```json\n{\"0\":1,\"1\":2,\"2\":0}\n```", 3, cc3), [1, 2, 0]);

// 10) string-valued entries coerced
eq("keyed: string values coerced", parseLlmRankResponse('{"0":"3","1":"-1","2":"2"}', 3, cc3), [3, -1, 2]);

// 11) a keyword with 0 candidates can never get a pick (clamps to -1)
eq("keyed: zero-candidate keyword → -1", parseLlmRankResponse('{"0":2}', 1, [0]), [-1]);

// 12) empty / whitespace → all -1
eq("empty → all -1", parseLlmRankResponse("   ", 2, [4, 4]), [-1, -1]);

console.log(`\n${passed}/12 passed`);
