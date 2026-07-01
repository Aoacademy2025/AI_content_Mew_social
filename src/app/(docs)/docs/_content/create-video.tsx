import { Film, Wand2, Workflow, Clapperboard, Lightbulb } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Step, PipelineRow, Callout, Tips, Tip } from "../_components/ui";

export const meta: DocMeta = {
  slug: "create-video",
  title: "สร้างวิดีโอ",
  category: "สร้างวิดีโอ",
  order: 30,
  keywords: ["video", "editor", "render", "pipeline", "burn", "สคริปต์", "สร้าง", "b-roll", "เสียง", "tts"],
  summary: "ขั้นตอนสร้างวิดีโอจากสคริปต์: pipeline, B-roll, เสียง, Render → Burn & Download",
};

export default function CreateVideoDoc() {
  return (
    <div className="space-y-5">
      <Section title="Video Editor คืออะไร" icon={<Film className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เครื่องมือหลักในการประกอบวิดีโอจากสคริปต์ ใช้เลย์เอาต์แนวตั้ง <strong>9:16</strong> พอดีกับ TikTok และ Reels</p>
      </Section>

      <Section title="ขั้นตอนสร้าง" icon={<Wand2 className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Step num={1} title="เขียนสคริปต์">พิมพ์หรือวางสคริปต์ที่จะใช้ทำวิดีโอใน Video Editor</Step>
        <Step num={2} title="ตั้งค่า pipeline">เลือกเสียงพากย์ avatar (ถ้าต้องการ) และค่าอื่น ๆ ของวิดีโอ</Step>
        <Step num={3} title="เลือกสไตล์ซับ">เลือกรูปแบบซับไทย เช่น แบบยาว หรือแบบคีย์เวิร์ดไวรัล</Step>
        <Step num={4} title="Render (พรีวิว)">ระบบประมวลผล pipeline ทั้งหมดแล้วสร้างตัวอย่างให้ดูก่อน</Step>
        <Step num={5} title="Burn & Download">เมื่อพอใจตัวอย่างแล้ว กดปุ่มนี้เพื่อเบิร์นซับลงไฟล์จริงแล้วดาวน์โหลด</Step>

        <Callout kind="info">
          <strong>Render</strong> = ดูตัวอย่างเท่านั้น (ยังไม่ได้ไฟล์จริง) · <strong>Burn & Download</strong> = ขั้นตอนสุดท้ายที่ได้ไฟล์วิดีโอจริง
        </Callout>
      </Section>

      <Section title="Pipeline 6 ขั้น" icon={<Workflow className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <PipelineRow num={1} name="TTS Voice" desc="แปลงสคริปต์เป็นเสียงพากย์" />
        <PipelineRow num={2} name="Transcribe" desc="ถอดเสียงเป็นข้อความพร้อมจังหวะ (ใช้กับเสียง avatar/ที่อัปโหลดเอง)" />
        <PipelineRow num={3} name="Keywords" desc="วิเคราะห์คำสำคัญจากเนื้อหาแต่ละช่วง" />
        <PipelineRow num={4} name="B-roll" desc="ดึงคลิปที่ตรงกับคำสำคัญมาประกอบ" />
        <PipelineRow num={5} name="Config" desc="รวมค่าที่ตั้งไว้ทั้งหมดเป็นคำสั่งเรนเดอร์" />
        <PipelineRow num={6} name="Render" desc="ประกอบวิดีโอตัวอย่างให้ดูก่อน Burn & Download" />
      </Section>

      <Section title="B-roll & เสียง" icon={<Clapperboard className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>B-roll จะเปลี่ยนคลิปทุก <strong>3–5 วินาที</strong> โดยจับคู่กับเนื้อหาสคริปต์อัตโนมัติ</p>
        <p>เลือกเสียงพากย์ได้ 2 แบบ: <strong>Gemini</strong> (ค่าเริ่มต้น) หรือ <strong>ElevenLabs</strong> (ต้องมี voiceId ของเสียงที่เลือก)</p>
      </Section>

      <Section title="เคล็ดลับ" icon={<Lightbulb className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Tips>
          <Tip>Render ทุกครั้งก่อน เพื่อเช็คซับ เสียง และ B-roll ให้ครบ ก่อนค่อยกด Burn & Download</Tip>
          <Tip>จะใช้ ElevenLabs ต้องมี voiceId ของเสียงที่เลือกก่อน ไม่งั้นระบบจะใช้ Gemini เป็นค่าเริ่มต้น</Tip>
          <Tip>B-roll เปลี่ยนคลิปให้ตรงเนื้อหาอัตโนมัติทุก 3–5 วิ ไม่ต้องเลือกเอง</Tip>
        </Tips>
      </Section>
    </div>
  );
}
