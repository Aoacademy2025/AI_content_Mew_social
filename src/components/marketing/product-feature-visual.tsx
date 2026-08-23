import Image from "next/image";
import {
  ArrowRight,
  Captions,
  Check,
  FileText,
  Images,
  Mic2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

export type ProductFeatureId = "script" | "visual" | "editor" | "studio";

function SceneHeader({ label, step }: { label: string; step: string }) {
  return (
    <div className="flex h-12 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
      <div className="flex items-center gap-2.5">
        <span className="sale-v2-live-dot h-2 w-2 rounded-full bg-violet-400" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-white/64">{label}</span>
      </div>
      <span className="font-mono text-[9px] tracking-[.12em] text-white/30">{step}</span>
    </div>
  );
}

function ScriptScene() {
  return (
    <div data-product-visual="script" className="sale-v2-product-scene relative min-h-[410px] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#09080e]">
      <SceneHeader label="HERO SCRIPT · NEW PROJECT" step="STEP 02 / 04" />
      <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[.9fr_1.1fr]">
        <div>
          <p className="mb-2 text-[9px] font-medium uppercase tracking-[.14em] text-white/32">เริ่มจากหัวข้อเดียว</p>
          <div className="rounded-[14px] border border-violet-300/18 bg-violet-400/[0.07] px-3.5 py-3 text-[13px] font-medium text-white/82">
            ทำไมคอนเทนต์มีประโยชน์ แต่ไม่มีคนหยุดดู?
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-white/66">Hook candidates</span>
            <span className="inline-flex items-center gap-1 text-[9px] text-violet-200/70"><Sparkles className="h-3 w-3" /> AI วิเคราะห์แล้ว</span>
          </div>
          <div className="mt-2.5 space-y-2">
            {[
              ["01", "คุณไม่ได้ขาดไอเดีย—คุณขาดประโยคแรกที่ใช่"],
              ["02", "ถ้าคนไม่หยุดดู ปัญหาอาจไม่ใช่เนื้อหา"],
              ["03", "คอนเทนต์ดีแค่ไหน ถ้าเปิดเรื่องช้าก็จบ"],
            ].map(([n, copy], index) => (
              <div key={n} className={`flex gap-2.5 rounded-[12px] border px-3 py-2.5 ${index === 1 ? "border-violet-300/30 bg-violet-400/[0.11] text-white" : "border-white/[0.07] bg-white/[0.02] text-white/46"}`}>
                <span className="font-mono text-[8px] text-violet-300/70">{n}</span>
                <span className="text-[10.5px] leading-4">{copy}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-[16px] border border-white/[0.08] bg-[#111019] p-4">
          <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold text-white/72"><FileText className="h-3.5 w-3.5 text-violet-300" /> สคริปต์ฉบับพร้อมใช้</span>
            <span className="rounded-full bg-emerald-400/[0.08] px-2 py-1 text-[8px] text-emerald-300">ครบ 4 ส่วน</span>
          </div>
          <p className="mt-4 text-[16px] font-semibold leading-[1.45] text-white">ถ้าคอนเทนต์คุณมีประโยชน์ แต่ไม่มีใครหยุดดู—ปัญหาอาจไม่ใช่เนื้อหา</p>
          <div className="mt-5 space-y-3">
            {[92, 72, 86, 58, 77].map((width, index) => (
              <div key={`${width}-${index}`} className="flex items-center gap-2.5">
                <span className="w-4 font-mono text-[8px] text-white/22">0{index + 1}</span>
                <span className="h-1.5 rounded-full bg-white/[0.09]" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between rounded-[12px] border border-violet-300/14 bg-violet-400/[0.06] px-3 py-2.5">
            <span className="text-[9px] text-violet-100/68">Brand tone · Mewsocial Real</span>
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-white">ส่งไป Editor <ArrowRight className="h-3 w-3" /></span>
          </div>
        </div>
      </div>
      <span className="sale-v2-scene-scan" aria-hidden />
    </div>
  );
}

function VisualScene() {
  const formats = [
    ["/brand-visual-formats/cinematic-realism.webp", "Cinematic Realism"],
    ["/brand-visual-formats/simple-editorial-story.webp", "Editorial Story"],
    ["/brand-visual-formats/dramatic-comic.webp", "Dramatic Comic"],
  ] as const;
  return (
    <div data-product-visual="visual" className="sale-v2-product-scene relative min-h-[430px] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#09080e]">
      <SceneHeader label="BRAND VISUAL · SCENE DIRECTION" step="3 FORMATS / 1 BRAND" />
      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-[1.18fr_.82fr] gap-3">
          <div className="group relative min-h-[286px] overflow-hidden rounded-[16px] border border-violet-300/25 bg-[#15121b]">
            <Image src={formats[0][0]} alt="ตัวอย่างภาพแบบ Cinematic Realism" fill sizes="(max-width: 768px) 60vw, 400px" className="object-cover transition duration-700 group-hover:scale-[1.03]" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/5 to-black/20" aria-hidden />
            <div className="absolute inset-x-4 bottom-4">
              <p className="text-[9px] uppercase tracking-[.13em] text-violet-200/75">Selected format</p>
              <p className="mt-1 text-[14px] font-semibold text-white">{formats[0][1]}</p>
            </div>
            <span className="absolute right-3 top-3 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[8px] text-white/72 backdrop-blur-md">ACTIVE</span>
          </div>
          <div className="grid gap-3">
            {formats.slice(1).map(([src, label], index) => (
              <div key={src} className="group relative min-h-[137px] overflow-hidden rounded-[14px] border border-white/[0.09] bg-[#15121b]">
                <Image src={src} alt={`ตัวอย่างภาพแบบ ${label}`} fill sizes="(max-width: 768px) 40vw, 240px" className="object-cover opacity-70 transition duration-700 group-hover:scale-[1.035] group-hover:opacity-100" />
                <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" aria-hidden />
                <p className="absolute inset-x-3 bottom-3 text-[10px] font-medium text-white/78">0{index + 2} · {label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <div className="flex items-center gap-3 rounded-[13px] border border-white/[0.07] bg-white/[0.025] px-3.5 py-3">
            <SlidersHorizontal className="h-3.5 w-3.5 text-violet-300" />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between text-[8.5px] text-white/46"><span>Brand consistency</span><span>92%</span></div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.08]"><span className="block h-full w-[92%] rounded-full bg-violet-400" /></div>
            </div>
          </div>
          <div className="flex items-center justify-center gap-1.5 rounded-[13px] border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-[9px] text-white/65"><RefreshCw className="h-3 w-3" /> Reroll เฉพาะซีน</div>
        </div>
      </div>
    </div>
  );
}

function EditorScene() {
  const controls = [
    { icon: Captions, label: "Caption", value: "AUTO" },
    { icon: Images, label: "B-roll", value: "12" },
    { icon: Mic2, label: "Voice", value: "MEW 01" },
  ];
  const tracks = [
    { label: "VIDEO", widths: [19, 26, 13, 32], color: "bg-violet-400/35" },
    { label: "B-ROLL", widths: [29, 18, 22, 17], color: "bg-violet-400/35" },
    { label: "AUDIO", widths: [38, 24, 28], color: "bg-amber-300/24" },
    { label: "CAPTION", widths: [14, 21, 18, 27], color: "bg-cyan-300/20" },
  ];
  return (
    <div data-product-visual="editor" className="sale-v2-product-scene relative min-h-[430px] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#09080e]">
      <SceneHeader label="VIDEO EDITOR · PROJECT 014" step="00:42 / 00:58" />
      <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[172px_1fr]">
        <div className="relative mx-auto aspect-[9/16] w-full max-w-[172px] overflow-hidden rounded-[16px] border border-white/10 bg-black">
          <Image src="/showcase/showcase-1.jpg" alt="ตัวอย่างคลิปใน Video Editor" fill sizes="172px" className="object-cover" />
          <span className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/65" aria-hidden />
          <div className="absolute inset-x-3 top-[27%] text-center"><span className="inline box-decoration-clone bg-white px-1 py-0.5 text-[9px] font-black leading-[1.7] text-[#18131f] shadow-[2px_2px_0_#8b5cf6]">ปัญหาอาจไม่ใช่เนื้อหา</span></div>
          <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-violet-500 text-white shadow-[0_8px_30px_rgba(139,92,246,.5)]"><Play className="ml-0.5 h-3.5 w-3.5 fill-current" strokeWidth={0} /></span>
          <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[7.5px] text-white/70"><Captions className="h-2.5 w-2.5" /> ซับตรงเสียง</span>
        </div>
        <div className="min-w-0">
          <div className="grid grid-cols-3 gap-2">
            {controls.map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-[12px] border border-white/[0.07] bg-white/[0.025] p-2.5"><Icon className="h-3.5 w-3.5 text-violet-300" /><p className="mt-2 text-[8px] text-white/34">{label}</p><p className="mt-0.5 text-[9px] font-semibold text-white/74">{value}</p></div>
            ))}
          </div>
          <div className="mt-3 rounded-[14px] border border-white/[0.08] bg-[#111019] p-3">
            <div className="flex items-center justify-between text-[8px] uppercase tracking-[.12em] text-white/30"><span>Timeline</span><span>58.4 SEC</span></div>
            <div className="relative mt-4 space-y-2.5 overflow-hidden pb-2">
              {tracks.map(({ label, widths, color }, row) => (
                <div key={label} className="grid grid-cols-[44px_1fr] items-center gap-2">
                  <span className="font-mono text-[7px] text-white/25">{label}</span>
                  <div className="flex gap-1">
                    {widths.map((width, index) => <span key={`${row}-${index}`} className={`h-3 rounded-[3px] ${color}`} style={{ width: `${width}%` }} />)}
                  </div>
                </div>
              ))}
              <span className="sale-v2-playhead absolute bottom-0 top-0 w-px bg-violet-200/90" aria-hidden />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[12px] border border-violet-300/14 bg-violet-400/[0.06] px-3 py-2.5 text-[9px] text-white/62"><span>AutoMix ประกอบร่างแรกแล้ว</span><span className="font-semibold text-violet-100">คุณคุมจังหวะต่อ</span></div>
        </div>
      </div>
    </div>
  );
}

function StudioScene() {
  const wave = [28, 54, 82, 42, 68, 36, 88, 62, 32, 72, 48, 92, 58, 38, 74, 46, 84, 52, 26, 64];
  return (
    <div data-product-visual="studio" className="sale-v2-product-scene relative min-h-[430px] overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#09080e]">
      <SceneHeader label="AI STUDIO · CREATIVE LIBRARY" step="SYNCED TO PROJECT" />
      <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-[1.08fr_.92fr]">
        <div>
          <div className="grid h-[275px] grid-cols-[1.25fr_.75fr] gap-2.5">
            <div className="group relative row-span-2 overflow-hidden rounded-[16px] border border-violet-300/18 bg-[#15121b]">
              <Image src="/brand-visual-formats/cinematic-realism.webp" alt="Hero AI Image พร้อมใช้ในโปรเจกต์" fill sizes="(max-width: 768px) 60vw, 320px" className="object-cover transition duration-700 group-hover:scale-[1.03]" />
              <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" aria-hidden />
              <span className="absolute bottom-3 left-3 text-[9px] font-semibold text-white">Hero Image · 01</span>
            </div>
            {["/brand-visual-formats/simple-editorial-story.webp", "/brand-visual-formats/retro-story.webp"].map((src, index) => (
              <div key={src} className="group relative overflow-hidden rounded-[13px] border border-white/[0.08] bg-[#15121b]">
                <Image src={src} alt={`Hero AI Image ตัวอย่าง ${index + 2}`} fill sizes="160px" className="object-cover opacity-70 transition duration-700 group-hover:scale-[1.04] group-hover:opacity-100" />
                <span className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent" aria-hidden />
                <span className="absolute bottom-2 left-2 font-mono text-[7px] text-white/58">0{index + 2}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 inline-flex items-center gap-1.5 text-[9px] text-emerald-300/75"><Check className="h-3 w-3" /> บันทึกเข้า Brand Library แล้ว</p>
        </div>
        <div className="rounded-[16px] border border-white/[0.08] bg-[#111019] p-4">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-violet-400/[0.12] text-violet-200"><Mic2 className="h-4 w-4" /></span>
            <span className="sale-v2-live-dot rounded-full bg-emerald-400/10 px-2 py-1 text-[7.5px] text-emerald-300">VOICE READY</span>
          </div>
          <p className="mt-5 text-[9px] uppercase tracking-[.13em] text-white/34">Hero Voice</p>
          <p className="mt-1 text-[15px] font-semibold text-white">Mew 01 · Natural Thai</p>
          <div className="mt-6 flex h-20 items-center justify-center gap-[3px] overflow-hidden rounded-[12px] border border-white/[0.06] bg-black/20 px-3">
            {wave.map((height, index) => <span key={`${height}-${index}`} className="sale-v2-wavebar w-1 rounded-full bg-violet-300/65" style={{ height: `${height}%`, animationDelay: `${index * -0.07}s` }} />)}
          </div>
          <button type="button" className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-[11px] bg-violet-500 text-[10px] font-semibold text-white shadow-[0_12px_30px_-15px_rgba(139,92,246,.9)]"><Play className="h-3 w-3 fill-current" strokeWidth={0} /> ฟังตัวอย่างเสียง</button>
          <p className="mt-3 text-center text-[8px] text-white/32">ส่งภาพ + เสียงกลับเข้าโปรเจกต์ได้ทันที</p>
        </div>
      </div>
    </div>
  );
}

export function ProductFeatureVisual({ id }: { id: ProductFeatureId }) {
  if (id === "script") return <ScriptScene />;
  if (id === "visual") return <VisualScene />;
  if (id === "editor") return <EditorScene />;
  return <StudioScene />;
}
