"use client";

/**
 * เฟสแต่งซับ (สเต็ป 3, จอ 4b) — P6a: การ์ดซับซ้าย (แก้ข้อความได้) + preview กลางพร้อม
 * ซับสดตามสไตล์ + แผงคุมซับขวา + "ส่งออกวิดีโอ" (burn ผ่าน render path เดิม — ฟรี
 * เพราะ base render จ่ายแล้ว isBurnAlreadyPaid) · timeline 4 แทร็ก = P6b
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Download, Loader2, Pencil } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnGhost, Card, GroupLabel, Segmented } from "./ui";
import {
  V2_STYLES, V2_FONTS, V2_TEXT_COLORS, V2_ACCENT_COLORS,
  DEFAULT_V2_SUB, buildV2BurnConfig,
  type V2SubConfig, type V2Caption,
} from "./subtitle-style";
import type { V2JobState } from "./useV2Job";

type ExportState =
  | { phase: "idle" }
  | { phase: "burning"; progress: number }
  | { phase: "saving" }
  | { phase: "done"; url: string }
  | { phase: "error"; message: string };

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PostPhase({ job, onNewProject }: { job: V2JobState; onNewProject: () => void }) {
  const preview = job.output?.preview ?? null;
  const baseUrl = job.output?.videoUrl ?? "";
  const [captions, setCaptions] = useState<V2Caption[]>(() => preview?.captions ?? []);
  const [selected, setSelected] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [cfg, setCfg] = useState<V2SubConfig>(DEFAULT_V2_SUB);
  const [exp, setExp] = useState<ExportState>({ phase: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const pollStop = useRef(false);

  useEffect(() => () => { pollStop.current = true; }, []);

  const activeIdx = useMemo(
    () => captions.findIndex((c) => timeMs >= c.startMs && timeMs < c.endMs),
    [captions, timeMs],
  );
  const activeCap = activeIdx >= 0 ? captions[activeIdx] : null;

  function set<K extends keyof V2SubConfig>(k: K, v: V2SubConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  async function exportVideo() {
    if (!baseUrl || !captions.length || exp.phase === "burning" || exp.phase === "saving") return;
    setExp({ phase: "burning", progress: 0 });
    try {
      const overlay = buildV2BurnConfig(baseUrl, captions, preview?.audioDurationMs ?? 0, cfg);
      const res = await fetch("/api/videos/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitleOverlayConfig: overlay }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error?.message ?? d?.error ?? `burn failed (${res.status})`);

      let burnedUrl: string | null = d?.videoUrl ?? null;
      const jobId: string | null = d?.jobId ?? null;
      if (!burnedUrl && jobId) {
        // poll จนเสร็จ (แนวเดียวกับ pollRender ฝั่ง worker)
        for (let i = 0; i < 450 && !pollStop.current; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const p = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`).then((r) => r.json());
            if (typeof p?.progress === "number") setExp({ phase: "burning", progress: Math.max(0, Math.min(100, Math.round(p.progress))) });
            if (p?.stage === "done" && p?.videoUrl) { burnedUrl = p.videoUrl; break; }
            if (p?.stage === "error") throw new Error(p?.error ?? "burn error");
          } catch (e) {
            if (e instanceof Error && e.message !== "Failed to fetch") throw e;
          }
        }
      }
      if (!burnedUrl) throw new Error("burn ไม่เสร็จในเวลาที่กำหนด — เช็คใน Gallery ภายหลัง");

      // บันทึกเข้า Gallery (โครงเดียวกับ MCP step 7/9 แต่จบที่ COMPLETED เลย)
      setExp({ phase: "saving" });
      await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: burnedUrl,
          audioUrl: preview?.voiceUrl ?? null,
          thumbnail: null,
          script: null,
          sceneCount: captions.length,
          status: "COMPLETED",
        }),
      }).catch(() => {}); // gallery save best-effort — ไฟล์ burn สำเร็จแล้ว

      setExp({ phase: "done", url: burnedUrl });
    } catch (e) {
      setExp({ phase: "error", message: e instanceof Error ? e.message : "ส่งออกไม่สำเร็จ" });
    }
  }

  if (exp.phase === "done") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} color={color.success} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.success }}>ส่งออกสำเร็จ — อยู่ใน Gallery แล้ว</span>
        </div>
        <video src={exp.url} controls playsInline className="max-h-[52vh]" style={{ borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16" }} />
        <div className="flex items-center gap-3">
          <a href={exp.url} download>
            <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
          </a>
          <BtnGhost onClick={onNewProject}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* แถบสถานะ + CTA เดียว */}
      <div className="flex shrink-0 items-center justify-between px-5 py-2.5" style={{ borderBottom: `1px solid ${color.cardBorder}` }}>
        <span className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <CheckCircle2 size={14} color={color.success} />
          <span style={{ color: color.success }}>เรนเดอร์เสร็จแล้ว</span>
          <span style={{ color: color.textFaintest }}>· แก้ซับเห็นผลทันที ไม่ต้องเรนเดอร์ใหม่</span>
        </span>
        <div className="flex items-center gap-3">
          <button onClick={onNewProject} style={{ fontSize: 12, color: color.link, background: "none", border: "none", cursor: "pointer" }}>
            เรนเดอร์ใหม่
          </button>
          <BtnPrimary
            onClick={() => void exportVideo()}
            disabled={exp.phase === "burning" || exp.phase === "saving"}
            style={{ padding: "9px 20px", ...(exp.phase === "burning" || exp.phase === "saving" ? { opacity: 0.7, cursor: "wait" } : {}) }}
          >
            {exp.phase === "burning" ? `กำลังฝังซับ ${exp.progress}%` : exp.phase === "saving" ? "กำลังบันทึก…" : "ส่งออกวิดีโอ"}
          </BtnPrimary>
        </div>
      </div>
      {exp.phase === "error" && (
        <div className="px-5 py-2" style={{ fontSize: 11.5, color: color.danger, borderBottom: `1px solid ${color.cardBorder}` }}>
          {exp.message} — <button onClick={() => setExp({ phase: "idle" })} style={{ color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}>ลองใหม่</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ── ซ้าย 266px: การ์ดซับ ── */}
        <aside className="flex w-[266px] shrink-0 flex-col gap-2 overflow-y-auto p-3" style={{ borderRight: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
          <GroupLabel>การ์ดซับ ({captions.length})</GroupLabel>
          {captions.map((c, i) => (
            <div key={`${i}-${c.startMs}`} onClick={() => { setSelected(i); const v = videoRef.current; if (v) v.currentTime = c.startMs / 1000 + 0.01; }} style={{ cursor: "pointer" }}>
              <Card selected={i === selected}>
                <div className="flex items-center justify-between" style={{ fontSize: 10.5 }}>
                  <span style={{ color: i === selected ? color.primary300 : color.textFaint }}>
                    {fmtMs(c.startMs)}–{fmtMs(c.endMs)}{c.tag === "hook" ? " · HOOK" : c.tag === "cta" ? " · CTA" : ""}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelected(i); setEditingIdx(editingIdx === i ? null : i); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: color.textFaint, padding: 2 }}
                    aria-label="แก้ข้อความ"
                  >
                    <Pencil size={11} strokeWidth={1.7} />
                  </button>
                </div>
                {editingIdx === i ? (
                  <textarea
                    autoFocus
                    value={c.text}
                    onChange={(e) => setCaptions((caps) => caps.map((cc, ci) => ci === i ? { ...cc, text: e.target.value } : cc))}
                    onBlur={() => setEditingIdx(null)}
                    className="mt-1 w-full resize-none bg-transparent outline-none"
                    rows={2}
                    style={{ fontSize: 12, lineHeight: 1.5, color: color.text, border: `1px solid ${color.selectedBorder}`, borderRadius: 8, padding: "4px 6px" }}
                  />
                ) : (
                  <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4, color: i === selected ? color.text : color.textSecondary }}>
                    {c.text}
                  </div>
                )}
              </Card>
            </div>
          ))}
          <span style={{ fontSize: 10, color: color.textFaintest, textAlign: "center", padding: "4px 0" }}>
            รวม/แยกการ์ด + timeline มาใน P6b
          </span>
        </aside>

        {/* ── กลาง: preview + ซับสด ── */}
        <main className="flex min-w-0 flex-1 items-center justify-center p-4" style={{ background: color.bg0 }}>
          <div className="relative" style={{ height: "min(72vh, 640px)", aspectRatio: "9/16" }}>
            <video
              ref={videoRef}
              src={baseUrl}
              controls
              playsInline
              onTimeUpdate={(e) => setTimeMs(e.currentTarget.currentTime * 1000)}
              className="h-full w-full object-cover"
              style={{ borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}` }}
            />
            {/* เส้นไกด์ตำแหน่งซับ */}
            <div className="pointer-events-none absolute left-2 right-2" style={{ top: `${cfg.verticalPos}%`, borderTop: "1px dashed rgba(255,255,255,.25)" }} />
            {/* ซับสด (approximation ของ renderer) */}
            {activeCap && (
              <div
                className="pointer-events-none absolute left-1 right-1 text-center"
                style={{ top: `${cfg.verticalPos}%`, transform: "translateY(-50%)" }}
              >
                <span
                  style={{
                    fontFamily: `'${cfg.fontFamily}', 'Noto Sans Thai', sans-serif`,
                    fontWeight: cfg.bold ? 800 : 400,
                    fontSize: 20,
                    lineHeight: 1.35,
                    color: activeCap.tag === "hook" ? cfg.accentColor : cfg.textColor,
                    ...(cfg.style === "clean"
                      ? { background: "rgba(0,0,0,.55)", borderRadius: 8, padding: "2px 8px", boxDecorationBreak: "clone" as const, WebkitBoxDecorationBreak: "clone" as const }
                      : cfg.style === "outline"
                        ? { WebkitTextStroke: "1.6px #000" }
                        : { textShadow: "0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)" }),
                  }}
                >
                  {activeCap.text}
                </span>
              </div>
            )}
            {(exp.phase === "burning" || exp.phase === "saving") && (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(10,10,16,.55)", borderRadius: radius.cardLg }}>
                <Loader2 size={22} className="animate-spin" color={color.primary300} />
              </div>
            )}
          </div>
        </main>

        {/* ── ขวา 330px: คุมซับ ── */}
        <aside className="flex w-[330px] shrink-0 flex-col gap-5 overflow-y-auto p-4" style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
          <section className="flex flex-col gap-2">
            <GroupLabel>สไตล์ซับ</GroupLabel>
            <div className="grid grid-cols-2 gap-2">
              {V2_STYLES.map((s) => (
                <button
                  key={s.key}
                  onClick={() => set("style", s.key)}
                  className="flex flex-col items-start gap-1 text-left"
                  style={{
                    borderRadius: radius.card, padding: "10px 12px",
                    background: cfg.style === s.key ? color.selectedBg : color.cardBg,
                    border: `1px solid ${cfg.style === s.key ? color.selectedBorder : color.cardBorder}`,
                    cursor: "pointer", transition: "all 150ms ease",
                  }}
                >
                  <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{s.label}</span>
                  <span style={{ fontSize: 10, color: cfg.style === s.key ? color.primary300 : color.textFaint }}>
                    {cfg.style === s.key ? "กำลังใช้" : s.desc}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ฟอนต์ · น้ำหนัก</GroupLabel>
            <div className="flex items-center gap-2">
              <select
                value={cfg.fontFamily}
                onChange={(e) => set("fontFamily", e.target.value)}
                className="flex-1"
                style={{ padding: "8px 10px", borderRadius: radius.control, fontSize: 12.5, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontFamily: font.body }}
              >
                {V2_FONTS.map((f) => <option key={f} value={f} style={{ background: color.bg1 }}>{f}</option>)}
              </select>
              <Segmented
                value={cfg.bold ? "bold" : "regular"}
                onChange={(v) => set("bold", v === "bold")}
                options={[{ value: "bold", label: "หนา" }, { value: "regular", label: "บาง" }]}
              />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สีตัวอักษร</GroupLabel>
            <div className="flex gap-2.5">
              {V2_TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set("textColor", c)}
                  aria-label={c}
                  className="h-[19px] w-[19px] rounded-full"
                  style={{
                    background: c, cursor: "pointer",
                    border: c === "#FFFFFF" || c === "#000000" ? "1px solid rgba(255,255,255,.25)" : "none",
                    outline: cfg.textColor === c ? `1.5px solid ${color.primary500}` : "none",
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สีเน้น HOOK · CTA</GroupLabel>
            <div className="flex gap-2.5">
              {V2_ACCENT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set("accentColor", c)}
                  aria-label={c}
                  className="h-[19px] w-[19px] rounded-full"
                  style={{ background: c, cursor: "pointer", outline: cfg.accentColor === c ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ตำแหน่งแนวตั้ง ({cfg.verticalPos}%)</GroupLabel>
            <input
              type="range"
              min={10}
              max={95}
              value={cfg.verticalPos}
              onChange={(e) => set("verticalPos", Number(e.target.value))}
              style={{ accentColor: color.primary500 }}
            />
            <Segmented
              value={cfg.verticalPos <= 30 ? "top" : cfg.verticalPos <= 62 ? "mid" : "bot"}
              onChange={(v) => set("verticalPos", v === "top" ? 20 : v === "mid" ? 55 : 82)}
              options={[{ value: "top", label: "บน" }, { value: "mid", label: "กลาง" }, { value: "bot", label: "ล่าง" }]}
            />
          </section>

          <span style={{ fontSize: 10.5, color: color.textFaintest }}>
            ใช้กับ: ทั้งคลิป · ปรับรายการ์ด + เอฟเฟกต์เพิ่มเติม มากับเวอร์ชันถัดไป
          </span>
        </aside>
      </div>
    </div>
  );
}
