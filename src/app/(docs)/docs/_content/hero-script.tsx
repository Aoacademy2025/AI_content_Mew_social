import Link from "next/link";
import { BadgeCheck, CircleHelp, Lightbulb, NotebookPen, Send, Sparkles } from "lucide-react";
import type { DocMeta } from "./types";
import { Callout, Section, Step, Tip, Tips } from "../_components/ui";

export const meta: DocMeta = {
  slug: "hero-script",
  title: "เขียนสคริปต์ด้วย Hero Script",
  category: "เขียนคอนเทนต์",
  order: 25,
  keywords: [
    "hero script", "สคริปต์", "hook", "หัวข้อ", "ไอเดีย", "brand profile",
    "cta", "เขียนใหม่", "ส่งไปตัดต่อ", "subscription", "ชำระเงิน",
  ],
  summary: "ตั้งค่าแบรนด์ คิดหัวข้อ เลือก Hook เขียนสคริปต์ และส่งเข้า Video Editor ทีละขั้น",
};

export default function HeroScriptDoc() {
  return (
    <div className="space-y-5">
      <Section title="Hero Script ช่วยอะไร" icon={<NotebookPen className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          Hero Script เป็นพื้นที่เขียนก่อนตัดต่อ ช่วยเปลี่ยนไอเดียให้เป็นสคริปต์วิดีโอสั้นภาษาไทย
          ที่มี <strong>Hook เนื้อหา และ CTA</strong> ชัดเจน จากนั้นส่งเข้า Video Editor ได้โดยไม่ต้องคัดลอกข้อความใหม่
        </p>
        <Callout kind="info">
          ใช้ครั้งแรกให้เริ่มด้วยคลิป <strong>30 หรือ 60 วินาที</strong> และหัวข้อเดียวที่ชัดเจน จะตรวจคุณภาพและแก้สำนวนได้ง่ายที่สุด
        </Callout>
      </Section>

      <Section title="สร้างสคริปต์แรก" icon={<Sparkles className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Step num={1} title="ตั้งค่าแบรนด์และความยาว">
          เลือก Brand Profile ถ้าต้องการให้ AI ยึดนิช กลุ่มเป้าหมาย โทน คำที่ห้ามใช้ และรูปแบบ CTA
          หรือเลือก “ไม่ใช้โปรไฟล์” เพื่อเริ่มแบบทั่วไป จากนั้นเลือก 30, 60 หรือ 90 วินาที
        </Step>
        <Step num={2} title="ระบุหัวข้อ">
          พิมพ์หัวข้อเอง หรือกด “คิดไอเดียให้หน่อย” แล้วเลือกหนึ่งไอเดียที่ตรงกับคลิปนี้
        </Step>
        <Step num={3} title="สร้างและเลือก Hook">
          กด “สร้าง Hook” เลือกประโยคเปิดหนึ่งแบบ แล้วแก้ถ้อยคำในช่องได้ก่อนสร้างสคริปต์เต็ม
        </Step>
        <Step num={4} title="สร้าง ตรวจ และปรับสคริปต์">
          กด “สร้างสคริปต์เต็ม” อ่านทั้ง Hook เนื้อหา และ CTA แก้ข้อความได้โดยตรง หรือกด “เขียนใหม่” เฉพาะส่วนที่ยังไม่ใช่
          ระบบบันทึกร่างให้อัตโนมัติ
        </Step>
        <Step num={5} title="ส่งเข้า Video Editor">
          เมื่อสถานะขึ้นว่า “บันทึกแล้ว” กด “ส่งไปตัดต่อ” ระบบจะสร้างโปรเจกต์พร้อมสคริปต์และเปิด Video Editor ให้ทันที
        </Step>
      </Section>

      <Section title="สูตรที่ทำให้ผลลัพธ์ดีขึ้น" icon={<Lightbulb className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Tips>
          <Tip>หัวข้อหนึ่งสคริปต์ควรตอบคำถามหรือแก้ปัญหาเพียงเรื่องเดียว เช่น “3 วิธีลดค่าโฆษณาที่ไม่สร้างยอดขาย”</Tip>
          <Tip>ใส่กลุ่มเป้าหมายและโทนใน Brand Profile ให้เฉพาะเจาะจงกว่าคำว่า “คนทั่วไป” หรือ “เป็นกันเอง”</Tip>
          <Tip>ตรวจคำกล่าวอ้าง ตัวเลข ราคา และข้อมูลเฉพาะทางทุกครั้งก่อนนำไปเผยแพร่</Tip>
          <Tip>ถ้าสคริปต์ยาวหรือสั้นเกินงบคำ ให้ลดประเด็นก่อนเปลี่ยนเป็นความยาวที่มากขึ้น</Tip>
          <Tip>แก้ Hook ให้เป็นภาษาของแบรนด์ก่อนส่งตัดต่อ เพราะประโยคแรกมีผลต่อการหยุดดูมากที่สุด</Tip>
        </Tips>
      </Section>

      <Section title="สิทธิ์ใช้งานและการชำระเงิน" icon={<BadgeCheck className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <p>
          สมาชิกแบบชำระเงินที่แพ็กเกจยังใช้งานอยู่จะได้รับสิทธิ์ Hero Script เต็มรูปแบบ
          ส่วนบัญชีที่กำลังทยอยเปิดใช้งานจะเห็นหน้า Preview และรายละเอียดแพ็กเกจก่อน
        </p>
        <Callout kind="warn">
          หากชำระเงินสำเร็จแล้วแต่ยังเห็น Preview ให้รีเฟรชหนึ่งครั้งหรือออกแล้วเข้าใหม่
          ถ้ายังไม่เปิดภายใน 5 นาที ให้ส่ง ticket พร้อมอีเมลบัญชีและเวลาที่ชำระ โดยไม่ต้องส่งเลขบัตรหรือข้อมูลลับ
        </Callout>
      </Section>

      <Section title="เมื่อสร้างไม่ได้ ให้เช็กอะไร" icon={<CircleHelp className="h-4 w-4 text-violet-300" strokeWidth={2.25} />}>
        <Tips>
          <Tip>ปุ่มสร้างสคริปต์ยังเป็นสีจาง: หัวข้อหรือ Hook อาจยังไม่ครบ หรือมีการเปลี่ยนโปรไฟล์/ความยาวหลังเลือก Hook ให้สร้าง Hook ใหม่</Tip>
          <Tip>โควตาครบ: รอรอบรีเซ็ตหรือดูแพ็กเกจที่รองรับการใช้งานมากขึ้นจากหน้า Pricing</Tip>
          <Tip>ระบบ AI ไม่พร้อมชั่วคราว: ลองใหม่อีกครั้งโดยไม่กดซ้ำหลายแท็บ หากยังเกิดซ้ำให้แนบเวลาที่พบปัญหาใน ticket</Tip>
          <Tip>ส่งเข้าตัดต่อไม่ได้: รอให้สถานะ “บันทึกแล้ว” ปรากฏก่อน แล้วตรวจว่าสมาชิกยังไม่หมดอายุ</Tip>
        </Tips>
      </Section>

      <div className="flex flex-col gap-3 border-y py-5 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--ui-divider)" }}>
        <div>
          <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>พร้อมเริ่มสคริปต์แรกแล้ว</p>
          <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>เริ่มจากหัวข้อเดียว แล้วค่อยปรับ Brand Profile หลังเห็นร่างแรก</p>
        </div>
        <Link
          href="/hero-script"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-violet-50 transition-colors hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          <Send className="h-4 w-4" /> ไปที่ Hero Script
        </Link>
      </div>
    </div>
  );
}
