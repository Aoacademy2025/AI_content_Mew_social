"use client";

import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { BookOpen, Film, Mic, Wand2, Captions, Settings2, Video, Play, Layers, User } from "lucide-react";

const CARD: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-6" style={CARD}>
      <div className="flex items-center gap-2.5 mb-4 pb-3 border-b" style={{ borderColor: "var(--ui-card-border)" }}>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.22)" }}>
          <Icon className="h-4 w-4 text-cyan-400" />
        </div>
        <h2 className="text-lg font-bold text-white">{title}</h2>
      </div>
      <div className="space-y-3 text-sm text-white/70 leading-relaxed">{children}</div>
    </section>
  );
}

function Step({ num, title, children }: { num: string | number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
        style={{ background: "linear-gradient(135deg, hsl(190 100% 42%), hsl(230 100% 55%))" }}>
        {num}
      </div>
      <div className="flex-1 pt-0.5">
        <h3 className="text-sm font-bold text-white mb-1.5">{title}</h3>
        <div className="text-[13px] text-white/60 space-y-1.5">{children}</div>
      </div>
    </div>
  );
}

function PipelineRow({ num, name, desc }: { num: number; name: string; desc: string }) {
  return (
    <div className="flex gap-3 items-start py-2.5 border-b last:border-b-0" style={{ borderColor: "var(--ui-card-border)" }}>
      <span className="font-mono text-[11px] font-bold text-cyan-400/70 mt-0.5 shrink-0">#{num}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-white">{name}</p>
        <p className="text-[12px] text-white/50 mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

export default function DocsPage() {
  const [mode, setMode] = useState<"video" | "avatar">("video");

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl space-y-5 p-4 md:p-6">

        {/* Header */}
        <div className="rounded-2xl p-6" style={CARD}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 42%), hsl(230 100% 55%))" }}>
                <BookOpen className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">คู่มือการใช้งาน</h1>
                <p className="text-sm text-white/50 mt-0.5">Avatar Cloning — Short Video Pipeline</p>
              </div>
            </div>

            {/* Mode switcher */}
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
              <button onClick={() => setMode("video")}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold transition-all"
                style={mode === "video"
                  ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 70%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                  : { color: "rgba(255,255,255,0.4)", border: "1px solid transparent" }}>
                <Film className="h-3.5 w-3.5" /> วิดีโออย่างเดียว
              </button>
              <button onClick={() => setMode("avatar")}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold transition-all"
                style={mode === "avatar"
                  ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 70%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                  : { color: "rgba(255,255,255,0.4)", border: "1px solid transparent" }}>
                <User className="h-3.5 w-3.5" /> + Avatar
              </button>
            </div>
          </div>
        </div>

        {mode === "video" ? <VideoOnlyDoc /> : <AvatarDoc />}
      </div>
    </DashboardLayout>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-cyan-400 shrink-0">•</span>
      <span>{children}</span>
    </li>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg p-3 text-[13px]" style={{ background: "hsl(35 100% 50% / 0.08)", border: "1px solid hsl(35 100% 50% / 0.25)" }}>
      <span className="text-amber-400 shrink-0 font-bold">⚠</span>
      <span className="text-amber-200/80">{children}</span>
    </div>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg p-3 text-[13px]" style={{ background: "hsl(190 100% 50% / 0.08)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
      <span className="text-cyan-400 shrink-0 font-bold">ℹ</span>
      <span className="text-cyan-200/80">{children}</span>
    </div>
  );
}

