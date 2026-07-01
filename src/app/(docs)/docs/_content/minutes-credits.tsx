// ตัวเลขจาก src/lib/plan-limits.ts + src/lib/credits.ts (ณ 2026-07-01) — keep in sync with src/lib/plan-limits.ts / src/lib/credits.ts
import { Clock, Coins, Wallet } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "minutes-credits",
  title: "นาที & เครดิต",
  category: "แผน & การใช้งาน",
  order: 60,
  keywords: ["นาที", "เครดิต", "credit", "minute", "plan", "แผน", "pro", "business", "free", "pricing", "โควตา", "overflow"],
  summary: "โควตานาทีต่อแผน, เครดิตสำหรับ AI-gen และนาที overflow",
};

export default function MinutesCreditsDoc() {
  return (
    <div className="space-y-5">
      <Section title="แผน & โควตานาที" icon={<Clock className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>แต่ละแผนมีโควตานาทีเรนเดอร์และจำนวนคลิปต่อ 30 วัน ดังนี้</p>
        <ul className="space-y-1.5">
          <li><strong>FREE</strong> — 5 นาที / 2 คลิป ต่อ 30 วัน</li>
          <li><strong>PRO</strong> — 80 นาที / 100 คลิป ต่อ 30 วัน</li>
          <li><strong>BUSINESS</strong> — 150 นาที / 300 คลิป ต่อ 30 วัน</li>
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
          <strong>นาที overflow</strong> — เมื่อใช้โควตานาทีของแผนหมดแล้ว แต่ยังต้องการเรนเดอร์ต่อ ระบบจะหักเครดิตอัตโนมัติในอัตรา <strong>2 เครดิต/นาที</strong>
        </p>
        <p>
          <strong>AI image/video generation</strong> — คิดเครดิตต่อการกระทำ ประมาณ <strong>3–25 เครดิต</strong> ต่อครั้ง ขึ้นอยู่กับประเภทและความยาวของงานที่สร้าง (ไม่ใช่อัตราตายตัวเดียวสำหรับทุกงาน)
        </p>
        <p>
          การหักเครดิต ระบบจะหักจากเครดิต<strong>แจกฟรีรายเดือน (granted)</strong> ก่อนเสมอ แล้วจึงหักจากเครดิต<strong>ที่ซื้อเพิ่ม (purchased)</strong> เมื่อส่วนแจกฟรีหมด
        </p>
      </Section>

      <Callout kind="info">
        ดูยอดเครดิตคงเหลือและประวัติการใช้งานได้ที่ Settings → Billing
      </Callout>
    </div>
  );
}
