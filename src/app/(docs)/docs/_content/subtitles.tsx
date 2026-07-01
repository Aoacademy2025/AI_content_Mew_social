import { Captions, AudioLines } from "lucide-react";
import type { DocMeta } from "./types";
import { Section, Callout } from "../_components/ui";

export const meta: DocMeta = {
  slug: "subtitles",
  title: "ซับไทย",
  category: "สร้างวิดีโอ",
  order: 40,
  keywords: ["subtitle", "ซับ", "caption", "viral", "ไวรัล", "timing", "คีย์เวิร์ด"],
  summary: "สองสไตล์ซับ (ยาว/ไวรัล) และซับตรงเสียงอัตโนมัติ",
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

      <Section title="ซับตรงเสียง" icon={<AudioLines className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          จังหวะขึ้น-ลงของซับคำนวณมาจากเสียงพากย์โดยตรง จึงตรงกับคำพูดแบบแม่นยำโดยอัตโนมัติ ไม่ต้องปรับเองทีละคำ
        </p>

        <Callout kind="tip">
          ปรับ ลาก แยก หรือลบซับแต่ละท่อนได้เองใน timeline ของ Video Editor หากต้องการแก้จังหวะให้ตรงใจยิ่งขึ้น
        </Callout>
      </Section>
    </div>
  );
}
