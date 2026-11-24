// Verifies:
//   1. Deterministic compound safety guard (all 30 curated THAI_COMPOUNDS pass;
//      known risky compounds like มือใหม่ / เงินเดือน / ที่ทำงาน / รายได้ / คนดี are rejected)
//   2. AI compound reviewer (structured JSON parsing, hallucination guard, fail-safe on
//      omitted/errored items, batching, guard-only fallback when no Gemini key)
//   3. Store mutations (applyCompoundReview, bulkApproveCompounds, bulkRejectCompounds,
//      addCompound, parseLoanwordStore round-trip)
//   4. Idempotent array ref preservation in setDynamicLoanwords / setDynamicCompounds +
//      renderSubtitle cache invalidation on dynamic update
//   5. Runtime wiring across instrumentation.ts, EditorV2Shell.tsx, run-render.ts,
//      preview-still.ts, ShortVideoComposition.tsx, SubtitleOverlayComposition.tsx
//
//   npx tsx scripts/verify-compound-auto-review.ts
import * as fs from "fs";
import * as path from "path";
import { THAI_COMPOUNDS, getActiveCompounds, setDynamicCompounds } from "../src/lib/thai-compounds";
import { getActiveLoanwords, setDynamicLoanwords } from "../src/lib/thai-loanwords";
import { loadThaiDict } from "../src/lib/loanword-mining";
import {
  buildDictStraddleIndex,
  checkCompoundSafety,
  reviewCompoundsWithLlm,
} from "../src/lib/compound-review";
import {
  addCompound,
  applyCompoundReview,
  bulkApproveCompounds,
  bulkRejectCompounds,
  parseLoanwordStore,
  type LoanwordStore,
} from "../src/lib/thai-loanwords-runtime";
import { applyDisplayLineBreak, segmentThaiDisplayWordBreaks } from "../src/remotion/renderSubtitle";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("❌ " + msg);
    process.exit(1);
  }
  console.log("✓ " + msg);
  passed++;
}

