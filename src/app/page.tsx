import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { PricingToggle } from "@/components/marketing/pricing-toggle";
import { EditorDemo } from "@/components/marketing/sale-v3/editor-demo";
import { PageBehaviors } from "@/components/marketing/sale-v3/page-behaviors";
import { getFoundingCoupon } from "@/lib/founding";
import { getPlanConfig } from "@/lib/plan-config";
import { promptpayMonthlyOffered } from "@/lib/promptpay-monthly";
import "./sale-v3.css";

export const metadata = {
  title: "HERO AI Creator Studio — สคริปต์เดียว ได้คลิปสั้นพร้อมซับไทย",
  description:
    "เสียงพากย์ ซับไทยตรงเสียง ภาพประกอบเปลี่ยนตามเนื้อหา และเพลง ครบในคลิปเดียว ทำบนเว็บก็ได้ หรือสั่งจากแชท AI ที่คุณใช้อยู่ เช่น Claude",
  openGraph: {
    title: "HERO AI Creator Studio — สคริปต์เดียว ได้คลิปสั้นพร้อมซับไทย",
    description: "ทำคลิปสั้นพร้อมเสียงพากย์ ซับไทย ภาพประกอบ และเพลง บนเว็บ หรือสั่งจากแชท AI ที่คุณใช้อยู่",
    url: "https://studio.heroaiengine.com",
    type: "website",
  },
};

export const revalidate = 60;

// Display fonts only this page uses (the caption faces in the demo and the mono timecodes).
const PAGE_FONTS =
  "https://fonts.googleapis.com/css2?family=Kanit:wght@500;800;900&family=Prompt:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";
const MCP_URL = "https://studio.heroaiengine.com/api/mcp";
const TRY = "ทดลอง PRO ฟรี 7 วัน";

async function getFounding() {
  try {
    const coupon = await getFoundingCoupon();
    if (!coupon || coupon.maxUses <= 0) return null;
    const remaining = Math.max(0, coupon.maxUses - coupon.usedCount);
    return {
      active: remaining > 0,
      remaining,
      total: coupon.maxUses,
      percentOff: coupon.percentOff,
    };
  } catch {
    return null;
  }
}

const MANAGED = process.env.MANAGED_GEMINI === "1";
const MINUTE_QUOTA = process.env.MINUTE_QUOTA === "1";

const OUTPUTS = [
  { k: "avatar", src: "", title: "พิธีกร AI หน้าของมิวเอง", desc: "พิธีกรพูดตลอดคลิป ภาพประกอบเปลี่ยนด้านหลังทุกไม่กี่วินาที ซับไทยตามเสียง" },
  { k: "brownie", src: "สั่งจากแชท", title: "ขายของ: กล่องบราวนี่", desc: "พาดหัวเปิดคลิป ภาพสินค้าจาก Hero AI Image ซับเด้ง ปิดด้วยราคาและช่องทางสั่ง" },
  { k: "locked", src: "ทำบนเว็บ", title: "ข่าว + พิธีกร", desc: "อัปคลิปพิธีกร ระบบใส่ซับไฮไลต์และภาพประกอบสลับให้" },
  { k: "digital", src: "ทำบนเว็บ", title: "สอนใช้งาน", desc: "ภาพวิดีโอจริงจากคลัง เลือกให้ตรงกับแต่ละประโยค" },
  { k: "pixza", src: "ทำบนเว็บ", title: "มาสคอตแบรนด์", desc: "ใช้ภาพของแบรนด์เอง ซับกล่องเรียบ เพลงซีเนมาติก" },
] as const;

const STYLES = [
  { c: "s-viral", title: "เด้งไวรัล", desc: "ขอบดำ เด้งเข้าทีละการ์ด" },
  { c: "s-shadow", title: "เงาเข้ม", desc: "เงานุ่ม อ่านง่ายบนทุกภาพ" },
  { c: "s-outline", title: "ขอบหนา", desc: "ตัวหนังสือคม เห็นชัดจากไกล" },
  { c: "s-clean", title: "มินิมอล", desc: "กล่องเรียบ เหมาะกับงานแบรนด์" },
] as const;

