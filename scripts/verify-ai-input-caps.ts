// verify-ai-input-caps.ts — managed-Gemini cost guard (L4)
// Pure unit test (no DB). Bounds per-request Gemini blast radius: a single call
// can't smuggle an unbounded script / scenes[] / whisperWords[] that amplifies
// into hundreds of server-key Gemini calls (extract-keywords was the worst case).
// Run: npx tsx scripts/verify-ai-input-caps.ts
import { AI_INPUT_CAPS, checkAiInputCaps } from "../src/lib/ai-input-caps";

let passed = 0;
function ok(c: boolean, m: string) {
  if (!c) { console.error("FAIL: " + m); process.exit(1); }
  console.log("ok: " + m); passed++;
}

function main() {
  // caps exist + sane
  ok(AI_INPUT_CAPS.scriptChars >= 8000, "scriptChars cap defined (>=8000)");
  ok(AI_INPUT_CAPS.scenes >= 300, "scenes cap defined (>=300)");
  ok(AI_INPUT_CAPS.transcriptWords >= 5000, "transcriptWords cap defined");

  // under caps → ok
  ok(checkAiInputCaps({ script: "x".repeat(100) }).ok === true, "short script → ok");
  ok(checkAiInputCaps({ scenes: new Array(50) }).ok === true, "50 scenes → ok");
  ok(checkAiInputCaps({ words: new Array(1000) }).ok === true, "1000 words → ok");
  ok(checkAiInputCaps({}).ok === true, "empty input → ok");
  ok(checkAiInputCaps({ script: undefined, scenes: undefined }).ok === true, "undefined fields → ok");

  // over caps → not ok + message
  const s = checkAiInputCaps({ script: "x".repeat(AI_INPUT_CAPS.scriptChars + 1) });
  ok(s.ok === false && !!s.message, "script over cap → blocked with message");

  const sc = checkAiInputCaps({ scenes: new Array(AI_INPUT_CAPS.scenes + 1) });
  ok(sc.ok === false && !!sc.message, "scenes over cap → blocked with message");

  const w = checkAiInputCaps({ words: new Array(AI_INPUT_CAPS.transcriptWords + 1) });
  ok(w.ok === false && !!w.message, "words over cap → blocked with message");

  // exactly at cap → ok (inclusive)
  ok(checkAiInputCaps({ scenes: new Array(AI_INPUT_CAPS.scenes) }).ok === true, "exactly at scenes cap → ok");

  console.log(`\n✅ ALL ${passed} AI-INPUT-CAP CHECKS PASSED`);
}

main();
