import { Film, Wand2, Layers, Upload, Lightbulb } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, Callout, Tips, Tip } from "../_components/ui";

export const meta: DocMeta = {
  slug: "create-video",
  title: "สร้างวิดีโอ",
  category: "สร้างวิดีโอ",
  order: 30,
  keywords: ["video", "editor", "render", "เรนเดอร์เบื้องหลัง", "background", "burn", "ส่งออก", "สคริปต์", "สร้าง", "b-roll", "เสียง", "tts", "แต่งซับ", "timeline", "อัปคลิป", "cutaway"],
  summary: "เอดิเตอร์โฉมใหม่: สคริปต์ → องค์ประกอบ → เรนเดอร์เบื้องหลัง → แต่งซับ → ส่งออกวิดีโอ",
};

export default function CreateVideoDoc() {
  return (
    <div className="space-y-5">
      <Section title="Video Editor คืออะไร" icon={<Film className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เครื่องมือหลักในการประกอบวิดีโอจากสคริปต์ ใช้เลย์เอาต์แนวตั้ง <strong>9:16</strong> พอดีกับ TikTok และ Reels — โฉมใหม่รวมทุกขั้นตอนจบในหน้าเดียว ตั้งแต่เขียนสคริปต์ถึงส่งออกไฟล์จริง</p>
      </Section>

      <Section title="ขั้นตอนสร้าง" icon={<Wand2 className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Step num={1} title="สคริปต์">
          พิมพ์หรือวางสคริปต์ที่จะทำเป็นวิดีโอ — <strong>1 บรรทัด = 1 ท่อน</strong> ลากสลับลำดับท่อนได้ ระบบนับคำ/ท่อน/ความยาวคลิปโดยประมาณให้
        </Step>
        <Step num={2} title="องค์ประกอบ">
          เลือก <strong>เสียงพากย์</strong> (ฟังตัวอย่างได้), <strong>เพลงประกอบ</strong>, <strong>พิธีกร AI</strong> (ถ้าต้องการ) และแหล่ง <strong>B-roll</strong> — ปรับละเอียดเพิ่มได้ที่ "ตั้งค่าขั้นสูง"
        </Step>
        <Step num={3} title="เรนเดอร์ (เบื้องหลัง)">
          กดเรนเดอร์แล้ว <strong>ปิดแท็บไปทำอย่างอื่นได้เลย</strong> งานทำต่อเบื้องหลัง กลับมาเปิดใหม่งานเสร็จรออยู่ (มีป้ายเตือนที่หน้า Dashboard)
        </Step>
        <Step num={4} title="แต่งซับ">
          สตูดิโอแต่งซับ — แก้ข้อความรายการ์ด เลือกสไตล์ ปรับสี/ฟอนต์/ขนาด/ตำแหน่ง และลากจังหวะบนไทม์ไลน์ โดยเห็นตัวอย่างสด ๆ ทันที
        </Step>
        <Step num={5} title="ส่งออกวิดีโอ">
          เมื่อพอใจแล้วกดส่งออก เพื่อเบิร์นซับลงไฟล์จริง แล้วดาวน์โหลด (ไฟล์เข้า Gallery ให้ด้วย)
        </Step>

        <Callout kind="info">
          <strong>เรนเดอร์เบื้องหลัง</strong> = ประมวลผลเสียง/B-roll/พิธีกร แล้วได้ตัวอย่างพร้อมแต่งซับ (ปิดแท็บได้) · <strong>ส่งออกวิดีโอ</strong> = ขั้นสุดท้ายที่ได้ไฟล์จริง
        </Callout>
      </Section>

      <Section title="2 โหมดเริ่มต้น" icon={<Upload className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Step num={1} title="จากสคริปต์ (ค่าเริ่มต้น)">
          พิมพ์สคริปต์ → ระบบสร้างเสียงพากย์ + หา B-roll + ซับไทยให้อัตโนมัติ
        </Step>
        <Step num={2} title="อัปคลิปตัวเอง">
          มีคลิปแนวตั้งของตัวเองอยู่แล้ว → อัปโหลดเข้ามา ระบบถอดเสียงทำ <strong>ซับไทยตรงเสียง</strong> + แทรก <strong>B-roll สลับ</strong> ให้ โดยเสียงต้นฉบับต่อเนื่อง
        </Step>
      </Section>

      <Section title="B-roll & เสียง" icon={<Layers className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>B-roll เปลี่ยนคลิปทุก <strong>3–5 วินาที</strong> จับคู่กับเนื้อหาแต่ละช่วงอัตโนมัติ ดึงจากคลังสต็อกฟรี (Pexels / Pixabay)</p>
        <p>เลือกเสียงพากย์ได้ 2 แบบ: <strong>Gemini</strong> (ค่าเริ่มต้น ระบบจัดการให้) หรือ <strong>ElevenLabs</strong> (ต้องมี voiceId ของเสียงที่เลือก)</p>
      </Section>

      <Section title="เคล็ดลับ" icon={<Lightbulb className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Tips>
          <Tip>เรนเดอร์เบื้องหลังแล้วปิดแท็บได้ — งานไม่หาย กลับมาแต่งซับต่อได้ทีหลัง</Tip>
          <Tip>แต่งซับให้ครบ (ข้อความ/สไตล์/จังหวะ) ก่อนค่อยกดส่งออกวิดีโอ เพราะไฟล์จริงจะเบิร์นตามที่แต่งไว้เป๊ะ</Tip>
          <Tip>จะใช้ ElevenLabs ต้องมี voiceId ของเสียงที่เลือกก่อน ไม่งั้นระบบใช้ Gemini เป็นค่าเริ่มต้น</Tip>
        </Tips>
      </Section>
    </div>
  );
}