const STEPS = [
  { t: "0:00", title: "พิมพ์สั่ง", desc: "บอกสคริปต์ เสียง และสไตล์ที่อยากได้" },
  { t: "0:05", title: "AI เช็กโควตาให้", desc: "ทุกงานมีเพดานโควตา ถ้าต้องใช้เกิน ระบบหยุดรอให้คุณยืนยันบนเว็บก่อน" },
  { t: "0:08", title: "HERO สร้างคลิป", desc: "ปกติ 3–6 นาที ถ้ามีพิธีกร AI ประมาณ 15–25 นาที" },
  { t: "4:20", title: "ดูภาพตัวอย่าง", desc: "ขอดูภาพวินาทีไหนก็ได้" },
  { t: "4:40", title: "สั่งแก้", desc: "แก้กี่รอบก็ได้ ไม่เสียเพิ่ม", free: true },
  { t: "5:30", title: "ส่งออก", desc: "ได้ไฟล์พร้อมโพสต์ และลิงก์เปิดแก้ต่อบนเว็บ" },
];

const PROMPTS = [
  { q: "ทำคลิป 60 วิจากสคริปต์นี้ ซับตัวใหญ่เน้นคำ เพลงสนุก แล้วขอดูภาพที่วินาทีที่ 5 ก่อนส่งออก", tag: "คลิปแรก" },
  { q: "เขียนสคริปต์รีวิวร้านกาแฟนี้ยาว 45 วิ แล้วทำเป็นคลิปเสียงผู้หญิง โทนอบอุ่น", tag: "ให้ AI เขียนให้ด้วย" },
  { q: "ทำคลิปจากสคริปต์นี้ ใส่พิธีกรเปิด 5 วิกับปิด 5 วิ", tag: "มีพิธีกร AI" },
  { q: "คลิปล่าสุด การ์ดซับที่ 2 กับ 3 รวมเป็นการ์ดเดียว แล้วเปลี่ยนพาดหัวเป็น “เงินเดือนออกปุ๊บ หายปั๊บ?”", tag: "แก้คลิปเดิม" },
  { q: "ช่วงวินาทีที่ 10 ถึง 15 ใช้รูปสินค้าที่ฉันแนบไป แทนภาพเดิม", tag: "ใส่ภาพของคุณ" },
  { q: "ทำ 3 คลิปจาก 3 สคริปต์นี้ ใช้สไตล์ซับเดียวกันทุกคลิป เสร็จแล้วส่งลิงก์ดาวน์โหลดมาทีเดียว", tag: "ทำทีละหลายคลิป" },
];

const TOOLS: { title: string; tag?: string; desc: string }[] = [
  { title: "ชุดสไตล์สำเร็จรูป 8 แบบ", desc: "เลือกครั้งเดียว ได้ทั้งโทนภาพ ฟอนต์ และสีซับที่เข้ากัน" },
  { title: "ซับไทย 17 สไตล์", desc: "เน้นคำสำคัญ ใส่การ์ดตัวเลข แก้ข้อความทีละการ์ด" },
  { title: "เสียงพากย์ 15 แบบ", desc: "หรือใช้เสียงโคลนของคุณผ่านบัญชี ElevenLabs" },
  { title: "พิธีกร AI", tag: "ค่าใช้จ่ายแยก", desc: "ใช้บัญชี HeyGen ของคุณ เปิดคลิป ปิดคลิป หรือทั้งคลิป" },
  { title: "อัปคลิปของคุณเอง", desc: "ระบบตัดช่วงเงียบ ใส่ซับ และภาพประกอบให้" },
  { title: "เพลง เสียงประกอบ และโลโก้", desc: "คลังเพลงพร้อมใช้ ใส่โลโก้แบรนด์มุมคลิป" },
  { title: "เขียนสคริปต์ด้วย AI", tag: "แผน PRO ขึ้นไป", desc: "ใส่หัวข้อ ได้สคริปต์ภาษาไทยพร้อมทำคลิป" },
  { title: "ใส่ภาพเองทีละช่วง", desc: "ลากภาพหรือคลิปของคุณไปวางแทนช่วงไหนก็ได้" },
];

