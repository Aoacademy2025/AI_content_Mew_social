import type { SubTextEffect } from "./types";

export const EFFECT_KEYFRAMES = `
@keyframes ef-pop    { 0%,100%{transform:scale(1) translateY(0)} 30%{transform:scale(1.25) translateY(-4px)} 60%{transform:scale(0.95) translateY(1px)} }
@keyframes ef-bounce { 0%,100%{transform:scale(1) translateY(0)} 25%{transform:scale(0.8) translateY(8px)} 55%{transform:scale(1.3) translateY(-8px)} 80%{transform:scale(0.95) translateY(2px)} }
@keyframes ef-fade   { 0%,100%{opacity:0} 20%,80%{opacity:1} }
@keyframes ef-quick  { 0%{transform:scale(0.4) translateY(6px);opacity:0} 18%{transform:scale(1.08) translateY(-2px);opacity:1} 30%,100%{transform:scale(1) translateY(0);opacity:1} }
@keyframes ef-slide  { 0%{transform:translateY(16px);opacity:0} 35%,80%{transform:translateY(0);opacity:1} 100%{transform:translateY(-8px);opacity:0} }
@keyframes ef-flip   { 0%{transform:perspective(200px) rotateX(90deg);opacity:0} 40%,75%{transform:perspective(200px) rotateX(0deg);opacity:1} 100%{transform:perspective(200px) rotateX(-30deg);opacity:0} }
@keyframes ef-hl-bar { 0%{width:0%} 55%,100%{width:100%} }
@keyframes ef-kar    { 0%,12%{color:inherit} 13%,24%{color:rgba(255,255,255,0.3)} 25%,36%{color:inherit} 37%,48%{color:rgba(255,255,255,0.3)} 49%,60%{color:inherit} 61%,72%{color:rgba(255,255,255,0.3)} 73%,84%{color:inherit} 85%,100%{color:rgba(255,255,255,0.3)} }
@keyframes ef-type   { 0%{clip-path:inset(0 100% 0 0)} 60%,100%{clip-path:inset(0 0% 0 0)} }
`;

export function EffectPreviewCard({
  effect, label, desc, color, accentColor, fontFamily, selected, onClick,
}: {
  effect: SubTextEffect; label: string; desc: string;
  color: string; accentColor: string; fontFamily: string;
  selected: boolean; onClick: () => void;
}) {
  const base: React.CSSProperties = {
    fontFamily, fontSize: 13, fontWeight: 700, color,
    textShadow: "-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000",
    display: "inline-block", whiteSpace: "nowrap",
  };
  const dur = "1.8s";
  const ease = "cubic-bezier(.4,0,.2,1)";
  const inf = "infinite";

  let inner: React.ReactNode;

  if (effect === "pop") {
    inner = <span style={{ ...base, animation: `ef-pop ${dur} ${ease} ${inf}` }}>ป๊อป</span>;
  } else if (effect === "bounce") {
    inner = <span style={{ ...base, animation: `ef-bounce 2s ${ease} ${inf}` }}>เด้ง</span>;
  } else if (effect === "fade") {
    inner = <span style={{ ...base, animation: `ef-fade 2s ease ${inf}` }}>เฟด</span>;
  } else if (effect === "quick") {
    inner = <span style={{ ...base, animation: `ef-quick 1.4s ${ease} ${inf}` }}>สั้น</span>;
  } else if (effect === "glow-pulse") {
    const r=parseInt(color.slice(1,3)||"ff",16),g=parseInt(color.slice(3,5)||"ff",16),b=parseInt(color.slice(5,7)||"ff",16);
    const glowKf = `@keyframes ef-glow-${r}-${g}-${b} { 0%,100%{text-shadow:0 0 4px rgba(${r},${g},${b},0.6),0 0 8px rgba(${r},${g},${b},0.4)} 50%{text-shadow:0 0 16px rgba(${r},${g},${b},1),0 0 32px rgba(${r},${g},${b},0.8),0 0 48px rgba(${r},${g},${b},0.5)} }`;
    inner = (
      <>
        <style dangerouslySetInnerHTML={{ __html: glowKf }} />
        <span style={{ ...base, textShadow: `0 0 8px rgba(${r},${g},${b},0.9)`, animation: `ef-glow-${r}-${g}-${b} 1.6s ease ${inf}` }}>แสง</span>
      </>
    );
  } else if (effect === "slide") {
    inner = <span style={{ ...base, animation: `ef-slide 2s ${ease} ${inf}` }}>เลื่อน</span>;
  } else if (effect === "flip") {
    inner = <span style={{ ...base, animation: `ef-flip 2s ${ease} ${inf}` }}>พลิก</span>;
  } else if (effect === "highlight") {
    inner = (
      <span style={{ position: "relative", display: "inline-block" }}>
        <span style={{ position: "absolute", inset: "5% 0", background: accentColor, opacity: 0.4, borderRadius: 3, animation: `ef-hl-bar 2s ease ${inf}` }} />
        <span style={{ ...base, position: "relative" }}>ไฮไลท์</span>
      </span>
    );
  } else if (effect === "karaoke") {
    inner = (
      <span style={{ fontFamily, fontSize: 12, fontWeight: 700, display: "inline-block" }}>
        {["คา","รา","โอ","เกะ"].map((s,i) => (
          <span key={i} style={{ color, animation: `ef-kar 2.4s ${i*0.3}s ease ${inf}` }}>{s}</span>
        ))}
      </span>
    );
  } else {
    inner = (
      <span style={{ fontFamily, fontSize: 12, fontWeight: 700, color, display: "inline-block", overflow: "hidden", animation: `ef-type 2s ease ${inf}` }}>
        พิมพ์ดีด
      </span>
    );
  }

  return (
    <button onClick={onClick}
      className="flex flex-col items-center gap-0.5 rounded-xl py-2 px-2 transition-all"
      style={selected
        ? { background: "hsl(262 83% 45% / 0.12)", border: "1px solid hsl(262 83% 58% / 0.5)", color: "hsl(262 83% 78%)" }
        : { background: "#1a1a22", border: "1px solid #2a2a36", color: "rgba(148,163,184,0.6)" }
      }>
      <div className="h-8 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.45)", borderRadius: 6, width: "100%", overflow: "hidden", position: "relative" }}>
        {inner}
      </div>
      <span className="text-[10px] font-bold mt-0.5">{label}</span>
      <span className="text-[8px] opacity-50">{desc}</span>
    </button>
  );
}
