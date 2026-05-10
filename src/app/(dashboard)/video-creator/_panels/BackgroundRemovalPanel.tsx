"use client";
import { Wand2 } from "lucide-react";

interface Props {
  chromaSimilarity: number;
  setChromaSimilarity: (v: number) => void;
  chromaBlend: number;
  setChromaBlend: (v: number) => void;
}

export function BackgroundRemovalPanel({ chromaSimilarity, setChromaSimilarity, chromaBlend, setChromaBlend }: Props) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid hsl(120 60% 40% / 0.2)" }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid hsl(120 60% 40% / 0.12)" }}>
        <div className="flex items-center gap-2">
          <Wand2 className="h-3.5 w-3.5 text-green-400/70" />
          <p className="text-[10px] font-bold uppercase tracking-widest text-green-400/60">Background Removal</p>
        </div>
        <span className="text-[9px] text-white/25">Adjust before Composite</span>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/35 w-20 shrink-0">Green Color</span>
          <div className="flex items-center gap-2 rounded px-2.5 py-1" style={{ background: "var(--sv-input)", border: "1px solid hsl(120 60% 40% / 0.3)" }}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: "#00FF00" }} />
            <span className="text-[10px] font-mono text-green-400">#00FF00</span>
            <span className="text-[9px] text-white/25">— HeyGen API</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/35 w-20 shrink-0">Similarity</span>
            <input type="range" min={0.10} max={0.55} step={0.01} value={chromaSimilarity}
              onChange={e => setChromaSimilarity(Number(e.target.value))}
              className="flex-1 accent-green-400 h-1" />
            <span className="text-[10px] font-mono text-green-400 w-8 text-right">{chromaSimilarity.toFixed(2)}</span>
          </div>
          <p className="text-[9px] text-white/20 pl-[88px]">Green still visible → increase &nbsp;|&nbsp; Skin/clothes removed → decrease</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/35 w-20 shrink-0">Blend</span>
            <input type="range" min={0.00} max={0.20} step={0.01} value={chromaBlend}
              onChange={e => setChromaBlend(Number(e.target.value))}
              className="flex-1 accent-green-400 h-1" />
            <span className="text-[10px] font-mono text-green-400 w-8 text-right">{chromaBlend.toFixed(2)}</span>
          </div>
          <p className="text-[9px] text-white/20 pl-[88px]">Jagged/hard edge → increase &nbsp;|&nbsp; Transparent/soft edge → decrease</p>
        </div>
      </div>
    </div>
  );
}