const FAQ_AGENT = [
  { q: "ต้องเขียนโค้ดเป็นไหม", a: "ไม่ต้อง ถ้าใช้ Claude แค่วางลิงก์ในหน้า Connectors แล้วล็อกอิน ใช้เวลาประมาณ 2 นาที" },
  { q: "AI ตัวไหนใช้ได้บ้าง", a: "AI ที่รองรับตัวเชื่อมต่อ (Connector) ใช้ได้ทั้งหมด ตัวที่ลูกค้าใช้งานจริงแล้วจะมีจุดสีเขียวในส่วนวิธีเชื่อม" },
  { q: "เสียเงินเพิ่มไหม", a: "ไม่เสีย AI ของคุณใช้โควตาเดียวกับแผนที่คุณจ่ายอยู่ ยกเว้นพิธีกร AI ที่ใช้บัญชี HeyGen ของคุณเอง" },
  { q: "ปลอดภัยไหม AI จะเห็นอะไรบ้าง", a: "AI เห็นเฉพาะงานคลิปในบัญชีคุณ ไม่เห็นรหัสผ่านหรือข้อมูลการจ่ายเงิน และลบตัวเชื่อมต่อออกได้ทุกเมื่อ" },
  { q: "แก้คลิปก่อนส่งออกได้ไหม", a: "ได้ สั่งแก้ซับ เพลง ภาพ หรือขอดูภาพตัวอย่างได้เรื่อย ๆ แก้กี่รอบก็ไม่ตัดโควตาเพิ่ม" },
  { q: "เชื่อมไม่ติดทำอย่างไร", a: "ตรวจว่าล็อกอินบัญชี HERO แผน PRO ขึ้นไปหรืออยู่ในช่วงทดลอง แล้วลองลบตัวเชื่อมต่อและเพิ่มใหม่ ถ้ายังไม่ได้ แจ้งทีมงานจากปุ่มช่วยเหลือในแอป" },
  { q: "คลิปที่ได้ไปอยู่ที่ไหน", a: "อยู่ในบัญชี HERO ของคุณ AI ส่งลิงก์ดาวน์โหลดให้ในแชท และเปิดแก้ต่อบนเว็บได้" },
];

const FAQ_GENERAL = [
  {
    q: "ทดลองฟรีต้องใช้บัตรไหม ครบ 7 วันแล้วเกิดอะไรขึ้น",
    a: `ไม่ต้องใช้บัตร ได้ฟีเจอร์ PRO ครบ 7 วัน รวมการสั่งผ่าน AI${MINUTE_QUOTA ? " (โควตาเรนเดอร์รวม 15 นาที)" : ""} ครบแล้วระบบกลับเป็นแผน Free ให้เอง ไม่มีการตัดเงิน คลิปที่ทำไว้ยังอยู่ครบ`,
  },
  {
    q: "ต้องตั้งค่าระบบ AI เองไหม",
    a: MANAGED
      ? "ไม่ต้อง ระบบเตรียม AI หลักให้พร้อมใช้ ไม่ต้องสมัครหรือใส่รหัสเชื่อมต่อเอง ส่วนพิธีกร AI และเสียงโคลน เชื่อมบัญชีเพิ่มภายหลังได้"
      : "ระบบมีคู่มือพาสมัครและเชื่อมบริการ AI ฟรีทีละขั้น ส่วนพิธีกร AI และเสียงโคลน เชื่อมบัญชีเพิ่มภายหลังได้",
  },
  { q: "ยกเลิกแผนรายเดือนได้ไหม", a: "ได้ทุกเมื่อจากหน้าตั้งค่า ใช้ต่อได้จนครบรอบที่จ่ายไว้" },
  {
    q: "แพ็กรายปีตัดเงินอัตโนมัติไหม",
    a: "ขึ้นอยู่กับวิธีชำระ PromptPay รายปีเป็นการจ่ายครั้งเดียวและไม่ต่ออัตโนมัติ ส่วนบัตรรายปีจะต่อสมาชิกอัตโนมัติ และยกเลิกได้จากหน้าตั้งค่าการชำระเงิน",
  },
  { q: "ซับภาษาไทยตรงเสียงแค่ไหน", a: "ซับตั้งเวลาตามเสียงพากย์จริง แก้ข้อความได้ทุกการ์ดก่อนส่งออก" },
  { q: "ใช้เสียงตัวเองได้ไหม", a: "ได้ อัปคลิปที่คุณพูดเอง หรือใช้เสียงโคลนผ่านบัญชี ElevenLabs ของคุณ" },
];

function Steps({ items }: { items: string[][] }) {
  return (
    <ol>
      {items.map(([b, p]) => (
        <li key={b}><div><b>{b}</b>{p && <p>{p}</p>}</div></li>
      ))}
    </ol>
  );
}

