import { Rocket } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "getting-started",
  title: "เริ่มต้นใช้งาน",
  category: "เริ่มต้น",
  order: 10,
  keywords: ["เริ่ม", "แนะนำ", "ภาพรวม", "getting started", "start", "overview"],
  summary: "HERO ทำอะไรได้ + สมัครแล้วเริ่มสร้างวิดีโอแรกได้ทันทีใน 3 นาที (ไม่ต้องใส่ API Key)",
};

export default function GettingStartedDoc() {
  return (
    <div className="space-y-5">
      <Section title="HERO AI ทำอะไรได้" icon={<Rocket className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เปลี่ยน <strong>สคริปต์</strong> เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + B-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง + พิธีกร AI (avatar) ถ้าต้องการ</p>
        <p>ทำงานในเอดิเตอร์เดียวจบ: <strong>สคริปต์ → องค์ประกอบ → เรนเดอร์ → แต่งซับ → ส่งออก</strong></p>
      </Section>

      <Section title="เริ่มใน 3 นาที">
        <Callout kind="info">
          <strong>สมัครแล้วใช้งานได้ทันที ไม่ต้องใส่ API Key</strong> — ระบบเตรียมเสียงพากย์ AI และคลังภาพ/วิดีโอประกอบ (B-roll) ไว้ให้พร้อมแล้ว กดเริ่มสร้างคลิปแรกได้เลย
        </Callout>
        <Step num={1} title="เลือกสไตล์ & ใส่สคริปต์">เปิด Video Editor เลือกเทมเพลตสไตล์ที่ชอบ แล้วพิมพ์/วางสคริปต์ (หรือกดใช้การ์ดบทตัวอย่างจากหน้าแรกเพื่อเริ่มได้ทันที)</Step>
        <Step num={2} title="เลือกองค์ประกอบแล้วกดเรนเดอร์">เลือกเสียงพากย์ เพลงประกอบ และ B-roll (คลังสต็อก / ภาพ AI / Motion B-Roll) แล้วกดเรนเดอร์ (ปิดแท็บได้ งานทำต่อเบื้องหลัง)</Step>
        <Step num={3} title="แต่งซับ → ส่งออก">กลับมาเช็กตัวอย่าง ปรับข้อความหรือสไตล์ซับตามใจ แล้วกดส่งออกเพื่อดาวน์โหลดไฟล์จริง</Step>
        <Callout kind="info">รายละเอียดแต่ละขั้นดูได้ในหัวข้อ &quot;สร้างวิดีโอ&quot; — หากต้องการต่อเสียงโคลน ElevenLabs หรือพิธีกร AI HeyGen เพิ่ม ดูได้ที่ &quot;เชื่อมต่อบริการเสริม&quot;</Callout>
      </Section>
    </div>
  );
}
