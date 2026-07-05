import { Captions, AudioLines, Palette } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "subtitles",
  title: "ซับไทย",
  category: "สร้างวิดีโอ",
  order: 40,
  keywords: ["subtitle", "ซับ", "caption", "viral", "ไวรัล", "timing", "คีย์เวิร์ด", "สตูดิโอ", "สไตล์", "สี", "ฟอนต์", "timeline"],
  summary: "สไตล์ซับ (ยาว/ไวรัล), สตูดิโอแต่งซับ และซับตรงเสียงอัตโนมัติ",
};

export default function SubtitlesDoc() {
  return (
    <div className="space-y-5">
      <Section title="สไตล์ซับ" icon={<Captions className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>เลือกสไตล์ซับได้ 2 แบบ ตามลักษณะวิดีโอที่ต้องการ</p>
        <p>
          <strong>ซับยาว</strong> — แสดงข้อความเต็มประโยคทีละท่อน อ่านง่าย เหมาะกับวิดีโอที่เน้นเนื้อหาให้ติดตามสบาย ๆ
        </p>
        <p>
          <strong>ซับไวรัล (คีย์เวิร์ด)</strong> — ตัดคำขึ้นทีละ 1–2 คำสำคัญ จังหวะกระชับ เหมาะกับคลิปสั้นสไตล์ TikTok/Reels ที่ต้องการดึงสายตาคนดู
        </p>
      </Section>

      <Section title="สตูดิโอแต่งซับ" icon={<Palette className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          หลังเรนเดอร์เสร็จ จะเข้าหน้าแต่งซับที่ปรับได้ละเอียด โดยเห็น<strong>ตัวอย่างสด ๆ</strong> ทันทีทุกครั้งที่แก้
        </p>
        <p>
          เลือกได้จาก<strong>สไตล์สำเร็จรูปหลายแบบ</strong> (เส้นขอบ/เงา/นีออน/กล่อง ฯลฯ) พร้อมปรับ <strong>เอฟเฟกต์การขึ้นคำ · ฟอนต์ · ขนาด · สี · ตำแหน่งบนจอ</strong> — ตั้งรวมทั้งคลิปหรือเจาะรายการ์ดก็ได้
        </p>
        <p>
          แก้ <strong>ข้อความ</strong> แต่ละการ์ดได้ตรง ๆ รวมถึง <strong>รวม/แยกการ์ด</strong> และกำหนดความยาวการ์ด (เช่น 1–2 ประโยค หรือทีละคำ)
        </p>
      </Section>

      <Section title="ซับตรงเสียง & ไทม์ไลน์" icon={<AudioLines className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          จังหวะขึ้น-ลงของซับคำนวณมาจากเสียงพากย์โดยตรง จึงตรงกับคำพูดแบบแม่นยำโดยอัตโนมัติ ไม่ต้องปรับเองทีละคำ
        </p>

        <Callout kind="tip">
          ถ้าอยากแก้จังหวะเอง ลากขอบซับบนไทม์ไลน์ได้ (มี Undo ด้วย Ctrl+Z) — เห็นทุกแทร็ก ทั้งซับ เสียง B-roll เพลง และพิธีกร
        </Callout>
      </Section>
    </div>
  );
}
