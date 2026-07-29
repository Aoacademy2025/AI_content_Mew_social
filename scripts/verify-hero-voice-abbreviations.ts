// Verify Thai abbreviation expansion + sentence-gap heuristics for Hero Voice.
// Run: npx tsx scripts/verify-hero-voice-abbreviations.ts

import { expandThaiSpeechAbbreviations, prepareHeroVoiceSpeechText } from "../src/lib/hero-voice-speech";
import { heroVoiceGapMsAfterChunk, heroVoiceSilencePcm } from "../src/lib/hero-voice-audio";

let failures = 0;

function expectSpeech(input: string, mustContain: string[], mustNotContain: string[] = []) {
  const speech = prepareHeroVoiceSpeechText(input);
  for (const expected of mustContain) {
    if (!speech.includes(expected)) {
      failures += 1;
      console.error(`FAIL: "${input}" → "${speech}" — missing "${expected}"`);
    }
  }
  for (const banned of mustNotContain) {
    if (speech.includes(banned)) {
      failures += 1;
      console.error(`FAIL: "${input}" → "${speech}" — must not contain "${banned}"`);
    }
  }
}

function expectGap(chunkText: string, isLast: boolean, expected: number) {
  const actual = heroVoiceGapMsAfterChunk(chunkText, isLast);
  if (actual !== expected) {
    failures += 1;
    console.error(`FAIL: gap(${JSON.stringify(chunkText)}, last=${isLast}) = ${actual}, expected ${expected}`);
  }
}

// --- abbreviation expansion ---
expectSpeech("จนท.ดับเพลิงระดมรถน้ำ 10 คัน", ["เจ้าหน้าที่ดับเพลิง", "สิบ"], ["จนท.", "10"]);
expectSpeech("แจ้งจนท.ทันที", ["แจ้งเจ้าหน้าที่ทันที"], ["จนท."]);
expectSpeech("นำส่ง รพ.ใกล้เคียง", ["โรงพยาบาลใกล้เคียง"], ["รพ."]);
expectSpeech("ตร.คาดสาเหตุไฟฟ้าลัดวงจร", ["ตำรวจคาด"], ["ตร."]);
expectSpeech("พื้นที่ 50 ตร.ม. และ 2 ตร.กม.", ["ตารางเมตร", "ตารางกิโลเมตร"], ["ตร."]);
expectSpeech("เกิดเหตุใน กทม. และกรุงเทพฯ ชั้นใน", ["กรุงเทพมหานคร"], ["กทม.", "กรุงเทพฯ"]);
expectSpeech("วันที่ 27 ก.ค. 2569", ["กรกฎาคม"], ["ก.ค."]);
expectSpeech("ประชุม ครม. เมื่อวาน", ["คณะรัฐมนตรี"], ["ครม."]);
expectSpeech("น.ส.สมหญิง และ ด.ช.สมชาย", ["นางสาวสมหญิง", "เด็กชายสมชาย"], ["น.ส.", "ด.ช."]);
expectSpeech("นพ.สมคิด จาก รพ.ตำรวจ", ["นายแพทย์สมคิด", "โรงพยาบาลตำรวจ"], ["นพ."]);
expectSpeech("ใช้เวลา 3 ชม. โดยประมาณ", ["สาม", "ชั่วโมง"], ["ชม.", "3"]);
expectSpeech("น่าชื่นชม. ทุกฝ่ายช่วยกัน", ["ชื่นชม"], ["ชื่นชั่วโมง"]);
expectSpeech("แจ้งความที่ สน.ห้วยขวาง", ["สถานีตำรวจห้วยขวาง"], ["สน."]);
expectSpeech("ปชช.ในพื้นที่", ["ประชาชนในพื้นที่"], ["ปชช."]);

// --- guards: must NOT falsely expand ---
expectSpeech("ยาว 20 เมตร. จากปากซอย", ["เมตร"], ["เมตำรวจ"]);
expectSpeech("ความเร็ว 120 กม./ชม. บนทางด่วน", ["กิโลเมตรต่อชั่วโมง"], []);
expectSpeech("ส่ง ส.ค.ส. ให้ผู้ใหญ่", [], ["สิงหาคมส."]);
expectSpeech("ปี พ.ศ. 2569", ["พุทธศักราช"], []);

// --- script-level expansion (video pipeline pass) ---
function expectScript(input: string, expected: string) {
  const actual = expandThaiSpeechAbbreviations(input);
  if (actual !== expected) {
    failures += 1;
    console.error(`FAIL: expand("${input}") = "${actual}", expected "${expected}"`);
  }
}
expectScript(
  "จนท.ดับเพลิงระดมรถน้ำสิบคันสกัดเพลิงนานสามชม. ส่งรพ.ใกล้เคียง ตร.คาด ฝากเตือนปชช.",
  "เจ้าหน้าที่ดับเพลิงระดมรถน้ำสิบคันสกัดเพลิงนานสามชั่วโมง ส่งโรงพยาบาลใกล้เคียง ตำรวจคาด ฝากเตือนประชาชน",
);
expectScript("น่าชื่นชม. ทุกฝ่าย", "น่าชื่นชม. ทุกฝ่าย");
expectScript("หลายชม.ผ่านไป", "หลายชั่วโมงผ่านไป");
// idempotent — a requeued job re-running the pass must be a no-op
expectScript(
  expandThaiSpeechAbbreviations("จนท.ส่งรพ.ในกทม.เมื่อ 27 ก.ค."),
  expandThaiSpeechAbbreviations("จนท.ส่งรพ.ในกทม.เมื่อ 27 ก.ค."),
);

// --- sentence-gap heuristics ---
expectGap("ประโยคจบบรรทัด\n", false, 300);
expectGap("ด่วน! เพลิงไหม้อาคารพาณิชย์...", false, 300);
expectGap("จบด้วยเว้นวรรค ", false, 150);
expectGap("ตัดกลางประโยคพอดีคำ", false, 0);
expectGap("ท่อนสุดท้าย\n", true, 0);

// --- silence PCM shape (mono 16-bit) ---
const silence = heroVoiceSilencePcm(24000, 300);
if (silence.length !== 24000 * 0.3 * 2) {
  failures += 1;
  console.error(`FAIL: silence length ${silence.length}, expected ${24000 * 0.3 * 2}`);
}
if (silence.some((byte) => byte !== 0)) {
  failures += 1;
  console.error("FAIL: silence PCM must be zero-filled");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("verify-hero-voice-abbreviations: all checks passed");
