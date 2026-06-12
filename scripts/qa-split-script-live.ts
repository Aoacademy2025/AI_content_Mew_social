// LIVE QA for PR-E's split-script: does gemini-2.5-flash return Thai pieces
// VERBATIM often enough for viral cards to actually apply? Mirrors the
// route's prompt + validation exactly. Spends a few text-gen calls.
// Run: npx tsx scripts/qa-split-script-live.ts

import fs from "fs";
import { geminiGenerateText } from "../src/lib/gemini";
import { mapCardTextsToRanges, type CardPiece } from "../src/lib/tts-timing";

const KEY_FILE = process.env.QA_KEY_FILE ?? "/tmp/qa-gemini-key";
const API_KEY = fs.readFileSync(KEY_FILE, "utf-8").trim();

// ---- prompt mirrored from src/app/api/videos/split-script/route.ts ----
function buildPrompt(text: string, cardCap: number): string {
  return `คุณคือผู้ตัดซับไตเติ้ลภาษาไทยสำหรับ TikTok/Reels มืออาชีพ

แบ่ง SCRIPT ข้างล่างเป็นซับการ์ดสั้น ๆ — งานนี้คือ "เลือกจุดตัดข้อความ" เท่านั้น (เวลามีระบบอื่นจัดการแล้ว)

━━━ กฎเหล็ก — ห้ามแก้ข้อความ ━━━
ทุกการ์ดต้องเป็นข้อความจาก SCRIPT แบบคำต่อคำ ตามลำดับเดิม ครบทุกตัวอักษร
ห้ามแก้คำ ห้ามสะกดใหม่ ห้ามเพิ่ม ห้ามตัดทิ้ง ห้ามสลับลำดับ ห้ามสรุป
ตัวเลข ลำดับ และคำขึ้นต้น (เช่น "ข้อที่1", "ตอนที่2") ก็เป็นส่วนของ SCRIPT — ต้องอยู่ในการ์ดด้วย ห้ามข้าม
(เว้นวรรค/ขึ้นบรรทัดใหม่ปรับได้)

━━━ กฎ 1 — ตัดที่จุดหายใจ ไม่ตัดกลางวลี ━━━
ตัดหลังจุลภาค จุด หรือจุดจบวลีตามธรรมชาติ
ห้ามตัดกลางประโยคที่ความหมายยังค้างอยู่
✗ ผิด: "มึงเคยคิดปะ ว่า" | "ความรู้ที่เรียนมา"
✓ ถูก: "มึงเคยคิดปะ..." | "ว่าความรู้ที่เรียนมา"

━━━ กฎ 2 — 1 ซับ = 1 ความคิด ━━━
ถ้าประโยคมี 2 ไอเดีย ให้แยกเป็น 2 การ์ด แม้จะสั้น

━━━ กฎ 3 — ซับช็อก ให้สั้นพิเศษ ━━━
twist / punchline / คำเด็ด → 3-8 คำ การ์ดเดี่ยว

━━━ กฎ 4 — ความยาวการ์ด ━━━
การ์ดละไม่เกิน ${cardCap} ตัวอักษร (ประมาณ ≤5 วินาทีพูด)

━━━ tags ━━━
"hook"=การ์ดแรก (ดึงดูด), "cta"=ชวนติดตาม/ไลค์/แชร์ (ไม่เกิน 2 การ์ด), "body"=ที่เหลือ

━━━ SCRIPT ━━━
${text}

━━━ OUTPUT — JSON เท่านั้น ไม่มี markdown ━━━
{"cards":[{"text":"...","tag":"hook"},{"text":"...","tag":"body"},...]}`;
}

