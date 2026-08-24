// ตัวเลขจาก src/lib/plan-limits.ts + src/lib/credits.ts (ณ 2026-08-15) — keep in sync with src/lib/plan-limits.ts / src/lib/credits.ts
import { Clock, Coins, Wallet } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "minutes-credits",
  title: "นาที & เครดิต",
  category: "แผน & การใช้งาน",
  order: 60,
  keywords: ["นาที", "เครดิต", "credit", "minute", "plan", "แผน", "pro", "business", "free", "pricing", "โควตา", "overflow"],
  summary: "โควตานาทีต่อแผน, เครดิตเติมนาที และขอบเขตฟีเจอร์ของแต่ละแพ็กเกจ",
};

export default function MinutesCreditsDoc() {
  return (
    <div className="space-y-5">
      <Section title="แผน & โควตานาที" icon={<Clock className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>แต่ละแผนมีโควตา<strong>นาทีเรนเดอร์</strong>ต่อ 30 วัน (จำนวนคลิปเป็นค่าประมาณที่ ~1 นาที/คลิป) ดังนี้</p>
        <ul className="space-y-1.5">
          <li><strong>FREE</strong> — 5 นาที (~5 คลิป) ต่อ 30 วัน</li>
          <li><strong>PRO</strong> — 80 นาที (~80 คลิป) ต่อ 30 วัน</li>
          <li><strong>BUSINESS</strong> — 150 นาที (~150 คลิป) ต่อ 30 วัน</li>
        </ul>
        <p>
          การนับนาที: ระบบปัดความยาวคลิปเข้าใกล้จำนวนเต็มที่สุด (ปัดขึ้นหรือลง) โดยนับ<strong>ขั้นต่ำ 1 นาที/คลิป</strong> เสมอ แม้คลิปจะสั้นกว่านั้น
        </p>
      </Section>

      <Section title="เครดิต" icon={<Coins className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p><strong>1 เครดิต = ฿1</strong></p>
        <p>
          ผู้ใช้แผนจ่ายเงินจะได้รับเครดิต<strong>แจกฟรีรายเดือน</strong> (ใช้แล้วหมดไป ไม่ทบยอดข้ามเดือน):
        </p>
        <ul className="space-y-1.5">
          <li><strong>FREE</strong> — 0 เครดิต/เดือน</li>
          <li><strong>PRO</strong> — 50 เครดิต/เดือน</li>
          <li><strong>BUSINESS</strong> — 150 เครดิต/เดือน</li>
        </ul>
        <p>ผู้ใช้ที่อยู่ในช่วง <strong>trial ไม่ได้รับเครดิตแจกฟรี</strong></p>
        <p>นอกจากนี้ยังซื้อเครดิตเพิ่มได้ (คงอยู่ถาวรจนกว่าจะใช้หมด ไม่หมดอายุ):</p>
        <ul className="space-y-1.5">
          <li>฿199 → 200 เครดิต</li>
          <li>฿499 → 540 เครดิต</li>
          <li>฿999 → 1,150 เครดิต</li>
        </ul>
      </Section>

      <Section title="เครดิตใช้กับอะไร" icon={<Wallet className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          <strong>นาที overflow</strong> — ระบบใช้นาทีที่เหลือในแพ็กเกจก่อน แล้วหักเฉพาะส่วนเกินอัตโนมัติในอัตรา <strong>2 เครดิต/นาที</strong>
        </p>
        <p>
          เครดิตเป็นหน่วยชำระค่าใช้งาน ไม่ใช่สิทธิ์ปลดล็อกฟีเจอร์ เช่น Hero AI Image, AutoMix, Avatar และเสียงพรีเมียมยังต้องมีแพ็กเกจที่รองรับก่อน แล้วจึงคิดเครดิตตามงานเมื่อมีค่าใช้จ่ายเพิ่มเติม
        </p>
        <p>
          การหักเครดิต ระบบจะใช้เครดิต<strong>รายเดือนหรือโปรโมชันที่ใกล้หมดอายุก่อน</strong> และใช้เครดิต<strong>ที่ซื้อเพิ่ม (purchased)</strong> เป็นลำดับสุดท้าย เครดิตโปรโมชันมีวันหมดอายุแยกและไม่ถูกล้างตอนรีเซ็ตรอบรายเดือน
        </p>
      </Section>

      <Callout kind="info">
        บัญชี FREE ใช้เครดิตเรนเดอร์คลิปต่อได้ โดยคลิปละไม่เกิน 2 นาที ใช้เสียง Gemini พื้นฐานได้ในงานนั้น และยังคงลายน้ำกับอายุไฟล์ 3 วัน เครดิตที่ซื้อไม่หมดอายุแม้เปลี่ยนแพ็กเกจ
      </Callout>

      <Callout kind="info">
        ดูยอดเครดิตคงเหลือและประวัติการใช้งานได้ที่ Settings → Billing
      </Callout>
    </div>
  );
}
