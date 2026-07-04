"use client";

/**
 * usePostPhaseEditor — เจ้าของ state/logic ทั้งหมดของเฟสแต่งซับ (แยกจาก PostPhase.tsx
 * เพื่อให้จอ desktop และ mobile ใช้ hook ตัวเดียวกัน — one source of truth: caption/
 * style/burn state, undo history, avatar re-composite trigger, export path).
 *
 * ⚠️ นี่คือการ "ย้าย" logic ล้วน (behavior-preserving) — subtitle timing math และ
 * avatar composite ยังคงเดิมทุกบรรทัด. hook เป็นเจ้าของ videoRef (Shell mount จอ
 * แต่งซับทีละจอเท่านั้น → ref ไม่ชนกัน).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_V2_SUB, buildV2BurnConfig,
  mergeCaptionWithNext, splitCaption, regroupCaptions,
  type V2CardLen, type V2SubConfig, type V2Caption, type V2CardOverrides,
} from "./subtitle-style";
import { loanwordSpans } from "@/lib/thai-loanwords";
import type { V2JobState } from "./useV2Job";
import { findActiveCaptionIdx } from "../_lib/find-active-caption";

export type ExportState =
  | { phase: "idle" }
  | { phase: "burning"; progress: number }
  | { phase: "saving" }
  | { phase: "done"; url: string }
  | { phase: "error"; message: string };

export function usePostPhaseEditor(
  job: V2JobState,
  script: string,
  { onExported }: { onExported: () => void },
) {
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

  return {
    preview,
    baseUrl, setBaseUrl,
    captions, setCaptions,
    selected, setSelected,
    editingIdx, setEditingIdx,
    cfg, setCfg,
    exp, setExp,
    cardLen,
    scope, setScope,
    overrides, setOverrides,
    videoRef,
    timeMs, setTimeMs,
    playing, setPlaying,
    adjustingAvatar, setAdjustingAvatar,
    canAdjustAvatar,
    activeIdx,
    follow, setFollow,
    cardRefs,
    historyLen,
    activeOverride,
    handleCaptionsChange,
    undoCaptions,
    onListScroll,
    resumeFollow,
    set,
    setColorScoped,
    applyCardLen,
    mergeSelected,
    splitSelected,
    exportVideo,
  };
}

export type PostPhaseEditor = ReturnType<typeof usePostPhaseEditor>;
