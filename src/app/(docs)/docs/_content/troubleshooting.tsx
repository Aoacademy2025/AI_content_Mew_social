import { LifeBuoy } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "troubleshooting",
  title: "แก้ปัญหา & FAQ",
  category: "แผน & การใช้งาน",
  order: 70,
  keywords: ["error", "ปัญหา", "แก้", "faq", "503", "b-roll", "key", "avatar fail", "troubleshoot"],
  summary: "error ที่พบบ่อยและวิธีแก้",
};

export default function TroubleshootingDoc() {
  return (
    <div className="space-y-5">
      <Section title="ปัญหาที่พบบ่อย" icon={<LifeBuoy className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Callout kind="warn">
          <strong>ขึ้น error 503 / high demand</strong> — Gemini โอเวอร์โหลดชั่วคราว รอ 5–10 นาทีแล้วลองใหม่ หรือสลับเสียงพากย์เป็น ElevenLabs ระหว่างรอ
        </Callout>

        <Callout kind="warn">
          <strong>B-roll หาคลิปไม่เจอ / ขึ้น error</strong> — เช็คว่าใส่ Pexels หรือ Pixabay key แล้ว (ใส่ทั้งสองตัวยิ่งหาคลิปได้หลากหลาย)
        </Callout>

        <Callout kind="info">
          <strong>ปิดแท็บระหว่างเรนเดอร์ งานหายไหม?</strong> — ไม่หาย เรนเดอร์ทำงานเบื้องหลัง เปิดหน้าเดิมกลับมาจะ resume ให้อัตโนมัติ (มีป้ายเตือนที่ Dashboard)
        </Callout>

        <Callout kind="warn">
          <strong>Avatar generate fail</strong> — เช็ค HeyGen key และ avatarId ให้ถูกต้อง
        </Callout>

        <Callout kind="warn">
          <strong>Key ไม่ถูกบันทึก</strong> — กด Save ที่หน้า Settings แล้วกด Test ให้ขึ้นเครื่องหมาย ✓ สีเขียว
        </Callout>

        <Callout kind="warn">
          <strong>(ระบบจัดการให้) ยังเห็นช่อง Gemini key</strong> — ระบบจัดการ Gemini ให้แล้ว ไม่ต้องใส่เอง ข้ามช่องนี้ได้
        </Callout>
      </Section>
    </div>
  );
}
