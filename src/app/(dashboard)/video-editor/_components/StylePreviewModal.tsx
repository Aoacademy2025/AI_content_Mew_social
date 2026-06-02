"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Caption, SubPreset, SubTextEffect } from "./types";
import { renderSubEl } from "./subtitle-renderer";

/**
 * Full-screen 9:16 preview of the chosen subtitle style.
 *
 * Lets the user see exactly how their captions look — font, colour, preset and
 * text animation — on a real phone-shaped canvas before committing to a render.
 * Cycles through every caption so they can judge the whole video, not one line.
 */
export function StylePreviewModal({
  open, onClose, captions, subColor, subAccentColor, subPreset,
  subFontFamily, subFontSize, subFontWeight, subEffect, subPosition,
}: {
  open: boolean;
  onClose: () => void;
  captions: Caption[];
  subColor: string;
  subAccentColor: string;
  subPreset: SubPreset;
  subFontFamily: string;
  subFontSize: number;
  subFontWeight: number;
  subEffect: SubTextEffect;
  subPosition: number;
}) {
  const [idx, setIdx] = useState(0);

  // Fall back to a sample line so the preview is never empty.
  const lines: Caption[] = captions.length > 0
    ? captions
    : [{ text: "ตัวอย่างซับไตเติล Hello 123", startMs: 0, endMs: 2000, tag: "body" }];

  // Auto-advance through captions; re-key the text node each step so the
  // entrance animation replays — matching how it behaves frame-by-frame on render.
  useEffect(() => {
    if (!open) return;
    setIdx(0);
    const t = setInterval(() => setIdx(i => (i + 1) % lines.length), 1800);
    return () => clearInterval(t);
  }, [open, lines.length]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const cap = lines[idx] ?? lines[0];
  // Phone canvas is 304×540 (9:16). Subtitles are authored at 1080px wide, so
  // scale the font down by the same ratio the real preview/Remotion uses.
  const PHONE_W = 304;
  const scale = PHONE_W / 1080;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(5,5,10,0.82)", backdropFilter: "blur(6px)" }}
      onClick={onClose}>
      <div className="relative flex flex-col items-center gap-4" onClick={e => e.stopPropagation()}>
        <button onClick={onClose}
          className="absolute -top-2 -right-2 z-10 h-8 w-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          aria-label="ปิด">
          <X className="h-4 w-4" />
        </button>

        {/* 9:16 phone canvas */}
        <div className="relative overflow-hidden rounded-2xl"
          style={{
            width: PHONE_W, height: PHONE_W * 16 / 9,
            background: "linear-gradient(160deg,#15151d,#0a0a10)",
            border: "1px solid hsl(190 100% 50% / 0.25)",
            boxShadow: "0 0 40px hsl(190 100% 50% / 0.15), 0 20px 60px rgba(0,0,0,0.5)",
          }}>
          {/* faint grid so it reads as a video frame */}
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "linear-gradient(hsl(190 100% 60% / 0.04) 1px,transparent 1px),linear-gradient(90deg,hsl(190 100% 60% / 0.04) 1px,transparent 1px)",
              backgroundSize: "24px 24px",
            }} />
          {/* subtitle, positioned by subPosition (% from top) */}
          <div key={idx} className="absolute left-1/2 -translate-x-1/2 text-center px-3"
            style={{ top: `${subPosition}%`, transform: "translate(-50%,-50%)", width: "100%" }}>
            {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook",
              subPreset, subFontFamily, subFontSize, subFontWeight, scale, subEffect)}
          </div>
        </div>

        {/* progress dots + hint */}
        <div className="flex items-center gap-2">
          {lines.slice(0, 12).map((_, i) => (
            <span key={i} className="h-1.5 rounded-full transition-all"
              style={{
                width: i === idx ? 18 : 6,
                background: i === idx ? "hsl(190 100% 60%)" : "rgba(255,255,255,0.25)",
              }} />
          ))}
        </div>
        <p className="text-[11px] text-white/45">ตัวอย่างก่อน Render — กด ESC หรือคลิกพื้นที่รอบๆ เพื่อปิด</p>
      </div>
    </div>
  );
}
