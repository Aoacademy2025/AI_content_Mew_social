"use client";
import { Captions } from "lucide-react";

interface SceneCaption {
  text: string;
  startMs: number;
  endMs: number;
  tag?: "hook" | "cta" | "body";
}

interface Props {
  editedSceneCaptions: SceneCaption[];
  setEditedSceneCaptions: (v: SceneCaption[] | ((prev: SceneCaption[]) => SceneCaption[])) => void;
  activeCaptionIdx: number;
  onReset: () => void;
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSrt(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms2 = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms2).padStart(3,"0")}`;
}

export function SubtitleReviewPanel({ editedSceneCaptions, setEditedSceneCaptions, activeCaptionIdx, onReset }: Props) {
  return (
    <div className="rounded-2xl overflow-hidden flex flex-col" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
      <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--sv-border)" }}>
        <div className="flex items-center gap-2">
          <Captions className="h-3.5 w-3.5 text-cyan-400" />
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Subtitle Review</p>
          {editedSceneCaptions.length > 0 && (
            <span className="text-[9px] font-bold text-cyan-400/60">{editedSceneCaptions.length} ฉาก</span>
          )}
        </div>
        {editedSceneCaptions.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const srt = editedSceneCaptions.map((c, i) =>
                  `${i + 1}\n${fmtSrt(c.startMs)} --> ${fmtSrt(c.endMs)}\n${c.text}`
                ).join("\n\n");
                const blob = new Blob([srt], { type: "text/plain" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "subtitles.srt";
                a.click();
              }}
              className="text-[9px] font-bold text-white/30 hover:text-cyan-400 transition-colors px-1.5 py-0.5 rounded"
              style={{ background: "var(--sv-input)" }}>
              Export SRT
            </button>
            <button onClick={onReset} className="text-[9px] text-white/25 hover:text-white/50 transition-colors">
              reset
            </button>
          </div>
        )}
      </div>

      {editedSceneCaptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 py-10">
          <Captions className="h-8 w-8 text-white/8 mb-2" />
          <p className="text-xs text-white/18">Run pipeline first</p>
          <p className="text-[9px] text-white/10 mt-1">Subtitles appear here after Transcribe</p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-hidden">
            <div className="overflow-y-auto" style={{ maxHeight: "min(340px, 45vh)" }}>
              {editedSceneCaptions.map((cap, i) => {
                const isActive = i === activeCaptionIdx;
                const tag = cap.tag ?? "body";
                const tagCfg = {
                  hook: { label: "HOOK", bg: "hsl(38 100% 50% / 0.18)", color: "hsl(38 100% 65%)", border: "hsl(38 100% 50% / 0.4)", leftBorder: "hsl(38 100% 55%)" },
                  cta:  { label: "CTA",  bg: "hsl(142 72% 30% / 0.18)", color: "hsl(142 72% 60%)", border: "hsl(142 72% 40% / 0.4)", leftBorder: "hsl(142 72% 50%)" },
                  body: { label: "",     bg: "", color: "", border: "", leftBorder: "" },
                }[tag];
                return (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 transition-colors"
                    style={{
                      background: isActive
                        ? "hsl(190 100% 50% / 0.1)"
                        : tag === "hook" ? "hsl(38 100% 50% / 0.06)"
                        : tag === "cta"  ? "hsl(142 72% 30% / 0.06)"
                        : i % 2 === 0 ? "var(--sv-card)" : "var(--sv-bg)",
                      borderLeft: `2px solid ${isActive ? "hsl(190 100% 50% / 0.6)" : tag !== "body" ? tagCfg.leftBorder : "transparent"}`,
                    }}>
                    <span className={`text-[9px] font-bold shrink-0 w-4 ${isActive ? "text-cyan-400" : "text-cyan-500/50"}`}>{i + 1}</span>
                    <span className="text-[9px] font-mono shrink-0 w-9 text-white/25">{fmt(cap.startMs)}</span>
                    {tag !== "body" ? (
                      <button
                        onClick={() => setEditedSceneCaptions(prev => prev.map((c, j) => j === i ? { ...c, tag: "body" } : c))}
                        className="shrink-0 rounded px-1 py-0 text-[8px] font-black uppercase tracking-widest transition-all hover:text-white/30"
                        style={{ background: tagCfg.bg, color: tagCfg.color, border: `1px solid ${tagCfg.border}` }}
                        title="คลิกเพื่อเปลี่ยนเป็น body">
                        {tagCfg.label}
                      </button>
                    ) : (
                      <button
                        onClick={() => setEditedSceneCaptions(prev => prev.map((c, j) => j === i ? { ...c, tag: i === 0 ? "hook" : "cta" } : c))}
                        className="shrink-0 w-8 rounded px-1 py-0 text-[8px] text-white/15 hover:text-white/40 transition-colors"
                        title="คลิกเพื่อ tag เป็น hook หรือ cta">
                        ···
                      </button>
                    )}
                    <input
                      value={cap.text}
                      onChange={e => setEditedSceneCaptions(prev =>
                        prev.map((c, j) => j === i ? { ...c, text: e.target.value } : c)
                      )}
                      className="flex-1 text-[11px] font-semibold bg-transparent outline-none min-w-0"
                      style={{ caretColor: "hsl(190 100% 60%)", color: isActive ? "hsl(190 100% 75%)" : tag === "hook" ? "hsl(38 100% 80%)" : tag === "cta" ? "hsl(142 72% 75%)" : "rgba(255,255,255,0.8)" }}
                    />
                    <span className="text-[9px] font-mono shrink-0 w-9 text-right text-white/20">{fmt(cap.endMs)}</span>
                    <button
                      onClick={() => setEditedSceneCaptions(prev => prev.filter((_, j) => j !== i))}
                      className="shrink-0 text-white/15 hover:text-red-400 transition-colors text-[11px] leading-none">✕</button>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => {
                const last = editedSceneCaptions[editedSceneCaptions.length - 1];
                const startMs = last ? last.endMs + 100 : 0;
                setEditedSceneCaptions(prev => [...prev, { text: "", startMs, endMs: startMs + 2000 }]);
              }}
              className="w-full py-1.5 text-[9px] font-bold text-white/20 hover:text-cyan-400 transition-colors border-t"
              style={{ borderColor: "var(--sv-border)", background: "var(--sv-card)" }}>
              + เพิ่มซับ
            </button>
          </div>
        </>
      )}
    </div>
  );
}
