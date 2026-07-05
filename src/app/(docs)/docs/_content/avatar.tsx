import { UserRound, Video, Move } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "avatar",
  title: "พิธีกร AI (Avatar)",
  category: "สร้างวิดีโอ",
  order: 50,
  keywords: ["avatar", "heygen", "พิธีกร", "bookend", "full", "green screen", "direct url"],
  summary: "โหมด full/bookend, HeyGen vs Direct URL, framing และค่าใช้จ่าย",
};

export default function AvatarDoc() {
  return (
    <div className="space-y-5">
      <Section title="โหมด avatar" icon={<UserRound className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เลือกได้ว่าจะให้พิธีกร AI ปรากฏในคลิปช่วงไหนบ้าง</p>
        <Step num={1} title="Full — ทั้งคลิป">
          avatar พูดอยู่ตลอดทั้งวิดีโอ เหมือนพิธีกรพากย์เองทั้งคลิป แต่ <strong>ค่าใช้จ่ายสูงสุด</strong> เพราะคิดตามความยาววิดีโอทั้งหมด
        </Step>
        <Step num={2} title="Bookend — เปิดอย่างเดียว">
          avatar ปรากฏเฉพาะช่วง <strong>หัวคลิป</strong> ส่วนที่เหลือเป็นเสียงพากย์ + B-roll ตามปกติ ประหยัดกว่า full มาก
        </Step>
        <Step num={3} title="Bookend-both — เปิดและปิด">
          avatar ปรากฏทั้งช่วง <strong>หัว</strong> (เกริ่นนำ) และ <strong>ท้าย</strong> (สรุปปิดท้าย) ตรงกลางเป็นเสียง + B-roll เหมือน bookend
        </Step>
      </Section>

      <Section title="2 วิธีสร้าง avatar" icon={<Video className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Step num={1} title="Generate ผ่าน HeyGen">
          ให้ระบบสร้างวิดีโอ avatar ให้อัตโนมัติผ่าน HeyGen — ต้องมี <strong>HeyGen key</strong> และเลือก <strong>avatarId</strong> (ตัวละครที่จะใช้) ไว้ก่อนที่หน้า Settings → API Keys
        </Step>
        <Step num={2} title="Direct URL — อัปโหลด/ลิงก์เอง">
          ใช้วิดีโอ avatar ที่มีอยู่แล้ว โดยอัปโหลดไฟล์หรือวางลิงก์วิดีโอเอง เลือกได้ว่าเป็น <strong>green screen</strong> (ระบบตัดพื้นหลังสีเขียวให้อัตโนมัติ) หรือ <strong>full video</strong> (วางซ้อนเต็มคลิปโดยไม่ตัดพื้นหลัง)
        </Step>
      </Section>

      <Callout kind="warn">
        <strong>HeyGen คิดเงินตามจำนวนวินาที</strong> ของวิดีโอ avatar ที่สร้าง — ยิ่งยาวยิ่งแพง แนะนำใช้ <strong>bookend</strong> หรือ <strong>bookend-both</strong> แทน full เพื่อประหยัดโควตา HeyGen
      </Callout>

      <Section title="Framing & Re-render" icon={<Move className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>ปรับตำแหน่งและขนาดของ avatar บนหน้าจอเองได้ ก่อนเรนเดอร์จริง</p>
        <p>
          โหมด bookend / bookend-both ต้องระบุความยาวช่วงเปิด/ปิด (<strong>intro/tail</strong>) เป็นวินาที ค่าเริ่มต้นคือ <strong>5 วินาที</strong>
        </p>
        <Callout kind="tip">
          ปรับตำแหน่ง/ขนาดแล้ว re-render ใหม่ได้เรื่อย ๆ โดย<strong>ไม่เปลืองโควตา HeyGen</strong> — เป็นการจัดวางคลิป avatar ที่ gen ไว้แล้วใหม่ ไม่ต้อง gen ใหม่
        </Callout>
      </Section>
    </div>
  );
}