export default async function Home() {
  // ADR 0066 — promptpayMonthlyOffered() short-circuits to `false` before any config/DB
  // read when PROMPTPAY_MONTHLY is off, so this adds no query on the flag-off path.
  const [plans, founding, offeredPro, offeredBusiness] = await Promise.all([
    getPlanConfig(),
    getFounding(),
    promptpayMonthlyOffered("PRO"),
    promptpayMonthlyOffered("BUSINESS"),
  ]);

  return (
    <div className="sv3">
      <link rel="stylesheet" href={PAGE_FONTS} precedence="default" />

      {founding?.active && (
        <div className="bar">
          สิทธิ์ราคาผู้ก่อตั้ง {founding.total} คนแรก ลด {founding.percentOff}% เมื่อจ่ายรายปี เหลืออีก <b>{founding.remaining}</b> ที่
          <a href="#pricing">รับสิทธิ์</a>
        </div>
      )}

      <nav className="top" aria-label="เมนูหลัก">
        <div className="wrap">
          <Link className="logo" href="/" aria-label="HERO AI Creator Studio หน้าแรก">
            <Image src="/logo.svg" alt="" width={26} height={26} priority />HERO AI <small>Creator Studio</small>
          </Link>
          <ul>
            <li><a href="#demo">ลองสั่ง</a></li>
            <li><a href="#connect">วิธีเชื่อม AI</a></li>
            <li><a href="#outputs">ผลงาน</a></li>
            <li><a href="#pricing">ราคา</a></li>
            <li><a href="#faq">คำถามที่พบบ่อย</a></li>
          </ul>
          <div className="end">
            <Link className="btn btn-line" href="/login">เข้าสู่ระบบ</Link>
            <Link className="btn btn-main" href="/register">{TRY}</Link>
          </div>
        </div>
      </nav>

      <main>
        <header className="wrap h3head">
          <h1><span>สคริปต์เดียว</span> <span>ได้คลิปสั้นพร้อมซับไทย</span></h1>
          <p className="lede">
            เสียงพากย์ ซับไทยตรงเสียง ภาพประกอบเปลี่ยนตามเนื้อหา และเพลง ครบในคลิปเดียว <span className="nb">ทำบนเว็บก็ได้</span>{" "}
            <span className="nb">หรือสั่งจากแชท AI ที่คุณใช้อยู่</span>
          </p>
          <div className="cta-row"><Link className="btn btn-main" href="/register">{TRY}</Link></div>
          <p className="nocard"><b>ไม่ต้องใช้บัตร</b> ครบ 7 วันระบบกลับเป็นแผน Free ให้เอง ไม่มีการตัดเงิน</p>
          <div className="proof"><i /><span>ลูกค้าสั่งทำคลิปผ่านแชทสำเร็จ <b>205 คลิป</b> ช่วง 14–28 ต.ค. 2569</span></div>
        </header>

        <EditorDemo ctaHref="/register" />

        <section id="outputs">
          <div className="wrap">
            <h2>คลิปจริงที่ทีมเราทำด้วย HERO</h2>
            <p className="lede">ไฟล์ที่ส่งออกจริง ไม่ได้แต่งเพิ่ม เลื่อนมาถึงแล้วเล่นเอง แตะคลิปเพื่อหยุด</p>
            <div className="outs outs4">
              {OUTPUTS.map((o) => (
                <figure className="out" key={o.k}>
                  <div className="frame">
                    <video muted playsInline loop preload="none" poster={`/sale/${o.k}-final.jpg`} data-src={`/sale/${o.k}-final.mp4`} />
                    {o.src && <span className="src"><i />{o.src}</span>}
                  </div>
                  <h3>{o.title}</h3>
                  <p>{o.desc}</p>
                </figure>
              ))}
            </div>

            <h3 className="sub-h">คลิปเดียวกัน เปลี่ยนแค่ซับ</h3>
            <p className="lede">4 สไตล์ที่กดเลือกได้ทันที หรือพิมพ์บอก AI ว่า “เปลี่ยนซับเป็นแบบมินิมอล”</p>
            <div className="styles" id="styles">
              {STYLES.map((s) => (
                <figure className={`sty ${s.c}`} key={s.c}>
                  <div className="frame">
                    <video muted playsInline loop preload="none" data-src="/sale/brownie-clean.mp4" poster="/sale/brownie-poster.jpg" />
                    <div className="sc" />
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </figure>
              ))}
            </div>
            <div className="midcta">
              <Link className="btn btn-main" href="/register">{TRY}</Link>
              <span><b>ไม่ต้องใช้บัตร</b> ลองทำคลิปของคุณเองได้ภายในวันนี้</span>
            </div>
          </div>
        </section>

        <section className="sec-tight">
          <div className="wrap">
            <h2>ตั้งแต่พิมพ์สั่ง จนได้คลิปพร้อมโพสต์</h2>
            <div className="rsteps" id="rsteps">
              <div className="rs-track" aria-hidden="true">
                <div className="base" /><div className="fill" />
                <div className="brk"><svg viewBox="0 0 20 16"><path d="M4 14 9 2M11 14 16 2" stroke="#6f6a7d" strokeWidth="1.5" /></svg></div>
                <div className="head2" />
              </div>
              <ol>
                {STEPS.map((s) => (
                  <li key={s.t}>
                    <time>{s.t}</time>
                    <h3>{s.title}</h3>
                    <p className={s.free ? "free" : undefined}>{s.desc}</p>
                  </li>
                ))}
              </ol>
            </div>
            <p className="rs-note">เวลาโดยประมาณของคลิปยาวราว 30 วินาที</p>
          </div>
        </section>

        <section id="connect">
          <div className="wrap">
            <h2>เชื่อม AI ของคุณกับ HERO <span className="nb">ใน 3 ขั้น</span></h2>
            <p className="lede">ทำครั้งเดียว แล้วสั่งได้ทุกแชท ไม่ต้องวางรหัสหรือคีย์ใด ๆ ลงในแชท</p>
            <div className="connect">
              <div>
                <div className="plug" aria-hidden="true">
                  <span className="node">AI ของคุณ</span>
                  <svg viewBox="0 0 100 24" preserveAspectRatio="none"><path d="M0 12 H100" /></svg>
                  <span className="node h">HERO</span>
                </div>
                <div className="url">
                  <span className="label" id="mcp-url-label">ลิงก์ตัวเชื่อมต่อของ HERO</span>
                  <div className="row2">
                    <code id="mcp-url" aria-labelledby="mcp-url-label">{MCP_URL}</code>
                    <button className="btn btn-main" type="button" data-copy="mcp-url">คัดลอก</button>
                  </div>
                </div>
                <div className="legend">
                  <span><i />ใช้ได้เลย ลูกค้าใช้งานจริงแล้ว</span>
                  <span><i className="w" />กำลังทดสอบ</span>
                  <span><i className="s" />สายเทคนิค ตั้งค่าเองด้วยคำสั่ง</span>
                </div>
              </div>
              <div>
                <div className="tabs" role="tablist" aria-label="เลือก AI ที่คุณใช้">
                  <button type="button" role="tab" aria-selected="true" aria-controls="p-claude" id="t-claude"><i />Claude</button>
                  <button type="button" role="tab" aria-selected="false" aria-controls="p-gpt" id="t-gpt" tabIndex={-1}><i className="w" />ChatGPT</button>
                  <button type="button" role="tab" aria-selected="false" aria-controls="p-grok" id="t-grok" tabIndex={-1}><i className="w" />Grok</button>
                  <button type="button" role="tab" aria-selected="false" aria-controls="p-dev" id="t-dev" tabIndex={-1}><i className="s" />สายเทคนิค</button>
                </div>
                <div className="panel" role="tabpanel" id="p-claude" aria-labelledby="t-claude">
                  <Steps items={[
                    ["คัดลอกลิงก์ด้านซ้าย", "ลิงก์เดียวใช้ได้ทุกบัญชี"],
                    ["เปิด Claude ไปที่ Settings แล้วเลือก Connectors", "กด Add custom connector วางลิงก์ แล้วตั้งชื่อว่า HERO"],
                    ["กด Connect แล้วล็อกอินบัญชี HERO", "ล็อกอินบนหน้าเว็บ HERO เท่านั้น จากนั้นพิมพ์สั่งทำคลิปได้เลย"],
                  ]} />
                  <p className="tested">ลูกค้าใช้งานจริงผ่าน Claude แล้ว</p>
                </div>
                <div className="panel" role="tabpanel" id="p-gpt" aria-labelledby="t-gpt" hidden>
                  <Steps items={[
                    ["คัดลอกลิงก์ด้านซ้าย", "ลิงก์เดียวใช้ได้ทุกบัญชี"],
                    ["เปิด ChatGPT ไปที่ Settings แล้วเลือก Apps & Connectors", "เปิด Developer mode แล้วสร้างตัวเชื่อมต่อใหม่ด้วยลิงก์นี้"],
                    ["ล็อกอินบัญชี HERO แล้วเลือก HERO ในแชท", "จากนั้นพิมพ์สั่งทำคลิปได้เลย"],
                  ]} />
                  <p className="tested">กำลังทดสอบกับ ChatGPT ถ้าใช้ Codex อยู่แล้ว ดูแท็บสายเทคนิคได้เลย</p>
                </div>
                <div className="panel" role="tabpanel" id="p-grok" aria-labelledby="t-grok" hidden>
                  <Steps items={[
                    ["คัดลอกลิงก์ด้านซ้าย", "ลิงก์เดียวใช้ได้ทุกบัญชี"],
                    ["เพิ่มตัวเชื่อมต่อใน Grok", "ขั้นตอนละเอียดจะใส่หลังทดสอบกับบัญชีจริง"],
                    ["ล็อกอินบัญชี HERO", "จากนั้นพิมพ์สั่งทำคลิปได้เลย"],
                  ]} />
                  <p className="tested">กำลังทดสอบ</p>
                </div>
                <div className="panel" role="tabpanel" id="p-dev" aria-labelledby="t-dev" hidden>
                  <ol>
                    <li><div><b>สร้างโทเค็นส่วนตัว</b><p>ในแอปไปที่ Settings แท็บ AI Agent (MCP) กดสร้างโทเค็น และเพิกถอนได้ทุกเมื่อจากหน้าเดียวกัน</p></div></li>
                    <li><div><b>Claude Code</b><pre className="cmd">{`claude mcp add --transport http heroai ${MCP_URL} \\\n  --header "Authorization: Bearer <โทเค็นของคุณ>"`}</pre></div></li>
                    <li><div><b>Codex</b><pre className="cmd">{`export HEROAI_TOKEN="<โทเค็นของคุณ>"\ncodex mcp add heroai --url ${MCP_URL} \\\n  --bearer-token-env-var HEROAI_TOKEN`}</pre></div></li>
                    <li><div><b>OpenClaw, Hermes และตัวอื่น ๆ</b><p>หน้า Settings แท็บเดียวกันมีคำสั่งพร้อมโทเค็นของคุณให้คัดลอก</p></div></li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="sec-tight">
          <div className="wrap">
            <h2>ลองสั่งแบบนี้</h2>
            <p className="lede">คัดลอกไปวางในแชท แล้วเปลี่ยนเนื้อหาเป็นของคุณ</p>
            <div className="bubbles">
              {PROMPTS.map((p) => (
                <figure className="bub" key={p.tag}>
                  <blockquote>{p.q}</blockquote>
                  <figcaption><span>{p.tag}</span><button className="copy" type="button" data-copy="prev">คัดลอก</button></figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        <section className="sec-tight">
          <div className="wrap">
            <h2>อยากลงมือเองบนเว็บ ก็มีครบ</h2>
            <div className="tools">
              {TOOLS.map((t) => (
                <div key={t.title}><h3>{t.title}</h3>{t.tag && <em>{t.tag}</em>}<p>{t.desc}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="trust">
          <div className="wrap">
            <div>
              <h2><span className="nb">AI ทำงานแทน</span> <span className="nb">แต่คุณคุมทุกบาท</span></h2>
              <p className="lede">ตั้งใจออกแบบให้ AI สั่งงานได้เร็ว โดยไม่มีอะไรเกิดขึ้นลับหลังคุณ</p>
            </div>
            <ul>
              <li>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="8" width="14" height="10" rx="2" stroke="#c4b5fd" strokeWidth="1.6" /><path d="M6.5 8V6a3.5 3.5 0 0 1 7 0v2" stroke="#c4b5fd" strokeWidth="1.6" /></svg>
                <div><b>ล็อกอินบนหน้า HERO เท่านั้น</b><span>ไม่ต้องวางรหัสผ่านหรือคีย์ใด ๆ ลงในแชท และลบตัวเชื่อมต่อออกได้ทุกเมื่อ</span></div>
              </li>
              <li>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 3h12v14l-2-1.5L12 17l-2-1.5L8 17l-2-1.5L4 17V3Z" stroke="#c4b5fd" strokeWidth="1.6" strokeLinejoin="round" /><path d="M7 7.5h6M7 10.5h4" stroke="#c4b5fd" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <div><b>ทุกงานมีเพดานโควตา</b><span>ถ้างานไหนต้องใช้เกินที่ประเมินไว้ ระบบหยุดรอให้คุณยืนยันบนเว็บก่อน หรือขอให้ AI ประเมินค่าใช้จ่ายก่อนเริ่มก็ได้</span></div>
              </li>
              <li>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M13.5 3.5l3 3L7 16H4v-3l9.5-9.5Z" stroke="#c4b5fd" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                <div><b>แก้กี่รอบก็ไม่ตัดโควตาเพิ่ม</b><span>แก้ซับ เพลง ภาพ กี่รอบก็ได้ และส่งออกซ้ำก็ไม่ตัดโควตาเพิ่ม</span></div>
              </li>
              <li>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" stroke="#c4b5fd" strokeWidth="1.6" /><path d="M3 8h14" stroke="#c4b5fd" strokeWidth="1.6" /></svg>
                <div><b>ทุกคลิปอยู่ในบัญชีคุณ</b><span>คลิปที่ AI สั่งทำ เปิดดูและแก้ต่อบนเว็บได้เหมือนคลิปที่คุณทำเอง</span></div>
              </li>
            </ul>
          </div>
        </section>

        <section id="pricing" className="pricing">
          <div className="wrap">
            <h2>เลือกแผนที่เหมาะกับจำนวนคลิปของคุณ</h2>
            <p className="lede">AI ของคุณใช้โควตาเดียวกับแผน ไม่มีค่าเชื่อมต่อแยก ส่วนแผน Free ทำบนเว็บได้ แต่สั่งผ่าน AI ไม่ได้</p>
            <PricingToggle
              plans={plans}
              founding={founding}
              minuteQuotaEnabled={MINUTE_QUOTA}
              offered={{ PRO: offeredPro, BUSINESS: offeredBusiness }}
            />
          </div>
        </section>

        <section id="faq" className="sec-tight">
          <div className="wrap faq">
            <div><h2>คำถามที่พบบ่อย</h2></div>
            <div>
              <div className="tabs" role="tablist" aria-label="หมวดคำถาม">
                <button type="button" role="tab" aria-selected="true" aria-controls="f-general" id="ft-general">ทดลองและราคา</button>
                <button type="button" role="tab" aria-selected="false" aria-controls="f-agent" id="ft-agent" tabIndex={-1}>สั่งผ่าน AI</button>
              </div>
              <div className="panel" role="tabpanel" id="f-general" aria-labelledby="ft-general">
                {FAQ_GENERAL.map((f, i) => (
                  <details key={f.q} open={i === 0}><summary>{f.q}</summary><p>{f.a}</p></details>
                ))}
              </div>
              <div className="panel" role="tabpanel" id="f-agent" aria-labelledby="ft-agent" hidden>
                {FAQ_AGENT.map((f) => (
                  <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="final">
          <div className="wrap">
            <div className="box">
              <h2><span className="nb">คลิปถัดไปของคุณ</span> <span className="nb">เริ่มจากสคริปต์เดียว</span></h2>
              <div>
                <div className="cta-row"><Link className="btn btn-main" href="/register">{TRY}</Link></div>
                <p className="under">
                  <b>ไม่ต้องใช้บัตร</b> ครบ 7 วันกลับเป็น Free เอง
                  {founding?.active ? ` ราคาผู้ก่อตั้งเหลือ ${founding.remaining} ที่` : ""}
                </p>
              </div>
              <svg className="fwave" viewBox="0 0 255 40" preserveAspectRatio="none" aria-hidden="true"><path id="fwave" /></svg>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <span>© 2026 HERO AI Creator Studio</span>
          <a href="https://affiliate.heroaiengine.com/affiliate-program">ร่วมแนะนำ HERO AI รับค่าตอบแทน 25% ทุกเดือน</a>
          <Link href="/login">เข้าสู่ระบบ</Link>
        </div>
      </footer>

      <div className="mcta">
        <small>ไม่ต้อง<br />ใช้บัตร</small>
        <Link className="btn btn-main" href="/register">{TRY}</Link>
      </div>

      <PageBehaviors />
      <Script src="https://affiliate.heroaiengine.com/scripts/affiliate-tracking.js" strategy="afterInteractive" />
    </div>
  );
}