function VideoOnlyDoc() {
  return (
    <>
      {/* Overview */}
      <Section title="โหมดวิดีโออย่างเดียว (Video Only)" icon={Film}>
        <p>
          โหมดนี้สร้างวิดีโอแนวตั้ง <b className="text-white">9:16 (1080×1920)</b> จากบทพูดที่คุณพิมพ์เข้าไป
          ระบบจะแปลงเป็นเสียง AI, ดึงคลิป stock มาเรียงตรงกับแต่ละประโยค, ใส่ subtitle และ render เป็น MP4
        </p>
        <Info>รองรับทั้งวิดีโอสั้น (30 วิ) และวิดีโอยาว (5–10 นาที) — ระบบจะปรับจำนวนซับและคลิปให้อัตโนมัติ</Info>
      </Section>

      {/* Before running */}
      <Section title="ขั้นตอนก่อนกด Run All" icon={Wand2}>
        <Step num={1} title="ใส่ Script (บทพูด)">
          <p>พิมพ์บทพูดในช่อง Script เป็นข้อความอิสระ ภาษาไทย / อังกฤษ / ผสมกันได้</p>
          <p>เขียนเหมือนเล่าเรื่อง ระบบจะส่ง script เข้า LLM เพื่อตัดเป็นซับ subtitle แต่ละประโยคให้เอง</p>
          <Warn>อย่าใส่ stage direction เช่น (pause) หรือ [music] เพราะจะปนออกมาในซับ</Warn>
        </Step>

        <Step num={2} title="เลือก Stock Source (แหล่งคลิป)">
          <p>ในการ์ด <b className="text-white">Stock Source</b> เลือกแหล่งดึงคลิป B-roll:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">Pexels</b> — ดึงจาก Pexels เท่านั้น</li>
            <li><b className="text-white">Pixabay</b> — ดึงจาก Pixabay เท่านั้น</li>
            <li><b className="text-white">Both</b> — ดึงจากทั้งสองแหล่ง (แนะนำ — คลิปหลากหลายกว่า)</li>
          </ul>
          <Info>ตั้งค่าตรงนี้ก่อนกด Run All เสมอ — เปลี่ยนทีหลังต้องรัน Phase 1 ใหม่ทั้งหมด</Info>
        </Step>

        <Step num={3} title="เลือก Voice Model (เสียงพูด)">
          <p>ในการ์ด <b className="text-white">Voice Model</b> เลือก provider:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">ElevenLabs</b> — เสียงธรรมชาติคุณภาพสูง (ใส่ Voice ID จาก ElevenLabs)</li>
            <li><b className="text-white">Gemini TTS</b> — เสียงจาก Google เลือก voice จาก dropdown</li>
          </ul>
          <p>กดปุ่ม <b className="text-white">Preview</b> เพื่อฟังเสียงตัวอย่างก่อนใช้จริง ประหยัดเวลามากถ้าไม่ชอบเสียงนั้น</p>
        </Step>

        <Step num={4} title="(ออปชัน) เลือก Subtitle Style">
          <p>เลือกฟอนต์, ขนาด, สี, ตำแหน่ง และ preset ก่อน render</p>
          <p>ปรับทีหลังและกด <b className="text-white">Re-run Phase 2</b> ได้โดยไม่เสียโควต้า TTS / Stock</p>
        </Step>

        <Step num={5} title="(ออปชัน) เคลียร์ Cache ก่อนรัน">
          <p>กดปุ่ม <b className="text-white">Cache</b> ข้างปุ่ม Run All เพื่อลบไฟล์ stock เก่าออก</p>
          <p>แนะนำให้กดทุกครั้งก่อนสร้างวิดีโอใหม่ เพื่อไม่ให้คลิปเก่าค้างในระบบ</p>
        </Step>
      </Section>

      {/* How pipeline works */}
      <Section title="ระบบทำงานยังไง — Pipeline ทั้ง 6 ขั้น" icon={Layers}>
        <p className="text-white/50 text-[12px]">เมื่อกด Run All ระบบจะรันต่อเนื่องตามลำดับนี้:</p>
        <div className="rounded-xl p-4 mt-2" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
          <PipelineRow num={1} name="Extract Keywords (LLM)" desc="LLM อ่าน script → แบ่งเป็น scene → หา keyword ภาษาอังกฤษสำหรับค้น B-roll แต่ละฉาก" />
          <PipelineRow num={2} name="Stock Fetch" desc="ค้น Pexels / Pixabay ด้วย keyword → LLM rank คลิปที่ตรงที่สุด → ดาวน์โหลดไฟล์ MP4 ลงเซิร์ฟเวอร์" />
          <PipelineRow num={3} name="TTS Voice" desc="ส่ง script ให้ ElevenLabs หรือ Gemini สังเคราะห์เสียงพูด → ได้ไฟล์ WAV / MP3" />
          <PipelineRow num={4} name="Transcribe (Whisper)" desc="ส่งไฟล์เสียงให้ Whisper หรือ Gemini ถอดเป็น timestamp ต่อประโยค → LLM แบ่ง script เป็นซับพร้อม timestamp จาก STT" />
          <PipelineRow num={5} name="Generate Config" desc="จับคู่คลิป stock แต่ละตัวเข้ากับ timestamp ของซับ → สร้าง timeline config ให้ Remotion" />
          <PipelineRow num={6} name="Render (Remotion)" desc="Remotion render frame-by-frame: คลิป B-roll เล่นตรงช่วงเวลาของซับนั้น + ซับ popup ตรงจังหวะเสียง → ออกมาเป็น MP4" />
        </div>
        <Info>
          คลิป B-roll และซับ <b className="text-white">ตรงกัน</b> — ทั้งคู่ใช้ timestamp เดียวกัน คลิปที่ 1 เล่นช่วงเดียวกับซับที่ 1 เสมอ
        </Info>
      </Section>

      {/* After run */}
      <Section title="หลัง Run เสร็จ — สิ่งที่ทำได้" icon={Captions}>
        <Step num="A" title="ดู Subtitle Review และแก้ซับ">
          <p>ใน <b className="text-white">Subtitle Review</b> จะเห็น subtitle ทุกฉากพร้อม timestamp</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li>แก้ข้อความซับได้โดยตรง</li>
            <li>ปรับ start/end time ของแต่ละฉาก</li>
            <li>ลบฉากที่ไม่ต้องการ กด <b className="text-white">✕</b></li>
            <li>เพิ่มฉากใหม่ได้ด้วยปุ่ม + ด้านล่าง</li>
          </ul>
          <p>กด <b className="text-white">Re-run Phase 2</b> เพื่อ render ใหม่ตามซับที่แก้</p>
        </Step>

        <Step num="B" title="เลือก / สลับคลิป Stock">
          <p>ในการ์ด Stock ดู thumbnail คลิปทั้งหมดที่ระบบดึงมา:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li>กดคลิปเพื่อ <b className="text-white">ตัดออก</b> จากวิดีโอ</li>
            <li>คลิปที่ตัดออกจะ fallback ไปคลิปใกล้เคียงอัตโนมัติ</li>
          </ul>
          <p>กด <b className="text-white">Re-run Phase 2</b> เพื่อ render ด้วยคลิปชุดใหม่</p>
          <Info>ไม่เสียโควต้า Stock API ใหม่ — ใช้คลิปที่ดาวน์โหลดไว้แล้ว</Info>
        </Step>

        <Step num="C" title="ปรับ Subtitle Style แล้ว Re-render">
          <p>เปลี่ยนฟอนต์, สี, ขนาด, ตำแหน่ง subtitle แล้วกด <b className="text-white">Re-run Phase 2</b></p>
          <p>ไม่ต้องรัน Phase 1 ใหม่ ไม่เสียโควต้าใดเลย</p>
        </Step>

        <Step num="D" title="ดาวน์โหลดและบันทึกลง Gallery">
          <p>วิดีโอที่ render เสร็จจะบันทึกลง Gallery อัตโนมัติ</p>
          <p>กดปุ่มดาวน์โหลดในหน้า preview เพื่อบันทึกเป็น MP4 ลงเครื่อง</p>
        </Step>
      </Section>

      {/* Error handling */}
      <Section title="แก้ปัญหาที่พบบ่อย" icon={Settings2}>
        <div className="space-y-3">
          <div className="rounded-lg p-3" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">ขึ้น &quot;Unexpected token&quot; หรือ error แปลกๆ</p>
            <p>กดรัน Phase ที่ error ใหม่อีกครั้ง ถ้ายังขึ้นอีก 2–3 ครั้ง ให้กดรีเฟรชหน้าต่างแล้วเริ่มใหม่ตั้งแต่ต้น</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">Stock: keywords required / ไม่พบ stock</p>
            <p>ตรวจสอบว่าใส่ Pexels หรือ Pixabay API key ใน Settings แล้ว กดรัน Retry ที่ขั้น Stock</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">Transcribe: Failed to fetch audio file (404)</p>
            <p>ไฟล์เสียงถูกลบออกจาก cache แล้ว กดรัน Phase 1 ใหม่ตั้งแต่ TTS Voice</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">ซับผิดหรือตัดแบ่งประโยคไม่ตรง</p>
            <p>แก้ได้ใน Subtitle Review โดยตรง แล้ว Re-run Phase 2 — ไม่ต้องรัน Phase 1 ใหม่</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">Cache ใหญ่มาก (หลาย GB)</p>
            <p>กดปุ่ม Cache ข้าง Run All เพื่อลบไฟล์ stock เก่า แต่ละ user เห็นเฉพาะ cache ของตัวเอง</p>
          </div>
        </div>
      </Section>

      {/* Tips */}
      <Section title="เคล็ดลับ" icon={Play}>
        <ul className="space-y-2">
          <Tip>กดปุ่ม <b className="text-white">Cache</b> ก่อนรัน Run All ทุกครั้ง เพื่อเคลียร์ stock เก่า</Tip>
          <Tip>ฟัง <b className="text-white">Preview Voice</b> ก่อนกด Run All จะได้ไม่ต้องรัน TTS ซ้ำ</Tip>
          <Tip>สคริปยาว 5–10 นาที รองรับได้ แต่ขั้น Stock จะใช้เวลานานขึ้น (ดึงคลิป 200–400 คลิป)</Tip>
          <Tip>ถ้าต้องการเปลี่ยนแค่ subtitle style หรือคลิป → Re-run Phase 2 พอ ประหยัดโควต้า API</Tip>
          <Tip>ถ้าต้องการเปลี่ยนเสียงหรือ script → Re-run Phase 1 ทั้งหมด</Tip>
        </ul>
      </Section>
    </>
  );
}

