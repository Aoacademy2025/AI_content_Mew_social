import type { SubPreset } from "./types";

/**
 * Render subtitle text with a given preset style.
 * Used in: caption preview overlay, effect picker, font picker.
 * Mirrors logic from ShortVideoComposition.tsx renderSubtitle() but client-side.
 */
export function renderSubEl(
  text: string, color: string, accentColor: string, isAccent: boolean,
  preset: SubPreset, fontFamily: string, fontSizePx: number, fontWeight: number, scale = 1,
): React.ReactNode {
  const c = isAccent ? accentColor : color;
  const charCount = text.length;
  const lengthScale = charCount <= 6 ? 1 : charCount <= 12 ? 0.9 : charCount <= 20 ? 0.78 : 0.68;
  const fs = Math.round(fontSizePx * scale * lengthScale);
  const fw = fontWeight;
  const sw = Math.max(0.5, 2 * scale);
  const base: React.CSSProperties = {
    fontFamily, fontSize: fs, fontWeight: fw, color: c,
    lineHeight: 1.3, letterSpacing: "0.01em",
    display: "block", textAlign: "center", width: "100%",
    whiteSpace: "normal", wordBreak: "break-all", overflowWrap: "anywhere",
  };
  if (preset === "plain") return <span style={base}>{text}</span>;
  if (preset === "karaoke-box") {
    const py=Math.round(8*scale),px=Math.round(22*scale),br=Math.round(12*scale);
    return <div style={{background:"rgba(0,0,0,0.75)",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:br}}><span style={{...base,color}}>{text}</span></div>;
  }
  if (preset === "box-white") {
    const py=Math.round(6*scale),px=Math.round(20*scale),pb=Math.round(8*scale);
    return <div style={{background:"#fff",padding:`${py}px ${px}px ${pb}px`,display:"inline-block",borderRadius:Math.round(4*scale)}}><span style={{...base,color:"#111",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "box-yellow") {
    const py=Math.round(6*scale),px=Math.round(20*scale),pb=Math.round(8*scale);
    return <div style={{background:"#FFE500",padding:`${py}px ${px}px ${pb}px`,display:"inline-block",borderRadius:Math.round(6*scale)}}><span style={{...base,color:"#111",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "box" || preset === "box-rounded") {
    const br=preset==="box-rounded"?Math.round(8*scale):Math.round(3*scale);
    const py=Math.round(4*scale),px=Math.round(16*scale);
    return <div style={{background:"rgba(0,0,0,0.7)",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:br}}><span style={{...base}}>{text}</span></div>;
  }
  if (preset === "classic-yellow") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#FFE500",WebkitTextStroke:`${sw2}px #000`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "neon-green") return <span style={{...base,color:"#00ff88",textShadow:`0 0 ${Math.round(8*scale)}px #00ff88,0 0 ${Math.round(20*scale)}px #00ff88`}}>{text}</span>;
  if (preset === "neon-red")   return <span style={{...base,color:"#ff3344",textShadow:`0 0 ${Math.round(8*scale)}px #ff3344,0 0 ${Math.round(20*scale)}px #ff1133`}}>{text}</span>;
  if (preset === "neon-blue")  return <span style={{...base,color:"#00cfff",textShadow:`0 0 ${Math.round(8*scale)}px #00cfff,0 0 ${Math.round(20*scale)}px #0099ff`}}>{text}</span>;
  if (preset === "hormozi") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#ff2244",fontStyle:"italic",fontWeight:900,WebkitTextStroke:`${sw2}px #fff`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "beast") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#fff",WebkitTextStroke:`${sw2}px #ff8800`,paintOrder:"stroke fill",textShadow:`0 0 ${Math.round(10*scale)}px rgba(255,140,0,0.4)`} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "bold-shadow") {
    const s=Math.round(4*scale);
    return <span style={{...base,fontWeight:900,textShadow:`${s}px ${s}px 0 #000,${-s}px ${s}px 0 #000,${s}px ${-s}px 0 #000,${-s}px ${-s}px 0 #000`}}>{text}</span>;
  }
  if (preset === "pop-outline") {
    const sw2=Math.max(1,Math.round(3*scale));
    return <span style={{...base,WebkitTextStroke:`${sw2}px #000`,paintOrder:"stroke fill",textShadow:`0 ${Math.round(4*scale)}px 0 rgba(0,0,0,0.6)`} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "pastel") {
    return <span style={{...base,color:"#ffb3d9",textShadow:`0 2px 0 rgba(0,0,0,0.5)`}}>{text}</span>;
  }
  if (preset === "shadow") {
    const s=Math.round(3*scale);
    return <span style={{...base,textShadow:`${s}px ${s}px ${Math.round(8*scale)}px rgba(0,0,0,0.9)`}}>{text}</span>;
  }
  if (preset === "glow") {
    return <span style={{...base,textShadow:`0 0 ${Math.round(12*scale)}px ${c},0 0 ${Math.round(24*scale)}px ${c}`}}>{text}</span>;
  }
  if (preset === "outline-only") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"transparent",WebkitTextStroke:`${sw2}px ${c}`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "retro") {
    const d=Math.round(2*scale);
    return <span style={{...base,color:"#fff",textShadow:`${d}px ${d}px 0 #ff6b00,${d*2}px ${d*2}px 0 #cc4400`}}>{text}</span>;
  }
  if (preset === "sharp-outline") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,WebkitTextStroke:`${sw2}px ${c}`,paintOrder:"stroke fill",color:"#000"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "news") {
    const py=Math.round(3*scale),px=Math.round(12*scale);
    return <div style={{background:"#cc0000",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:Math.round(2*scale)}}><span style={{...base,color:"#fff",fontWeight:900,letterSpacing:"0.05em",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "karaoke" || preset === "typewriter") {
    return <span style={{...base,color:accentColor||"#FFE500"}}>{text}</span>;
  }
  // stroke (default)
  const s1=Math.round(3*scale),s2=Math.round(20*scale),s3=Math.round(32*scale);
  return <span style={{...base,textShadow:`0 ${s1}px 0 #000,0 -1px 0 #000,1px 0 0 #000,-1px 0 0 #000,0 4px ${s2}px rgba(0,0,0,0.95),0 8px ${s3}px rgba(0,0,0,0.8)`,WebkitTextStroke:`${sw}px #000`} as React.CSSProperties}>{text}</span>;
}