const SCRIPTS: Record<string, string> = {
  "casual (มึง/ปะ)": [
    "มึงเคยคิดปะ ว่าทำไมบางคนทำงานหนักทั้งชีวิตแต่ไม่รวยซักที",
    "เพราะเขาขายเวลาแลกเงินไง พอหยุดทำงานเงินก็หยุดเข้า",
    "คนรวยเขาไม่ทำแบบนั้น เขาสร้างระบบที่ทำเงินแทนตัวเอง",
    "แม่งพลิกเกมทั้งกระดาน",
    "อยากรู้วิธีเริ่ม กดติดตามไว้เลย",
  ].join("\n"),
  "formal การเงิน": [
    "การวางแผนการเงินที่ดีเริ่มต้นจากการรู้รายรับรายจ่ายของตัวเอง",
    "ขั้นแรกให้จดบันทึกทุกบาทที่ใช้เป็นเวลาหนึ่งเดือนเต็ม",
    "จากนั้นแบ่งเงินออมขั้นต่ำร้อยละสิบของรายได้ทันทีที่เงินเดือนออก",
    "เมื่อทำต่อเนื่องหกเดือน คุณจะมีเงินสำรองฉุกเฉินก้อนแรกในชีวิต",
  ].join("\n"),
  "mixed Thai-English-ตัวเลข": [
    "ปี 2026 แล้ว ถ้ายังไม่ใช้ AI ช่วยทำงาน คุณกำลังเสียเปรียบคนอื่น 10 เท่า",
    "เครื่องมืออย่าง ChatGPT กับ Gemini ทำให้งาน 3 ชั่วโมงเหลือ 15 นาที",
    "แต่ 90% ของคนใช้แค่ถามตอบ ทั้งที่มันทำได้มากกว่านั้นเยอะ",
    "ลองให้มันช่วยวางแผนคอนเทนต์ทั้งเดือนดู แล้วคุณจะไม่กลับไปทำแบบเดิม",
  ].join("\n"),
  "ยาว ~1.4k": Array.from({ length: 9 }, (_, i) =>
    `ข้อที่${i + 1} เคล็ดลับการออมเงินที่ใช้ได้จริงคือการตั้งระบบโอนอัตโนมัติทันทีที่เงินเดือนเข้าบัญชี โดยไม่ต้องรอให้เหลือแล้วค่อยเก็บ`
  ).join("\n"),
};

async function main() {
  let passes = 0;
  let total = 0;
  for (const [label, script] of Object.entries(SCRIPTS)) {
    total++;
    const t0 = Date.now();
    try {
      const raw = await geminiGenerateText(API_KEY, buildPrompt(script, 28), 8192, 0);
      const jsonText = raw.replace(/```(?:json)?/g, "").trim();
      const match = jsonText.match(/\{[\s\S]*\}/);
      const pieces = match ? (JSON.parse(match[0]) as { cards?: CardPiece[] }).cards ?? null : null;
      if (!pieces) {
        console.log(`✗ ${label}: unparseable output (${raw.length} chars)`);
        continue;
      }
      const cards = mapCardTextsToRanges(script, pieces);
      if (!cards) {
        // find the first offending piece for the report
        let pos = 0;
        let offender = "?";
        outer:
        for (const p of pieces) {
          for (const ch of Array.from(p.text).filter((c) => !/\s/.test(c))) {
            while (pos < script.length && /\s/.test(script[pos])) pos++;
            if (script[pos] !== ch) { offender = `"${p.text.slice(0, 40)}" (expected "${script[pos]}" got "${ch}")`; break outer; }
            pos++;
          }
        }
        console.log(`✗ ${label}: VERBATIM FAIL → sentence fallback would apply. offender: ${offender}`);
        continue;
      }
      passes++;
      const tags = cards.map((c) => c.tag ?? "-");
      const sample = cards.slice(0, 4).map((c) => `"${script.slice(c.startChar, c.endChar).replace(/\n/g, " ")}"`).join(" | ");
      console.log(`✓ ${label}: ${cards.length} viral cards in ${((Date.now() - t0) / 1000).toFixed(1)}s, hook=${tags[0]} cta=${tags.filter((t) => t === "cta").length}`);
      console.log(`    ${sample}${cards.length > 4 ? " | ..." : ""}`);
    } catch (e) {
      console.log(`✗ ${label}: call failed — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
  console.log(`\nverbatim success: ${passes}/${total}`);
  process.exit(passes === total ? 0 : passes > 0 ? 0 : 1);
}

main();
