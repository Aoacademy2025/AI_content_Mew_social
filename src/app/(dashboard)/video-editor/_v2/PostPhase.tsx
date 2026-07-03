"use client";

/**
 * เฟสแต่งซับ (สเต็ป 3, จอ 4b) — P6a: การ์ดซับซ้าย (แก้ข้อความได้) + preview กลางพร้อม
 * ซับสดตามสไตล์ + แผงคุมซับขวา + "ส่งออกวิดีโอ" (burn ผ่าน render path เดิม — ฟรี
 * เพราะ base render จ่ายแล้ว isBurnAlreadyPaid) · timeline 4 แทร็ก = P6b
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownToLine, CheckCircle2, Download, Loader2, Move, Pencil } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary, BtnGhost, Card, GroupLabel, Segmented } from "./ui";
import {
  V2_QUICK_STYLES, PRESETS_DATA, EFFECTS_DATA, FONTS_LIST,
  V2_TEXT_COLORS, V2_ACCENT_COLORS,
  LOCKED_EFFECT_PRESETS, LOCKED_COLOR_PRESETS, LOCKED_ACCENT_PRESETS,
  DEFAULT_V2_SUB, buildV2BurnConfig,
  mergeCaptionWithNext, splitCaption, regroupCaptions,
  V2_CARD_LEN_OPTIONS, type V2CardLen,
  type V2SubConfig, type V2Caption, type V2CardOverrides,
} from "./subtitle-style";
import { loanwordSpans } from "@/lib/thai-loanwords";
import type { V2JobState } from "./useV2Job";
import { TimelinePanel } from "./TimelinePanel";
import { V2CaptionOverlay } from "./V2CaptionOverlay";
import { AvatarAdjustOverlay } from "./AvatarAdjustOverlay";
import { findActiveCaptionIdx } from "../_lib/find-active-caption";

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

export function PostPhase({ job, script, onExported, onNewProject }: {
  job: V2JobState; script: string; onExported: () => void; onNewProject: () => void;
}) {
  const preview = job.output?.preview ?? null;
  const [baseUrl, setBaseUrl] = useState(job.output?.videoUrl ?? "");
  const [captions, setCaptions] = useState<V2Caption[]>(() => preview?.captions ?? []);
  const [selected, setSelected] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [cfg, setCfg] = useState<V2SubConfig>(DEFAULT_V2_SUB);
  const [exp, setExp] = useState<ExportState>({ phase: "idle" });
  // ความยาวการ์ด (1 ประโยค / ≤4 / ≤3 / ≤2 / 1 คำ — semantics เดียวกับ v1) —
  // จัดกลุ่มจากชุดต้นฉบับเสมอ (เปลี่ยนแล้วล้างการแก้รายใบ)
  const originalCapsRef = useRef<V2Caption[]>(preview?.captions ?? []);
  const [cardLen, setCardLen] = useState<V2CardLen>("sentence");
  // ปรับสี scope รายการ์ด
  const [scope, setScope] = useState<"all" | "card">("all");
  const [overrides, setOverrides] = useState<V2CardOverrides>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pollStop = useRef(false);
  const [adjustingAvatar, setAdjustingAvatar] = useState(false);
  // ปรับได้เมื่องานนี้มีอวตาร + worker เก็บข้อมูล re-composite ไว้ (งานเก่าก่อนฟีเจอร์นี้ = ซ่อน)
  // bookend-both ต้องมี tailAvatarUrl ด้วย ไม่งั้น composite split ขาดท่อน
  const canAdjustAvatar = !!(
    preview?.avatarModel && preview.avatarModel !== "none" &&
    preview.avatarVideoUrl && preview.compositeBaseUrl && preview.avatarMode &&
    (preview.avatarMode !== "bookend-both" || preview.tailAvatarUrl)
  );

  // การ์ดที่ "กำลังพูด" ตาม preview (แยกจาก selected = การ์ดที่เลือกแก้)
  const activeIdx = useMemo(() => findActiveCaptionIdx(captions, timeMs), [captions, timeMs]);
  const [follow, setFollow] = useState(true);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastAutoScrollAt = useRef(0);

  // auto-scroll ตามการ์ด active — หยุดชั่วคราวถ้ากำลังพิมพ์แก้ซับ (กันเลื่อนหนี)
  useEffect(() => {
    if (!follow || !playing || editingIdx !== null || activeIdx < 0) return;
    const el = cardRefs.current[activeIdx];
    if (!el) return;
    lastAutoScrollAt.current = Date.now();
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeIdx, follow, playing, editingIdx]);

  function onListScroll() {
    // programmatic scroll ใช้ behavior:"auto" (จบใน frame เดียว) — event ของมันตกใน window นี้เสมอ ที่เหลือ = ผู้ใช้เลื่อนเอง
    if (Date.now() - lastAutoScrollAt.current < 700) return;
    if (playing && follow) setFollow(false);
  }

  function resumeFollow() {
    setFollow(true);
    const el = activeIdx >= 0 ? cardRefs.current[activeIdx] : null;
    if (el) { lastAutoScrollAt.current = Date.now(); el.scrollIntoView({ block: "nearest", behavior: "auto" }); }
  }

  // Undo history สำหรับการแก้เวลาซับบน timeline (push เฉพาะตอน commit = ปล่อยเมาส์)
  const historyRef = useRef<V2Caption[][]>([]);
  const committedRef = useRef<V2Caption[]>(preview?.captions ?? []);
  const [historyLen, setHistoryLen] = useState(0);
  function handleCaptionsChange(next: V2Caption[], commit: boolean) {
    setCaptions(next);
    if (commit) {
      historyRef.current.push(committedRef.current.map((c) => ({ ...c })));
      if (historyRef.current.length > 50) historyRef.current.shift();
      committedRef.current = next.map((c) => ({ ...c }));
      setHistoryLen(historyRef.current.length);
    }
  }
  function undoCaptions() {
    const prev = historyRef.current.pop();
    if (!prev) return;
    committedRef.current = prev.map((c) => ({ ...c }));
    setCaptions(prev);
    setHistoryLen(historyRef.current.length);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (typing) return; // ให้ undo ของช่องพิมพ์ทำงานปกติ
        e.preventDefault();
        undoCaptions();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // shortcuts แบบ editor ทั่วไป (v1 มี space อยู่แล้ว — page.tsx:630)
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " ") {
        e.preventDefault();
        if (v.paused || v.ended) void v.play(); else v.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { pollStop.current = true; }, []);

  function set<K extends keyof V2SubConfig>(k: K, v: V2SubConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  /** สี text/accent เคารพ scope: ทั้งคลิป = config กลาง · การ์ดนี้ = override รายใบ */
  function setColorScoped(key: "textColor" | "accentColor", v: string) {
    if (scope === "card") {
      setOverrides((o) => ({ ...o, [selected]: { ...o[selected], [key]: v } }));
    } else {
      set(key, v);
    }
  }
  const activeOverride = overrides[selected] ?? {};

  function applyCardLen(len: V2CardLen) {
    setCardLen(len);
    setOverrides({});
    handleCaptionsChange(regroupCaptions(originalCapsRef.current, len, preview?.words, preview?.fullText), true);
    setSelected(0);
  }

  /** เลื่อน key ของ override รายการ์ดตามการเปลี่ยนโครงการ์ด — ห้ามล้างทั้ง map
   *  (QA 07-03: รวม/แยกการ์ด 2-3 เคยทำให้สีที่ตั้งไว้บนการ์ด 1 หายไปด้วย) */
  function shiftOverrides(from: number, delta: number, dropIdx?: number) {
    setOverrides((o) => {
      const next: V2CardOverrides = {};
      for (const [k, v] of Object.entries(o)) {
        const idx = Number(k);
        if (dropIdx !== undefined && idx === dropIdx) continue;
        next[idx >= from ? idx + delta : idx] = v;
      }
      return next;
    });
  }

  function mergeSelected() {
    if (selected >= captions.length - 1) { toast("การ์ดสุดท้าย — ไม่มีใบถัดไปให้รวม"); return; }
    shiftOverrides(selected + 2, -1, selected + 1); // ใบที่ถูกกลืนทิ้ง override ของตัวเอง ที่เหลือเลื่อนซ้าย
    handleCaptionsChange(mergeCaptionWithNext(captions, selected), true);
  }

  function splitSelected() {
    const next = splitCaption(captions, selected, loanwordSpans(captions[selected]?.text ?? ""));
    if (next === captions) { toast("การ์ดสั้นเกินไปหรือหาจุดตัดไม่ได้"); return; }
    shiftOverrides(selected + 1, +1); // ใบครึ่งซ้ายเก็บ override เดิม ใบใหม่ขวาเริ่มว่าง
    handleCaptionsChange(next, true);
  }

  async function exportVideo() {
    if (!baseUrl || !captions.length || exp.phase === "burning" || exp.phase === "saving") return;
    setExp({ phase: "burning", progress: 0 });
    try {
      const overlay = buildV2BurnConfig(baseUrl, captions, preview?.audioDurationMs ?? 0, cfg, 30, overrides);
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
          // ชื่อใน Gallery มาจาก script (v1 ก็ทำแบบนี้) — โหมดอัปคลิปใช้ fullText ที่ถอดได้
          script: script.trim() || preview?.fullText || null,
          sceneCount: captions.length,
          status: "COMPLETED",
        }),
      }).catch(() => {}); // gallery save best-effort — ไฟล์ burn สำเร็จแล้ว

      onExported(); // งานนี้จบแล้ว — กลับเข้ามาใหม่ต้องเริ่มสด (spec ข้อ 5)
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
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href={exp.url} download>
            <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
          </a>
          <a href="/videos"><BtnSecondary>ดูใน Gallery</BtnSecondary></a>
          <BtnGhost onClick={() => setExp({ phase: "idle" })}>แก้ซับต่อ &amp; ส่งออกใหม่</BtnGhost>
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
        {!adjustingAvatar && (
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
        )}
      </div>
      {exp.phase === "error" && (
        <div className="px-5 py-2" style={{ fontSize: 11.5, color: color.danger, borderBottom: `1px solid ${color.cardBorder}` }}>
          {exp.message} — <button onClick={() => setExp({ phase: "idle" })} style={{ color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}>ลองใหม่</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ── ซ้าย 266px: การ์ดซับ ── */}
        <aside onScroll={onListScroll} className="flex w-[266px] shrink-0 flex-col gap-2 overflow-y-auto p-3" style={{ borderRight: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
          <GroupLabel>การ์ดซับ ({captions.length})</GroupLabel>
          {captions.map((c, i) => (
            <div
              key={`${i}-${c.startMs}`}
              ref={(el) => { cardRefs.current[i] = el; }}
              onClick={() => { setSelected(i); setFollow(true); const v = videoRef.current; if (v) v.currentTime = c.startMs / 1000 + 0.01; }}
              style={{ cursor: "pointer" }}
            >
              <Card
                selected={i === selected}
                style={i === activeIdx ? { boxShadow: `inset 2.5px 0 0 ${color.primary300}` } : undefined}
              >
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
          {!follow && (
            <button
              onClick={resumeFollow}
              className="sticky bottom-1 z-10 mx-auto flex shrink-0 items-center gap-1.5"
              style={{
                padding: "5px 12px", borderRadius: radius.pill,
                background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
                color: color.primary300, fontSize: 11, cursor: "pointer",
                backdropFilter: "blur(6px)",
              }}
            >
              <ArrowDownToLine size={11} strokeWidth={2} /> ตามซับที่กำลังเล่น
            </button>
          )}
          <div className="mt-auto flex gap-2 pt-2">
            <button onClick={mergeSelected} className="flex-1" style={{ padding: "7px 0", borderRadius: 9, background: "none", border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 11, cursor: "pointer" }}>
              รวมกับใบถัดไป
            </button>
            <button onClick={splitSelected} className="flex-1" style={{ padding: "7px 0", borderRadius: 9, background: "none", border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 11, cursor: "pointer" }}>
              แยกการ์ด
            </button>
          </div>
        </aside>

        {/* ── กลาง: preview + ซับสด ── */}
        <main className="flex min-w-0 flex-1 items-center justify-center p-4" style={{ background: color.bg0 }}>
          <div className="relative" style={{ height: "min(72vh, 640px)", aspectRatio: "9/16", containerType: "size" }}>
            <video
              ref={videoRef}
              src={baseUrl}
              controls
              playsInline
              onTimeUpdate={(e) => setTimeMs(e.currentTarget.currentTime * 1000)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              className="h-full w-full object-cover"
              style={{ borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}` }}
            />
            {/* เส้นไกด์ตำแหน่งซับ */}
            <div className="pointer-events-none absolute left-2 right-2" style={{ top: `${cfg.verticalPos}%`, borderTop: "1px dashed rgba(255,255,255,.25)" }} />
            {/* ซับสด — renderer เดียวกับไฟล์ burn (WYSIWYG) + ลากปรับตำแหน่งได้ */}
            <V2CaptionOverlay
              captions={captions}
              overrides={overrides}
              cfg={cfg}
              videoRef={videoRef}
              playing={playing}
              onVerticalPos={(p) => set("verticalPos", p)}
            />
            {adjustingAvatar && canAdjustAvatar && preview && (
              <AvatarAdjustOverlay
                avatarId={preview.avatarModel!}
                avatarMode={preview.avatarMode!}
                introSecs={preview.avatarIntroSecs ?? 5}
                tailSecs={preview.avatarTailSecs ?? 5}
                avatarVideoUrl={preview.avatarVideoUrl!}
                tailAvatarUrl={preview.tailAvatarUrl ?? null}
                bgVideoUrl={preview.compositeBaseUrl!}
                jobId={job.jobId}
                onClose={() => setAdjustingAvatar(false)}
                onDone={(url) => {
                  setBaseUrl(url);
                  setAdjustingAvatar(false);
                  const v = videoRef.current;
                  if (v) { v.load(); v.currentTime = 0; }
                }}
              />
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
          {canAdjustAvatar && (
            <section className="flex flex-col gap-2">
              <GroupLabel>อวตาร</GroupLabel>
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) { v.pause(); v.currentTime = 0; }
                  setAdjustingAvatar(true);
                }}
                className="flex items-center justify-center gap-2"
                style={{
                  padding: "9px 0", borderRadius: radius.control, background: "rgba(139,92,246,.10)",
                  border: "1px solid rgba(139,92,246,.45)", color: color.primary300,
                  fontSize: 12, cursor: "pointer",
                }}
              >
                <Move size={13} /> ปรับตำแหน่ง/ขนาดอวตาร (ฟรี)
              </button>
              <span style={{ fontSize: 9.5, color: color.textFaintest }}>
                ตำแหน่งที่บันทึกจะถูกใช้เป็นค่าเริ่มต้นของอวตารนี้ในการเรนเดอร์ครั้งถัดไปด้วย
              </span>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <GroupLabel>ความยาวการ์ดซับ</GroupLabel>
            <Segmented
              value={cardLen}
              onChange={(v) => applyCardLen(v as V2CardLen)}
              options={V2_CARD_LEN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              style={{ flexWrap: "wrap" }}
            />
            <span style={{ fontSize: 9.5, color: color.textFaintest }}>
              ≤N คำ = ซับสั้นเด้งเร็วแบบ TikTok · เปลี่ยนแล้วจะล้างการรวม/แยก/สีรายการ์ดที่แก้ไว้
            </span>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สไตล์แนะนำ</GroupLabel>
            <div className="grid grid-cols-2 gap-2">
              {V2_QUICK_STYLES.map((s) => {
                const active = cfg.preset === s.preset && cfg.effect === s.effect;
                return (
                  <button
                    key={s.key}
                    onClick={() => setCfg((c) => ({ ...c, preset: s.preset, effect: s.effect }))}
                    className="flex flex-col items-start gap-1 text-left"
                    style={{
                      borderRadius: radius.card, padding: "10px 12px",
                      background: active ? color.selectedBg : color.cardBg,
                      border: `1px solid ${active ? color.selectedBorder : color.cardBorder}`,
                      cursor: "pointer", transition: "all 150ms ease",
                    }}
                  >
                    <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{s.label}</span>
                    <span style={{ fontSize: 10, color: active ? color.primary300 : color.textFaint }}>
                      {active ? "กำลังใช้" : s.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สไตล์ทั้งหมด ({PRESETS_DATA.length})</GroupLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS_DATA.map((p) => (
                <button
                  key={p.value}
                  onClick={() => set("preset", p.value)}
                  style={{
                    borderRadius: 9, padding: "7px 4px", fontSize: 10.5,
                    background: cfg.preset === p.value ? color.selectedBg : color.cardBg,
                    border: `1px solid ${cfg.preset === p.value ? color.selectedBorder : color.cardBorder}`,
                    color: cfg.preset === p.value ? color.primary300 : color.textSecondary,
                    cursor: "pointer", transition: "all 150ms ease",
                    fontFamily: font.body,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>เอฟเฟกต์ตัวอักษร</GroupLabel>
            {LOCKED_EFFECT_PRESETS.includes(cfg.preset) ? (
              <span style={{ fontSize: 10.5, color: color.textFaintest }}>สไตล์ &quot;{PRESETS_DATA.find((p) => p.value === cfg.preset)?.label}&quot; กำหนดเอฟเฟกต์ในตัว</span>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {EFFECTS_DATA.map((ef) => (
                  <button
                    key={ef.value}
                    onClick={() => set("effect", ef.value)}
                    title={ef.desc}
                    style={{
                      borderRadius: 9, padding: "7px 4px", fontSize: 10.5,
                      background: cfg.effect === ef.value ? color.selectedBg : color.cardBg,
                      border: `1px solid ${cfg.effect === ef.value ? color.selectedBorder : color.cardBorder}`,
                      color: cfg.effect === ef.value ? color.primary300 : color.textSecondary,
                      cursor: "pointer", transition: "all 150ms ease", fontFamily: font.body,
                    }}
                  >
                    {ef.label}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ฟอนต์ · น้ำหนัก · ขนาด ({cfg.fontSize}px)</GroupLabel>
            <div className="flex items-center gap-2">
              <select
                value={cfg.fontFamily}
                onChange={(e) => set("fontFamily", e.target.value)}
                className="flex-1 min-w-0"
                style={{ padding: "8px 10px", borderRadius: radius.control, fontSize: 12.5, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontFamily: font.body }}
              >
                {FONTS_LIST.map((f) => <option key={f.value} value={f.value} style={{ background: color.bg1 }}>{f.label}</option>)}
              </select>
              <Segmented
                value={cfg.bold ? "bold" : "regular"}
                onChange={(v) => set("bold", v === "bold")}
                options={[{ value: "bold", label: "หนา" }, { value: "regular", label: "บาง" }]}
              />
            </div>
            <input
              type="range"
              min={30}
              max={160}
              value={cfg.fontSize}
              onChange={(e) => set("fontSize", Number(e.target.value))}
              style={{ accentColor: color.primary500 }}
            />
          </section>

          {(!LOCKED_COLOR_PRESETS.includes(cfg.preset) || !LOCKED_ACCENT_PRESETS.includes(cfg.preset)) && (
            <section className="flex flex-col gap-2">
              <GroupLabel>ใช้สีกับ</GroupLabel>
              <Segmented
                value={scope}
                onChange={(v) => setScope(v as "all" | "card")}
                options={[{ value: "all", label: "ทั้งคลิป" }, { value: "card", label: `การ์ดที่เลือก (#${selected + 1})` }]}
              />
            </section>
          )}

          {!LOCKED_COLOR_PRESETS.includes(cfg.preset) && (() => {
            const effective = scope === "card" ? (activeOverride.textColor ?? cfg.textColor) : cfg.textColor;
            return (
            <section className="flex flex-col gap-2">
              <GroupLabel>สีตัวอักษร{scope === "card" ? ` · การ์ด #${selected + 1}` : ""}</GroupLabel>
              <div className="flex items-center gap-2.5">
                {V2_TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColorScoped("textColor", c)}
                    aria-label={c}
                    className="h-[19px] w-[19px] rounded-full"
                    style={{
                      background: c, cursor: "pointer",
                      border: c === "#FFFFFF" || c === "#000000" ? "1px solid rgba(255,255,255,.25)" : "none",
                      outline: effective === c ? `1.5px solid ${color.primary500}` : "none",
                      outlineOffset: 2,
                    }}
                  />
                ))}
                <label className="relative h-[19px] w-[19px] cursor-pointer rounded-full" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_TEXT_COLORS.includes(effective as typeof V2_TEXT_COLORS[number]) ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                  <input type="color" value={effective} onChange={(e) => setColorScoped("textColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีกำหนดเอง" />
                </label>
              </div>
            </section>
            );
          })()}

          {!LOCKED_ACCENT_PRESETS.includes(cfg.preset) && (() => {
            const effective = scope === "card" ? (activeOverride.accentColor ?? cfg.accentColor) : cfg.accentColor;
            return (
            <section className="flex flex-col gap-2">
              <GroupLabel>สีเน้น HOOK · CTA{scope === "card" ? ` · การ์ด #${selected + 1}` : ""}</GroupLabel>
              <div className="flex items-center gap-2.5">
                {V2_ACCENT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColorScoped("accentColor", c)}
                    aria-label={c}
                    className="h-[19px] w-[19px] rounded-full"
                    style={{ background: c, cursor: "pointer", outline: effective === c ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}
                  />
                ))}
                <label className="relative h-[19px] w-[19px] cursor-pointer rounded-full" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_ACCENT_COLORS.includes(effective as typeof V2_ACCENT_COLORS[number]) ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                  <input type="color" value={effective} onChange={(e) => setColorScoped("accentColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีเน้นกำหนดเอง" />
                </label>
              </div>
            </section>
            );
          })()}

          <section className="flex flex-col gap-2">
            <GroupLabel>เงา · เส้นขอบ</GroupLabel>
            <div className="flex items-center gap-4" style={{ fontSize: 12, color: color.textSecondary }}>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={cfg.shadow} onChange={(e) => set("shadow", e.target.checked)} style={{ accentColor: color.primary500 }} /> เงา
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={cfg.outline} onChange={(e) => set("outline", e.target.checked)} style={{ accentColor: color.primary500 }} /> เส้นขอบ
              </label>
              {cfg.outline && (
                <input type="range" min={1} max={8} value={cfg.outlineSize} onChange={(e) => set("outlineSize", Number(e.target.value))} className="flex-1" style={{ accentColor: color.primary500 }} />
              )}
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
            ทิป: ลากซับบนจอเพื่อปรับตำแหน่ง · Space เล่น/หยุด · ←/→ ขยับ 1 วิ · Ctrl+Z เลิกทำ
          </span>
        </aside>
      </div>

      {/* Timeline 4 แทร็ก (P6b) — ซับลากขอบแก้เวลาได้, แทร็กอื่นคลิก jump */}
      <TimelinePanel
        captions={captions}
        onCaptionsChange={handleCaptionsChange}
        onUndo={undoCaptions}
        canUndo={historyLen > 0}
        selected={selected}
        onSelect={setSelected}
        videoRef={videoRef}
        timeMs={timeMs}
        onScrub={setTimeMs}
        durationMs={Math.max(preview?.audioDurationMs ?? 0, captions.length ? captions[captions.length - 1].endMs : 0)}
        config={(preview?.config as Record<string, unknown>) ?? null}
        hasAvatar={!!(preview?.avatarModel && preview.avatarModel !== "none")}
        avatarMode={preview?.avatarMode ?? null}
        avatarIntroMs={(preview?.avatarIntroSecs ?? 5) * 1000}
        avatarTailMs={(preview?.avatarTailSecs ?? 5) * 1000}
        voiceUrl={preview?.voiceUrl ?? null}
      />
    </div>
  );
}
