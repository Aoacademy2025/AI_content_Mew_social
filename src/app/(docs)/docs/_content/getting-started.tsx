import { Rocket } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "getting-started",
  title: "เริ่มต้นใช้งาน",
  category: "เริ่มต้น",
  order: 10,
  keywords: ["เริ่ม", "แนะนำ", "ภาพรวม", "getting started", "start", "overview"],
  summary: "HERO ทำอะไรได้ + เริ่มสร้างวิดีโอแรกใน 3 นาที",
};

export default function GettingStartedDoc() {
  return (
    <div className="space-y-5">
      <Section title="HERO AI ทำอะไรได้" icon={<Rocket className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เปลี่ยน <strong>สคริปต์</strong> เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + B-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง + พิธีกร AI (avatar) ถ้าต้องการ</p>
        <p>ทำงานในเอดิเตอร์เดียวจบ: <strong>สคริปต์ → องค์ประกอบ → เรนเดอร์ → แต่งซับ → ส่งออก</strong></p>
      </Section>

      <Section title="เริ่มใน 3 นาที">
        <Step num={1} title="ใส่คีย์ B-roll">ไปที่ Settings → API Keys ใส่ Pexels หรือ Pixabay อย่างน้อย 1 ตัว (Gemini ระบบจัดการให้แล้ว)</Step>
        <Step num={2} title="เขียนสคริปต์">เปิด Video Editor พิมพ์/วางสคริปต์ที่อยากทำเป็นวิดีโอ แล้วเลือกเสียง/เพลง/B-roll</Step>
        <Step num={3} title="เรนเดอร์แล้วแต่งซับ → ส่งออก">กดเรนเดอร์ (ปิดแท็บได้ งานทำต่อเบื้องหลัง) → กลับมาแต่งซับ → กดส่งออกเพื่อได้ไฟล์จริง</Step>
        <Callout kind="info">รายละเอียดแต่ละขั้นดูได้ในหัวข้อ "สร้างวิดีโอ" และ "ตั้งค่าคีย์"</Callout>
      </Section>
    </div>
  );
}
