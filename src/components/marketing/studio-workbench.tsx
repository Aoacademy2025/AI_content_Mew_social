import Image from "next/image";
import {
  Captions,
  Check,
  FileText,
  Images,
  Mic2,
  Play,
  Sparkles,
  SwatchBook,
  WandSparkles,
} from "lucide-react";

const NAV = [
  { icon: FileText, label: "เขียนสคริปต์", active: true },
  { icon: SwatchBook, label: "คุมภาพตามแบรนด์" },
  { icon: WandSparkles, label: "ตัดต่อคลิป" },
  { icon: Images, label: "สร้างภาพและเสียง" },
];

const SCRIPT_LINES = [74, 91, 82, 58] as const;

function MobileWorkbench() {
  return (
    <div
      data-mobile-workbench
      className="overflow-hidden rounded-[24px] border border-white/12 bg-[#0d0c13] shadow-[0_28px_80px_-34px_rgba(5,3,13,.96)] sm:hidden"
    >
      <div className="flex h-12 items-center justify-between border-b border-white/[0.07] px-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-violet-500 text-[11px] font-black text-white shadow-[0_7px_18px_-8px_rgba(139,92,246,.9)]">H</span>
          <div>
            <p className="text-[11px] font-semibold text-white/82">คลิปของมิว</p>
            <p className="text-[10px] text-white/36">โปรเจกต์ 014</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-300/85">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> บันทึกแล้ว
        </span>
      </div>

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-violet-200">ขั้นที่ 3 จาก 4</span>
              <span className="rounded-full bg-white/[0.055] px-2 py-1 text-[10px] text-white/48">คลิป 60 วินาที</span>
            </div>
            <p className="mt-2 text-[16px] font-semibold leading-6 text-white">สคริปต์พร้อมตัดต่อ</p>
          </div>
          <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[12px] bg-violet-500 px-3 text-[11px] font-semibold text-white shadow-[0_14px_28px_-16px_rgba(139,92,246,.95)]">
            ตัดต่อคลิป <Play className="h-3 w-3 fill-current" strokeWidth={0} aria-hidden />
          </span>
        </div>

        <section
          data-mobile-hook-card
          className="mt-4 rounded-[18px] border border-violet-300/18 bg-[linear-gradient(145deg,rgba(139,92,246,.12),rgba(255,255,255,.025)_58%)] p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-violet-100/82">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden /> ประโยคเปิดที่ AI เลือกให้
            </span>
            <span className="text-[10px] text-white/38">แก้ไขได้</span>
          </div>
          <p data-mobile-primary-copy className="mt-3 text-[15px] font-semibold leading-[1.55] text-white">
            ถ้าคอนเทนต์คุณมีประโยชน์ แต่ไม่มีใครหยุดดู—ปัญหาอาจไม่ใช่เนื้อหา
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["เปิดด้วยปัญหาของคนดู", "ตรงกับแบรนด์", "ภาษาไทยธรรมชาติ"].map((chip) => (
              <span key={chip} className="rounded-full border border-violet-300/15 bg-violet-400/[0.07] px-2.5 py-1 text-[10px] text-violet-100/72">
                {chip}
              </span>
            ))}
          </div>
        </section>

        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_112px] items-start gap-3 min-[340px]:grid-cols-[minmax(0,1fr)_120px] min-[390px]:grid-cols-[minmax(0,1fr)_132px]">
          <div className="flex min-w-0 flex-col gap-3">
            <section className="flex-1 rounded-[16px] border border-white/[0.08] bg-[#121119] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-white/74">โครงสคริปต์</span>
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300/78">
                  <Check className="h-3 w-3" aria-hidden /> ครบแล้ว
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {SCRIPT_LINES.map((width, index) => (
                  <div key={width} className="flex items-center gap-2">
                    <span className="w-4 text-[10px] tabular-nums text-white/30">0{index + 1}</span>
                    <span className="h-1.5 rounded-full bg-white/[0.1]" style={{ width: `${width}%` }} />
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[10px] leading-4 text-white/38">เปิดเรื่อง · ให้เหตุผล · ยกตัวอย่าง · ชวนลงมือทำ</p>
            </section>

            <div className="grid gap-2">
              <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-white/42"><Mic2 className="h-3 w-3" aria-hidden /> เสียงพากย์</div>
                <p className="mt-1 text-[11px] font-medium text-white/76">เสียงมิว · เป็นธรรมชาติ</p>
              </div>
              <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-white/42"><SwatchBook className="h-3 w-3" aria-hidden /> แนวภาพ</div>
                <p className="mt-1 text-[11px] font-medium text-white/76">สมจริงแบบภาพยนตร์</p>
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <div data-mobile-preview className="relative aspect-[9/16] w-full overflow-hidden rounded-[20px] border border-white/10 bg-black shadow-[0_20px_48px_-24px_rgba(0,0,0,.9)]">
              <Image
                src="/showcase/showcase-1.jpg"
                alt="ตัวอย่างคลิปแนวตั้งที่ระบบประกอบให้"
                fill
                priority
                sizes="(max-width: 389px) 120px, 132px"
                className="object-cover"
              />
              <span className="absolute inset-0 bg-gradient-to-b from-black/48 via-transparent to-black/72" aria-hidden />
              <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/58 px-2 py-1 text-[10px] text-white/80 backdrop-blur-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" /> ตัวอย่างคลิป
              </span>
              <div className="absolute inset-x-2.5 top-[31%] text-center">
                <span className="inline box-decoration-clone bg-white px-1 py-0.5 text-[10px] font-black leading-[1.7] text-[#18131f] shadow-[2px_2px_0_#8b5cf6]">
                  ความรู้แน่น แต่คนไม่หยุดดู
                </span>
              </div>
              <span className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-violet-500/94 text-white shadow-[0_10px_30px_rgba(139,92,246,.48)]" aria-hidden>
                <Play className="ml-0.5 h-4 w-4 fill-current" strokeWidth={0} />
              </span>
              <div className="absolute inset-x-2.5 bottom-2.5 rounded-[11px] bg-black/72 px-2.5 py-2 backdrop-blur-sm">
                <div className="flex items-center justify-between gap-1 text-[10px] text-white/62">
                  <span className="inline-flex items-center gap-1"><Captions className="h-3 w-3" aria-hidden /> ซับตรงเสียง</span>
                  <span className="hidden min-[390px]:inline">0:42 / 0:58</span>
                </div>
                <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/16"><span className="block h-full w-[72%] bg-violet-400" /></div>
              </div>
            </div>
            <div className="rounded-[13px] border border-emerald-300/12 bg-emerald-300/[0.045] px-2.5 py-2.5">
              <p className="inline-flex items-center gap-1.5 text-[10px] font-medium text-emerald-200/80"><Check className="h-3 w-3" aria-hidden /> พร้อมตรวจและโพสต์</p>
              <p className="mt-1 text-[10px] text-white/38">แนวตั้ง 9:16 · 58 วินาที</p>
            </div>
          </div>
        </div>

        <div className="relative mt-3 overflow-hidden rounded-[14px] border border-white/[0.07] bg-[#09080e] p-3">
          <div className="mb-2.5 flex items-center justify-between text-[10px] text-white/38">
            <span>ลำดับภาพ เสียง และซับ</span><span>58 วินาที</span>
          </div>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[17%_21%_13%_29%_16%] gap-1">
              {['bg-violet-500/55', 'bg-violet-400/32', 'bg-violet-500/42', 'bg-violet-300/28', 'bg-violet-500/38'].map((color, index) => (
                <span key={`${color}-${index}`} className={`h-2 rounded-[3px] ${color}`} />
              ))}
            </div>
            <div className="grid grid-cols-[32%_18%_25%_21%] gap-1">
              {['bg-amber-300/22', 'bg-amber-300/30', 'bg-amber-300/18', 'bg-amber-300/28'].map((color, index) => (
                <span key={`${color}-${index}`} className={`h-1.5 rounded-[3px] ${color}`} />
              ))}
            </div>
          </div>
          <span className="sale-v2-playhead absolute bottom-0 top-0 w-px bg-violet-300/80" aria-hidden />
        </div>
      </div>
    </div>
  );
}

function DesktopWorkbench() {
  return (
    <div className="hidden overflow-hidden rounded-[26px] border border-white/12 bg-[#0d0c13] shadow-[0_36px_100px_-36px_rgba(5,3,13,.95)] sm:block">
      <div className="flex h-11 items-center justify-between border-b border-white/[0.07] px-5">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-violet-400/70" />
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-white/42">HERO AI · โปรเจกต์ 014</div>
        <div className="flex items-center gap-1.5 text-[10px] text-emerald-300/85"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> บันทึกแล้ว</div>
      </div>

      <div className="grid min-h-[520px] grid-cols-[156px_1fr]">
        <aside className="border-r border-white/[0.07] bg-[#0a0910] px-3 py-4">
          <div className="mb-6 flex items-center gap-2 px-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-violet-500 text-[11px] font-black text-white">H</div>
            <span className="text-[11px] font-bold text-white/80">เครื่องมือสร้างคลิป</span>
          </div>
          <div className="space-y-1">
            {NAV.map(({ icon: Icon, label, active }) => (
              <div key={label} className={`flex min-h-9 items-center gap-2 rounded-[10px] px-2 text-[10.5px] ${active ? "bg-violet-500/13 text-violet-200" : "text-white/38"}`}>
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="min-w-0 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-violet-300">ขั้นที่ 3 จาก 4</span>
                <span className="rounded-full bg-white/[0.055] px-2 py-0.5 text-[9px] text-white/42">คลิป 60 วินาที</span>
              </div>
              <p className="mt-1 text-base font-semibold text-white">สคริปต์: ความรู้แน่น แต่คนไม่หยุดดู</p>
            </div>
            <div aria-hidden className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-violet-500 px-3 text-[10.5px] font-semibold text-white">
              ตัดต่อคลิป <Play className="h-3 w-3 fill-current" strokeWidth={0} aria-hidden />
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_156px] items-start gap-3 lg:grid-cols-[1.08fr_.72fr]">
            <div className="space-y-3">
              <section className="rounded-[16px] border border-white/[0.08] bg-[#121119] p-3.5">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[10.5px] font-semibold text-white/75"><Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden /> ประโยคเปิดที่ AI เลือกให้</div>
                  <span className="text-[9px] text-white/32">แก้ไขได้</span>
                </div>
                <p className="max-w-[34ch] text-[17px] font-semibold leading-[1.42] text-white lg:text-[20px]">ถ้าคอนเทนต์คุณมีประโยชน์ แต่ไม่มีใครหยุดดู—ปัญหาอาจไม่ใช่เนื้อหา</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {["เปิดด้วยปัญหาของคนดู", "ตรงกับแบรนด์", "ภาษาไทยธรรมชาติ"].map((chip) => (
                    <span key={chip} className="rounded-full border border-violet-300/15 bg-violet-400/[0.07] px-2 py-1 text-[8.5px] text-violet-200/75">{chip}</span>
                  ))}
                </div>
              </section>

              <section className="rounded-[16px] border border-white/[0.08] bg-[#121119] p-3.5">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[10.5px] font-semibold text-white/72">โครงสคริปต์</span>
                  <span className="inline-flex items-center gap-1 text-[9px] text-emerald-300/75"><Check className="h-3 w-3" /> ครบ 4 ส่วน</span>
                </div>
                <div className="space-y-2">
                  {SCRIPT_LINES.map((width, index) => (
                    <div key={width} className="flex items-center gap-2"><span className="w-4 text-[8px] tabular-nums text-white/24">0{index + 1}</span><span className="h-1.5 rounded-full bg-white/[0.08]" style={{ width: `${width}%` }} /></div>
                  ))}
                </div>
              </section>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] p-2.5"><div className="flex items-center gap-1.5 text-[9px] text-white/38"><Mic2 className="h-3 w-3" /> เสียงพากย์</div><p className="mt-1 text-[10px] font-medium text-white/75">เสียงมิว · เป็นธรรมชาติ</p></div>
                <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] p-2.5"><div className="flex items-center gap-1.5 text-[9px] text-white/38"><SwatchBook className="h-3 w-3" /> แนวภาพ</div><p className="mt-1 text-[10px] font-medium text-white/75">สมจริงแบบภาพยนตร์</p></div>
              </div>
            </div>

            <div className="relative mx-auto w-full lg:max-w-none">
              <div className="relative aspect-[9/16] overflow-hidden rounded-[19px] border border-white/10 bg-black">
                <Image src="/showcase/showcase-1.jpg" alt="ตัวอย่างคลิปแนวตั้งที่ระบบประกอบให้" fill priority sizes="220px" className="object-cover" />
                <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent" aria-hidden />
                <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 text-[8px] text-white/80"><span className="h-1.5 w-1.5 rounded-full bg-violet-400" /> ตัวอย่างคลิป</div>
                <div className="absolute inset-x-3 top-[30%] text-center"><span className="inline box-decoration-clone bg-white px-1 py-0.5 text-[9px] font-black leading-[1.65] text-[#18131f] shadow-[2px_2px_0_#8b5cf6] lg:px-1.5 lg:text-[11px] lg:shadow-[3px_3px_0_#8b5cf6]">ความรู้แน่นมาก แต่คนไม่หยุดดู</span></div>
                <span aria-hidden className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-violet-500/90 text-white shadow-lg lg:h-10 lg:w-10"><Play className="ml-0.5 h-4 w-4 fill-current" strokeWidth={0} /></span>
                <div className="absolute inset-x-3 bottom-3 rounded-[10px] bg-black/72 px-2.5 py-2">
                  <div className="flex items-center justify-between text-[8px] text-white/55"><span className="inline-flex items-center gap-1"><Captions className="h-2.5 w-2.5" /> ซับตรงเสียง</span><span>00:42 / 00:58</span></div>
                  <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/15"><span className="block h-full w-[72%] bg-violet-400" /></div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative mt-3 overflow-hidden rounded-[14px] border border-white/[0.07] bg-[#09080e] p-2.5">
            <div className="mb-2 flex items-center justify-between text-[8px] tracking-[.08em] text-white/28"><span>ลำดับภาพ เสียง และซับ</span><span>58.4 วินาที</span></div>
            <div className="space-y-1.5">
              <div className="grid grid-cols-[17%_21%_13%_29%_16%] gap-1">{['bg-violet-500/55', 'bg-violet-400/32', 'bg-violet-500/42', 'bg-violet-300/28', 'bg-violet-500/38'].map((color, index) => <span key={`${color}-${index}`} className={`h-2 rounded-[3px] ${color}`} />)}</div>
              <div className="grid grid-cols-[32%_18%_25%_21%] gap-1">{['bg-amber-300/22', 'bg-amber-300/30', 'bg-amber-300/18', 'bg-amber-300/28'].map((color, index) => <span key={`${color}-${index}`} className={`h-1.5 rounded-[3px] ${color}`} />)}</div>
            </div>
            <span className="sale-v2-playhead absolute bottom-0 top-0 w-px bg-violet-300/80" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}

export function StudioWorkbench() {
  return (
    <div data-hero-workbench className="relative isolate mx-auto w-full max-w-[760px]">
      <div aria-hidden className="absolute -inset-8 -z-10 rounded-[42px] opacity-60 blur-3xl" style={{ background: "radial-gradient(circle at 50% 35%, oklch(62% .19 292 / .34), transparent 68%)" }} />
      <MobileWorkbench />
      <DesktopWorkbench />
      <div className="mt-3 hidden grid-cols-2 gap-2 sm:grid">
        <div className="flex min-h-11 items-center gap-2 rounded-[12px] border border-violet-300/12 bg-[#121018] px-3 text-[10px] text-violet-100/80"><Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden /><span>ข้อมูลแบรนด์เชื่อมครบทุกขั้น</span></div>
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-[12px] border border-white/[0.07] bg-[#100e15] px-3"><span className="text-[8px] font-semibold tracking-[.1em] text-white/30">แนวภาพ</span><span className="text-[10px] font-semibold text-white/75">สมจริงแบบภาพยนตร์</span></div>
      </div>
    </div>
  );
}
