import { KeyRound } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, ApiRow, Callout, KeyLink } from "../_components/ui";
import { SetupApiKeysGeminiNote } from "./setup-api-keys-gemini-note";

export const meta: DocMeta = {
  slug: "setup-api-keys",
  title: "ตั้งค่าคีย์ API",
  category: "เริ่มต้น",
  order: 20,
  keywords: ["key", "api key", "pexels", "pixabay", "elevenlabs", "heygen", "gemini", "settings", "คีย์", "ตั้งค่า"],
  summary: "ระบบจัดการ Gemini ให้แล้ว — ใส่แค่ Pexels/Pixabay + optional ElevenLabs/HeyGen",
};

export default function SetupApiKeysDoc() {
  return (
    <div className="space-y-5">
      <Callout kind="info">
        <strong>ระบบจัดการ Gemini ให้แล้ว</strong> — ไม่ต้องใส่ Gemini key เอง ใช้งานฟีเจอร์หลัก (สคริปต์, ซับไทย, เสียง Gemini) ได้ทันทีโดยไม่ต้องหา key เพิ่ม
      </Callout>

      <Section
        title="คีย์ที่ต้องใส่เอง"
        icon={<KeyRound className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}
      >
        <p>คีย์ต่อไปนี้ยังต้องไปขอเองแล้วนำมาวางที่หน้า Settings — ใช้สำหรับฟีเจอร์ที่ระบบไม่ได้จัดการให้</p>

        <Callout kind="warn">
          <strong>จำเป็น:</strong> ต้องมี Pexels หรือ Pixabay อย่างน้อย 1 ตัว (สำหรับ B-roll)
        </Callout>
        <ApiRow
          name="Pexels"
          desc="ดึงคลิป B-roll สต็อกมาประกอบวิดีโอ"
          link="https://www.pexels.com/api/"
        />
        <ApiRow
          name="Pixabay"
          desc="ดึงคลิป B-roll สต็อกมาประกอบวิดีโอ"
          link="https://pixabay.com/api/docs/"
        />
        <Callout kind="tip">ใส่ Pexels <strong>หรือ</strong> Pixabay อย่างน้อย 1 ตัวก็พอ ไม่จำเป็นต้องใส่ทั้งคู่</Callout>

        <ApiRow
          name="ElevenLabs"
          desc="โคลนเสียง/เสียงพรีเมียม — ไม่ใส่ = ใช้เสียง Gemini แทน"
          link="https://elevenlabs.io"
        />
        <ApiRow
          name="HeyGen"
          desc="สร้างพิธีกร AI (avatar) — ไม่ใส่ = ได้วิดีโอเสียง + B-roll ปกติ"
          link="https://app.heygen.com"
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
