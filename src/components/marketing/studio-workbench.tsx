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
  { icon: FileText, label: "Hero Script", active: true },
  { icon: SwatchBook, label: "Brand Visual" },
  { icon: WandSparkles, label: "Video Editor" },
  { icon: Images, label: "AI Studio" },
];

export function StudioWorkbench() {
  return (
    <div data-hero-workbench className="relative isolate mx-auto w-full max-w-[760px]">
      <div
        aria-hidden
        className="absolute -inset-8 -z-10 rounded-[42px] opacity-60 blur-3xl"
        style={{ background: "radial-gradient(circle at 50% 35%, oklch(62% .19 292 / .34), transparent 68%)" }}
      />

      <div className="overflow-hidden rounded-[22px] border border-white/12 bg-[#0d0c13] shadow-[0_36px_100px_-36px_rgba(5,3,13,.95)] sm:rounded-[26px]">
        <div className="flex h-11 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-white/15" />
            <span className="h-2 w-2 rounded-full bg-white/15" />
            <span className="h-2 w-2 rounded-full bg-violet-400/70" />
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-white/42">
            HERO AI · PROJECT 014
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-300/85">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            บันทึกแล้ว
          </div>
        </div>

        <div className="grid min-h-[470px] grid-cols-1 sm:min-h-[520px] sm:grid-cols-[156px_1fr]">
          <aside className="hidden border-r border-white/[0.07] bg-[#0a0910] px-3 py-4 sm:block">
            <div className="mb-6 flex items-center justify-center gap-2 sm:justify-start sm:px-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-violet-500 text-[11px] font-black text-white">
                H
              </div>
              <span className="hidden text-[11px] font-bold text-white/80 sm:block">CREATOR STUDIO</span>
            </div>
            <div className="space-y-1">
              {NAV.map(({ icon: Icon, label, active }) => (
                <div
                  key={label}
                  className={`flex min-h-9 items-center justify-center gap-2 rounded-[10px] px-2 text-[10.5px] sm:justify-start ${
                    active ? "bg-violet-500/13 text-violet-200" : "text-white/38"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="hidden sm:block">{label}</span>
                </div>
              ))}
            </div>
          </aside>

          <div className="min-w-0 p-3.5 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold text-violet-300">STEP 03 / 04</span>
                  <span className="rounded-full bg-white/[0.055] px-2 py-0.5 text-[9px] text-white/42">60 วินาที</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-white sm:text-base">สคริปต์: ความรู้แน่น แต่คนไม่หยุดดู</p>
              </div>
              <div
                aria-hidden
                className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-violet-500 px-2.5 text-[9px] font-semibold text-white sm:px-3 sm:text-[10.5px]"
              >
                ส่งไปตัดต่อ <Play className="h-3 w-3 fill-current" strokeWidth={0} aria-hidden />
              </div>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_106px] items-start gap-2.5 sm:grid-cols-[minmax(0,1fr)_156px] sm:gap-3 lg:grid-cols-[1.08fr_.72fr]">
              <div className="space-y-3">
                <section className="rounded-[14px] border border-white/[0.08] bg-[#121119] p-3 sm:rounded-[16px] sm:p-3.5">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-[10.5px] font-semibold text-white/75">
                      <Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden />
                      Hook ที่เลือก
                    </div>
                    <span className="text-[9px] text-white/32">แก้ไขได้</span>
                  </div>
                  <p className="max-w-[34ch] text-[13px] font-semibold leading-[1.42] text-white sm:text-[17px] lg:text-[20px]">
                    ถ้าคอนเทนต์คุณมีประโยชน์ แต่ไม่มีใครหยุดดู—ปัญหาอาจไม่ใช่เนื้อหา
                  </p>
                  <div className="mt-3 hidden flex-wrap gap-1.5 min-[360px]:flex">
                    {['เปิดด้วย Pain', 'ตรงแบรนด์', 'ภาษาไทยธรรมชาติ'].map((chip) => (
                      <span key={chip} className="rounded-full border border-violet-300/15 bg-violet-400/[0.07] px-2 py-1 text-[8.5px] text-violet-200/75">
                        {chip}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="rounded-[14px] border border-white/[0.08] bg-[#121119] p-3 sm:rounded-[16px] sm:p-3.5">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-[10.5px] font-semibold text-white/72">โครงสคริปต์</span>
                    <span className="inline-flex items-center gap-1 text-[9px] text-emerald-300/75"><Check className="h-3 w-3" /> ครบ 4 ส่วน</span>
                  </div>
                  <div className="space-y-2">
                    {[74, 91, 82, 58].map((width, index) => (
                      <div key={width} className="flex items-center gap-2">
                        <span className="w-4 text-[8px] tabular-nums text-white/24">0{index + 1}</span>
                        <span className="h-1.5 rounded-full bg-white/[0.08]" style={{ width: `${width}%` }} />
                      </div>
                    ))}
                  </div>
                </section>

                <div className="hidden grid-cols-2 gap-2 min-[360px]:grid">
                  <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] p-2.5">
                    <div className="flex items-center gap-1.5 text-[9px] text-white/38"><Mic2 className="h-3 w-3" /> เสียง</div>
                    <p className="mt-1 text-[10px] font-medium text-white/75">Hero Voice · Mew 01</p>
                  </div>
                  <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.025] p-2.5">
                    <div className="flex items-center gap-1.5 text-[9px] text-white/38"><SwatchBook className="h-3 w-3" /> แบรนด์</div>
                    <p className="mt-1 text-[10px] font-medium text-white/75">Mewsocial Real · v3</p>
                  </div>
                </div>
              </div>

              <div className="relative mx-auto w-full lg:max-w-none">
                <div className="relative aspect-[9/16] overflow-hidden rounded-[19px] border border-white/10 bg-black">
                  <Image
                    src="/showcase/showcase-1.jpg"
                    alt="ตัวอย่างคลิปแนวตั้งที่สร้างด้วย HERO AI"
                    fill
                    priority
                    sizes="(max-width: 359px) 106px, (max-width: 639px) 156px, 220px"
                    className="object-cover"
                  />
                  <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent" aria-hidden />
                  <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 text-[8px] text-white/80">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-400" /> PREVIEW
                  </div>
                  <div className="absolute inset-x-3 top-[30%] text-center">
                    <span className="inline box-decoration-clone bg-white px-1 py-0.5 text-[7px] font-black leading-[1.65] text-[#18131f] shadow-[2px_2px_0_#8b5cf6] sm:text-[9px] lg:px-1.5 lg:text-[11px] lg:shadow-[3px_3px_0_#8b5cf6]">
                      ความรู้แน่นมาก แต่คนไม่หยุดดู
                    </span>
                  </div>
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-violet-500/90 text-white shadow-lg sm:h-9 sm:w-9 lg:h-10 lg:w-10"
                  >
                    <Play className="ml-0.5 h-4 w-4 fill-current" strokeWidth={0} />
                  </span>
                  <div className="absolute inset-x-3 bottom-3 rounded-[10px] bg-black/72 px-2.5 py-2">
                    <div className="flex items-center justify-between text-[8px] text-white/55">
                      <span className="inline-flex items-center gap-1"><Captions className="h-2.5 w-2.5" /> ซับตรงเสียง</span>
                      <span>00:42 / 00:58</span>
                    </div>
                    <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/15">
                      <span className="block h-full w-[72%] bg-violet-400" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative mt-3 overflow-hidden rounded-[14px] border border-white/[0.07] bg-[#09080e] p-2.5">
              <div className="mb-2 flex items-center justify-between text-[8px] uppercase tracking-[.12em] text-white/28">
                <span>Timeline</span><span>58.4 SEC</span>
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
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="flex min-h-11 items-center gap-2 rounded-[12px] border border-violet-300/12 bg-[#121018] px-3 text-[10px] text-violet-100/80">
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
          <span><span className="hidden min-[360px]:inline">Brand context </span>เชื่อมครบทุกขั้น</span>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-[12px] border border-white/[0.07] bg-[#100e15] px-3">
          <span className="hidden text-[8px] font-semibold uppercase tracking-[.14em] text-white/30 min-[360px]:inline">Visual format</span>
          <span className="text-[10px] font-semibold text-white/75">Cinematic Realism</span>
        </div>
      </div>
    </div>
  );
}