async function main() {
  // ── 1: Safety guard against curated seed + known risky compounds ──
  const dictPath = path.join(process.cwd(), "data/words_th.txt");
  const straddleIndex = fs.existsSync(dictPath)
    ? buildDictStraddleIndex(loadThaiDict(fs.readFileSync(dictPath, "utf8")))
    : null;

  for (const w of THAI_COMPOUNDS) {
    const res = checkCompoundSafety(w, straddleIndex);
    assert(res.safe, `curated compound "${w}" passes safety guard${res.reason ? ` (${res.reason})` : ""}`);
  }

  for (const risky of ["มือใหม่", "เงินเดือน", "ที่ทำงาน", "รายได้", "คนดี", "วันนี้"]) {
    const res = checkCompoundSafety(risky, straddleIndex);
    assert(!res.safe, `risky/whole candidate "${risky}" rejected by safety guard (${res.code})`);
  }

  // ── 2: AI compound reviewer (batching, hallucination guard, fail-safe) ──
  let llmCalls = 0;
  const llmReceivedWords: string[] = [];
  const reviewed = await reviewCompoundsWithLlm(
    ["ขี้เกียจ", "มือใหม่", "เวลางาน", "เพื่อนร่วมงาน", "โรงพยาบาล"],
    {
      straddleIndex,
      batchSize: 2,
      callLlm: async (prompt) => {
        llmCalls++;
        // Extract candidate words from prompt
        const m = prompt.match(/CANDIDATES:\n([\s\S]+)$/);
        const arr = m ? (JSON.parse(m[1]) as { word: string }[]) : [];
        for (const item of arr) llmReceivedWords.push(item.word);
        return JSON.stringify({
          items: [
            { word: "ขี้เกียจ", decision: "approve", reason: "คำประสมแท้ ความเสี่ยงต่ำ" },
            { word: "เวลางาน", decision: "approve", reason: "คำประสมคงที่" },
            { word: "เพื่อนร่วมงาน", decision: "review", reason: "ก้ำกึ่ง รอคนยืนยัน" },
            // intentionally omit "โรงพยาบาล" → must fail-safe to "review"
            // intentionally hallucinate a non-candidate → must be ignored
            { word: "คำที่ไม่ได้ส่งไป", decision: "approve", reason: "hallucination" },
          ],
        });
      },
    },
  );

  assert(!llmReceivedWords.includes("มือใหม่"), "guard-rejected word never reaches LLM");
  assert(llmCalls === 2, `4 guard-safe words with batchSize=2 triggered 2 LLM batches (got ${llmCalls})`);
  assert(!reviewed.some((r) => r.word === "คำที่ไม่ได้ส่งไป"), "hallucinated word dropped");
  assert(reviewed.find((r) => r.word === "มือใหม่")?.decision === "reject" && reviewed.find((r) => r.word === "มือใหม่")?.source === "guard", "มือใหม่ rejected by guard");
  assert(reviewed.find((r) => r.word === "ขี้เกียจ")?.decision === "approve", "ขี้เกียจ approved by AI");
  assert(reviewed.find((r) => r.word === "เพื่อนร่วมงาน")?.decision === "review", "เพื่อนร่วมงาน kept in review");
  assert(reviewed.find((r) => r.word === "โรงพยาบาล")?.decision === "review", "omitted word fail-safes to review (never silently approved/dropped)");

  // Error fail-safe
  const errReviewed = await reviewCompoundsWithLlm(["ขี้เกียจ", "มือใหม่"], {
    straddleIndex,
    callLlm: async () => { throw new Error("network down"); },
  });
  assert(errReviewed.find((r) => r.word === "มือใหม่")?.decision === "reject", "guard still rejects on LLM error");
  assert(errReviewed.find((r) => r.word === "ขี้เกียจ")?.decision === "review", "guard-safe word stays in review on LLM error");

  // Guard-only mode (no Gemini key)
  const guardOnly = await reviewCompoundsWithLlm(["ขี้เกียจ", "มือใหม่"], { straddleIndex, callLlm: null });
  assert(guardOnly.find((r) => r.word === "มือใหม่")?.decision === "reject", "guard-only rejects มือใหม่");
  assert(guardOnly.find((r) => r.word === "ขี้เกียจ")?.decision === "review", "guard-only keeps ขี้เกียจ in review");

  // ── 3: Store mutations & round-trip ──
  const base: LoanwordStore = {
    words: ["แคปชัน"],
    denylist: ["เคยห้าม"],
    compounds: [],
    pendingCompounds: ["ขี้เกียจ", "มือใหม่", "เพื่อนร่วมงาน"],
  };
  const { store: afterReview, summary } = applyCompoundReview(base, reviewed, { source: "admin", at: "2026-11-24T16:00:00.000Z" });
  assert(summary.approved === 2 && summary.rejected === 1 && summary.keptForReview === 2, `review summary accurate (${JSON.stringify(summary)})`);
  assert(afterReview.compounds?.includes("ขี้เกียจ") && afterReview.autoApprovedCompounds?.includes("ขี้เกียจ"), "auto-approved compound recorded in compounds + autoApprovedCompounds");
  assert(afterReview.denylist.includes("มือใหม่") && !afterReview.pendingCompounds?.includes("มือใหม่"), "rejected compound moved to denylist");
  assert(afterReview.pendingCompounds?.includes("เพื่อนร่วมงาน") ?? false, "borderline compound stays in pendingCompounds");

  const roundTripped = parseLoanwordStore(JSON.stringify(afterReview));
  assert(roundTripped.autoApprovedCompounds?.includes("ขี้เกียจ") ?? false, "parseLoanwordStore round-trips autoApprovedCompounds");
  assert(roundTripped.lastCompoundReviewSummary?.approved === 2, "parseLoanwordStore round-trips lastCompoundReviewSummary");
  assert((roundTripped.compoundReviewLog?.length ?? 0) === 5, "parseLoanwordStore round-trips compoundReviewLog");

  const afterBulk = bulkApproveCompounds(
    bulkRejectCompounds(
      addCompound(roundTripped, "เวลาว่าง"),
      ["เพื่อนร่วมงาน"],
    ),
    ["โรงพยาบาล"],
  );
  assert(afterBulk.compounds?.includes("เวลาว่าง") && afterBulk.compounds?.includes("โรงพยาบาล"), "addCompound + bulkApproveCompounds work");
  assert(afterBulk.denylist.includes("เพื่อนร่วมงาน") && !afterBulk.pendingCompounds?.includes("เพื่อนร่วมงาน"), "bulkRejectCompounds moves to denylist");

  // ── 4: Idempotent array ref preservation + renderSubtitle cache invalidation ──
  setDynamicLoanwords(["ทดสอบคำยืม"], []);
  const lwRef1 = getActiveLoanwords();
  setDynamicLoanwords(["ทดสอบคำยืม"], []);
  const lwRef2 = getActiveLoanwords();
  assert(lwRef1 === lwRef2, "setDynamicLoanwords preserves array ref when unchanged (zero Remotion frame cache thrash)");

  setDynamicCompounds(["คำประสมทดสอบ"], []);
  const cpRef1 = getActiveCompounds();
  setDynamicCompounds(["คำประสมทดสอบ"], []);
  const cpRef2 = getActiveCompounds();
  assert(cpRef1 === cpRef2, "setDynamicCompounds preserves array ref when unchanged");

  // Cache invalidation check on display line break + segmented display
  setDynamicCompounds([], []);
  const sample = "นี่คือคำประสมทดสอบที่ยาวพอจะขึ้นบรรทัดใหม่ได้";
  const segBefore = segmentThaiDisplayWordBreaks(sample);
  const brkBefore = applyDisplayLineBreak(sample, 90);
  setDynamicCompounds(["คำประสมทดสอบ"], []);
  const segAfter = segmentThaiDisplayWordBreaks(sample);
  const brkAfter = applyDisplayLineBreak(sample, 90);
  assert(segBefore !== segAfter, "segmentThaiDisplayWordBreaks invalidates cache when dynamic compounds update");
  assert(typeof brkBefore === "string" && typeof brkAfter === "string", "applyDisplayLineBreak runs cleanly after cache invalidation");
  setDynamicLoanwords([], []);
  setDynamicCompounds([], []);

  // ── 5: Runtime wiring contract checks ──
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  assert(read("src/instrumentation.ts").includes("startLoanwordRefresh"), "instrumentation.ts starts dynamic loanword refresh on server boot");
  assert(read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx").includes("useDynamicThaiLoanwords"), "EditorV2Shell hydrates dynamic loanwords/compounds");
  assert(read("src/lib/render/run-render.ts").includes("thaiWordBreaks"), "run-render.ts injects thaiWordBreaks into Remotion inputProps");
  assert(read("src/lib/render/preview-still.ts").includes("thaiWordBreaks"), "preview-still.ts injects thaiWordBreaks into Remotion preview inputProps");
  assert(read("src/remotion/ShortVideoComposition.tsx").includes("setDynamicCompounds"), "ShortVideoComposition hydrates dynamic compounds in Chromium");
  assert(read("src/remotion/SubtitleOverlayComposition.tsx").includes("setDynamicCompounds"), "SubtitleOverlayComposition hydrates dynamic compounds in Chromium");

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