function AvatarDoc() {
  return (
    <>
      <Section title="โหมด Avatar + วิดีโอ (Avatar Overlay)" icon={User}>
        <p>
          โหมดนี้สร้างวิดีโอสั้นแนวตั้ง <b className="text-white">9:16 (1080×1920)</b> แบบเดียวกับโหมดวิดีโออย่างเดียว
          แต่เพิ่ม <b className="text-white">avatar คนพูด</b> ซ้อนทับลงบนพื้นหลัง stock โดยลบฉากหลังสีเขียวออกอัตโนมัติ
        </p>
        <p>
          <b className="text-white">ผลลัพธ์:</b> วิดีโอ MP4 ที่มี avatar พูดอยู่หน้าฟุตเทจ stock + เสียง + subtitle ฝังในวิดีโอ
        </p>
      </Section>

      <Section title="ขั้นตอนการเตรียม Input" icon={Wand2}>
        <Step num={1} title="ใส่ Script และตั้งค่าพื้นฐาน">
          <p>เตรียม Script, Stock Source, Voice Model, Subtitle Style เหมือนโหมดวิดีโออย่างเดียว</p>
          <p>(ดูรายละเอียดใน tab <b className="text-white">วิดีโออย่างเดียว</b>)</p>
        </Step>

        <Step num={2} title="เปิดโหมด Avatar">
          <p>ในการ์ด <b className="text-white">Avatar</b> ทางขวา กดสลับจาก <b className="text-white">Video Only</b> → <b className="text-white">+ Avatar</b></p>
          <p>เมื่อเปิดแล้วจะมีตัวเลือกเพิ่มสำหรับ avatar source</p>
        </Step>

        <Step num={3} title="เลือก Avatar Source">
          <p>มี 2 โหมดให้เลือก:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">Generate (HeyGen)</b> — สร้าง avatar ใหม่จาก HeyGen API ใส่ <b className="text-white">Avatar ID</b> + เลือก voice ระบบจะสังเคราะห์วิดีโอ avatar พูดให้</li>
            <li><b className="text-white">Direct URL</b> — ใช้วิดีโอ avatar ที่มีอยู่แล้ว วาง URL หรืออัปโหลดไฟล์ MP4 / MOV / WebM ได้เลย</li>
          </ul>
        </Step>

        <Step num={4} title="(เฉพาะโหมด Generate) ตั้งตำแหน่งและขนาด Avatar">
          <p>ใช้ canvas 9:16 ทางซ้ายของการ์ด Avatar:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">ลาก</b> วงกลมสีฟ้าเพื่อย้ายตำแหน่ง avatar</li>
            <li><b className="text-white">Slider Offset X / Y</b> — ปรับตำแหน่งละเอียด</li>
            <li><b className="text-white">Slider Scale</b> — ปรับขนาด avatar (ค่า default 2.02)</li>
            <li>กด <b className="text-white">Reset</b> เพื่อกลับค่าเริ่มต้น</li>
          </ul>
        </Step>

        <Step num={5} title="(เฉพาะโหมด Generate) เลือก Avatar Timing">
          <p>กำหนดช่วงเวลาที่ avatar จะปรากฏในวิดีโอ:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">ตลอดคลิป</b> — avatar แสดงตั้งแต่ต้นจนจบ</li>
            <li><b className="text-white">ต้นคลิปเท่านั้น</b> — avatar แสดงเฉพาะ N วินาทีแรก (ตั้งจำนวนวินาทีได้) หลังจากนั้นโชว์เฉพาะ stock</li>
          </ul>
        </Step>
      </Section>

      <Section title="ขั้นตอน Pipeline เมื่อกด Run All" icon={Layers}>
        <p>โหมด Avatar เพิ่ม Phase 3 ต่อจาก pipeline ของโหมดวิดีโออย่างเดียว — รวม 8 ขั้นตอน:</p>
        <div className="rounded-xl p-4 mt-2" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
          <PipelineRow num={1} name="Keywords" desc="วิเคราะห์ script → แยกเป็น scene + ดึง keyword" />
          <PipelineRow num={2} name="Stock" desc="ดาวน์โหลดคลิป background จาก Pexels / Pixabay" />
          <PipelineRow num={3} name="TTS Voice" desc="สังเคราะห์เสียงพูดจาก script" />
          <PipelineRow num={4} name="Transcribe" desc="Whisper ถอดเสียง → word-level timestamp" />
          <PipelineRow num={5} name="Config" desc="ประกอบ config: timeline + subtitle popup" />
          <PipelineRow num={6} name="Render (BG)" desc="Remotion render วิดีโอ background พร้อมเสียง + subtitle" />
          <PipelineRow num={7} name="Avatar" desc="HeyGen สร้าง avatar speaking video พื้นเขียว (เฉพาะโหมด Generate)" />
          <PipelineRow num={8} name="Composite" desc="FFmpeg ลบสีเขียว (chromakey) แล้ว overlay avatar ลงบน background → วิดีโอสุดท้าย" />
        </div>
      </Section>

      <Section title="หลัง Run เสร็จ" icon={Captions}>
        <Step num="A" title="เลือกคลิป Stock เองและ Re-render">
          <p>เหมือนโหมดวิดีโออย่างเดียว — เปิด Live Status ของขั้น Stock เลือก / ไม่เลือกคลิป แล้วกด <b className="text-white">Re-run Phase 2</b></p>
          <p>หลังจากนั้นกด <b className="text-white">Re-run Phase 3</b> (Composite) เพื่อเอา avatar มา overlay บน background ใหม่</p>
        </Step>

        <Step num="B" title="ปรับตำแหน่ง / ขนาด Avatar ใหม่">
          <p>ลาก canvas หรือปรับ slider แล้วกด <b className="text-white">Re-run Phase 3</b> (Avatar + Composite) เพื่อสร้างวิดีโอใหม่ตามตำแหน่งที่แก้</p>
          <p>ไม่ต้อง re-run Phase 1, 2 — ประหยัดโควต้า TTS / Stock / HeyGen</p>
        </Step>

        <Step num="C" title="แก้ Subtitle / Caption">
          <p>แก้ใน Caption Editor → กด <b className="text-white">Re-run Phase 2</b> → กด <b className="text-white">Re-run Phase 3</b></p>
        </Step>

        <Step num="D" title="ดาวน์โหลด">
          <p>กดปุ่มดาวน์โหลดในหน้า preview เพื่อบันทึกไฟล์ MP4 สุดท้าย</p>
        </Step>
      </Section>

      <Section title="เคล็ดลับ" icon={Settings2}>
        <ul className="space-y-2">
          <li className="flex gap-2">
            <span className="text-cyan-400 shrink-0">•</span>
            <span>ถ้ามี avatar video อยู่แล้ว → ใช้ <b className="text-white">Direct URL</b> จะเร็วกว่า ไม่ต้องเสียโควต้า HeyGen</span>
          </li>
          <li className="flex gap-2">
            <span className="text-cyan-400 shrink-0">•</span>
            <span>โหมด Generate: ตั้ง <b className="text-white">Avatar Timing = ต้นคลิปเท่านั้น</b> (5–10 วินาทีแรก) จะดูเป็นธรรมชาติกว่าการให้ avatar พูดทั้งคลิป</span>
          </li>
          <li className="flex gap-2">
            <span className="text-cyan-400 shrink-0">•</span>
            <span>ถ้า avatar ตำแหน่งไม่ลงตัว → ปรับ slider แล้ว Re-run แค่ Phase 3 พอ ไม่ต้องเสียเวลา render ใหม่ทั้งหมด</span>
          </li>
          <li className="flex gap-2">
            <span className="text-cyan-400 shrink-0">•</span>
            <span>การลบสีเขียวใช้ ffmpeg chromakey — วิดีโอ avatar ต้องมีพื้นหลังสีเขียวสะอาด ไม่มี shadow บนใบหน้า เพื่อให้ลบได้คม</span>
          </li>
        </ul>
      </Section>
    </>
  );
}
