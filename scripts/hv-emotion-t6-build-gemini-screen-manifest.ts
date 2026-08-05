// T6 (hv-emotion) — build the T3 screening harness's manifest.json for the
// 6 Gemini baseline clips (T4 artifacts), so the answer key can carry a CER
// figure for arm C alongside the Hero arms (not required by the brief's
// Step 1, which only re-renders Hero; this is a cheap, offline, zero-RunPod-cost
// extra pass so "is Hero >= Gemini" in the report has a CER number to point at,
// not just the expressiveness proxy). Expected transcript = the exact raw
// display text T4 submitted to Gemini (confirmed via textSha256 match against
// gemini/metadata.json — Gemini's call path does NOT go through
// prepareHeroVoiceSpeech, unlike production Hero Voice).
import { writeFileSync } from "node:fs";
import path from "node:path";

const GEMINI_DIR = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "gemini");

const S1 = "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง";
const S2 = "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา";
const S3 = "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด";
const TEXT: Record<string, string> = { s1: S1, s2: S2, s3: S3 };

const manifest = [
  { file: "s1-female.wav", transcript: TEXT.s1, label: "s1-female", group: "gemini" },
  { file: "s1-male.wav", transcript: TEXT.s1, label: "s1-male", group: "gemini" },
  { file: "s2-female.wav", transcript: TEXT.s2, label: "s2-female", group: "gemini" },
  { file: "s2-male.wav", transcript: TEXT.s2, label: "s2-male", group: "gemini" },
  { file: "s3-female.wav", transcript: TEXT.s3, label: "s3-female", group: "gemini" },
  { file: "s3-male.wav", transcript: TEXT.s3, label: "s3-male", group: "gemini" },
];

writeFileSync(path.join(GEMINI_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ event: "gemini-screen-manifest-written", count: manifest.length, dir: GEMINI_DIR }));
