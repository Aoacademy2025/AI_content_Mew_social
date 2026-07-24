// T6 (hv-emotion) — one-off: compute prepareHeroVoiceSpeech() output for S1/S2/S3
// to verify S1 needs no normalization and to record the actual speechText
// submitted for S2/S3 (per task-6-brief.md Step 1). Read-only, no RunPod calls.
import { prepareHeroVoiceSpeech, HERO_VOICE_SPEECH_NORMALIZER_VERSION } from "../src/lib/hero-voice-speech";

const S1 = "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง";
const S2 = "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา";
const S3 = "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด";

const out: Record<string, unknown> = { normalizerVersion: HERO_VOICE_SPEECH_NORMALIZER_VERSION, scripts: {} };
for (const [name, text] of [["S1", S1], ["S2", S2], ["S3", S3]] as const) {
  const prep = prepareHeroVoiceSpeech(text);
  (out.scripts as Record<string, unknown>)[name] = {
    unchanged: prep.speechText === text,
    display: text,
    speech: prep.speechText,
    risks: prep.risks,
  };
}
console.log(JSON.stringify(out, null, 2));
