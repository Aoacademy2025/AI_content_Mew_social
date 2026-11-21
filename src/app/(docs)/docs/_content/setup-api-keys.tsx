import { KeyRound } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, ApiRow, Callout, KeyLink } from "../_components/ui";
import { SetupApiKeysGeminiNote } from "./setup-api-keys-gemini-note";

export const meta: DocMeta = {
  slug: "setup-api-keys",
  title: "เชื่อมต่อบริการเสริม (ไม่จำเป็นต้องใส่)",
  category: "แผน & การใช้งาน",
  order: 65,
  keywords: ["key", "api key", "pexels", "pixabay", "elevenlabs", "heygen", "gemini", "settings", "คีย์", "ตั้งค่า", "บริการเสริม"],
  summary: "สมัครแล้วทำคลิปได้ทันทีโดยไม่ต้องใส่คีย์ — หน้านี้สำหรับผู้ที่อยากต่อ ElevenLabs, HeyGen หรือคลังสต็อกส่วนตัวเพิ่ม",
};

export default function SetupApiKeysDoc() {
  return (
    <div className="space-y-5">
      <Callout kind="info">
        <strong>ไม่ต้องใส่ API Key ก็ใช้งานได้ครบทันที</strong> — สมัครแล้วเริ่มสร้างวิดีโอได้เลย ระบบจัดการ AI, เสียงพากย์, ซับไทย และคลังวิดีโอ/ภาพประกอบ B-roll (Pexels / Pixabay) ไว้ให้ครบแล้ว
      </Callout>

      <Section
        title="บริการเสริม (เลือกใส่เฉพาะที่อยากใช้เพิ่ม)"
        icon={<KeyRound className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}
      >
        <p>คีย์ด้านล่างเป็น<strong>ตัวเลือกเสริมทั้งหมด</strong> ไม่จำเป็นต้องใส่เพื่อเริ่มทำคลิป ใส่เฉพาะเมื่ออยากใช้ฟีเจอร์เพิ่มเติมจากบัญชีภายนอกของคุณเอง</p>

        <ApiRow
          name="ElevenLabs (ตัวเลือกเสริม)"
          desc="โคลนเสียง / เสียงพากย์พรีเมียม — ไม่ใส่ = ใช้เสียง AI ของระบบได้ทันที"
          link="https://elevenlabs.io"
        />
        <ApiRow
          name="HeyGen (ตัวเลือกเสริม)"
          desc="สร้างพิธีกร AI (Avatar) — ไม่ใส่ = ได้วิดีโอเสียงพากย์ + B-roll ปกติ"
          link="https://app.heygen.com"
        />
        <ApiRow
          name="Pexels ส่วนตัว (ไม่จำเป็น)"
          desc="ระบบมีคลังสต็อกกลางให้ใช้อยู่แล้ว — ใส่เฉพาะกรณีอยากผูกโควตา Pexels ส่วนตัวเพิ่ม"
          link="https://www.pexels.com/api/"
        />
        <ApiRow
          name="Pixabay ส่วนตัว (ไม่จำเป็น)"
          desc="ระบบมีคลังสต็อกกลางให้ใช้อยู่แล้ว — ใส่เฉพาะกรณีอยากผูกโควตา Pixabay ส่วนตัวเพิ่ม"
          link="https://pixabay.com/api/docs/"
        />
      </Section>

      <Section title="วิธีใส่และเทสคีย์">
        <Step num={1} title="เปิดหน้า Settings">
          <p><KeyLink /></p>
        </Step>
        <Step num={2} title="วางคีย์แล้วกด Test">ระบบจะตรวจให้ทันที ถ้าถูกต้องจะขึ้นเครื่องหมาย ✓ สีเขียว</Step>
        <Step num={3} title="กด Save">คีย์จะถูกบันทึกไว้ใช้กับวิดีโอถัดไปทันที</Step>
      </Section>

      <Callout kind="warn">
        <strong>ห้ามวางคีย์ในแชท</strong> — วางที่หน้า Settings เท่านั้น เพื่อความปลอดภัยของคีย์
      </Callout>

      <SetupApiKeysGeminiNote />
    </div>
  );
}
