"use client";

/**
 * ปรับตำแหน่ง/สเกลอวตารหลังเรนเดอร์ (spec 07-03 ข้อ 1, ทางเลือก A) — ลากกล่องบน preview +
 * slider ซูม → (1) save preset ต่อ avatar (ครั้งหน้าเรนเดอร์ถูกตั้งแต่แรก) (2) re-composite
 * ฟรีบน base เดิมผ่าน /api/heygen/composite (ไม่เรียก HeyGen ใหม่) (3) PATCH videoUrl ลง job
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Move, RotateCcw } from "lucide-react";
import { color, radius } from "./tokens";
import { BtnPrimary, BtnGhost, GroupLabel } from "./ui";
import { normalizedBox, type AvatarLayout } from "@/lib/avatar-layout";

const DEFAULT_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

export function AvatarAdjustOverlay({ avatarId, avatarMode, introSecs, tailSecs, avatarVideoUrl, tailAvatarUrl, bgVideoUrl, jobId, onDone, onClose }: {
  avatarId: string;
  avatarMode: string;              // full | bookend | bookend-both
  introSecs: number;
  tailSecs: number;
  avatarVideoUrl: string;
  tailAvatarUrl: string | null;
  bgVideoUrl: string;              // base render ก่อน composite (compositeBaseUrl)
  jobId: string | null;
  onDone: (newVideoUrl: string) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_LAYOUT);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ความสูงจริงของแถบคุมล่าง — เฟรมวิดีโอต้องถูก "ย่อให้พ้นแถบ" ไม่ใช่ให้แถบทับเฟรม:
  // ถ้าแถบทับ ขอบล่างที่ผู้ใช้เห็น = ขอบบนของแถบ ไม่ใช่ขอบล่างวิดีโอจริง → จัดชิดล่างแล้ว
  // ของจริงลอย (บั๊ก QA 07-06). วัดด้วย ResizeObserver เพราะแถบเป็น 2 แถว สูงตามฟอนต์/ความกว้าง.
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [controlsH, setControlsH] = useState(96);
  useEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const update = () => setControlsH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live keyed-avatar preview (spec 07-05): fetch a fast, half-res, alpha webm of the avatar so
  // the box shows the REAL keyed subject while dragging, instead of an empty dashed box. Any
  // failure — fetch error, keying error, unsupported browser — silently falls back to today's
  // dashed-box-only behavior; the save flow below is untouched either way.
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarPreviewState, setAvatarPreviewState] = useState<"loading" | "ready" | "fallback">("loading");
  const fallbackToastShown = useRef(false);

  // `reason: "unsupported"` = the canPlayType probe failed (browser genuinely can't decode a
  // VP9-alpha webm) — keeps the original browser-blaming copy. Every OTHER failure (fetch error,
  // keying error, a 200 response pointing at an undecodable file caught by the <video onError>
  // below) is NOT the browser's fault, so it gets a generic message instead of blaming it.
  function fallbackToBox(reason: "unsupported" | "error") {
    setAvatarPreviewState("fallback");
    if (!fallbackToastShown.current) {
      fallbackToastShown.current = true;
      toast.info(
        reason === "unsupported"
          ? "ตัวอย่างอวตารสดใช้ไม่ได้ในเบราว์เซอร์นี้ — ใช้กรอบลากแทน (ไม่กระทบการบันทึก)"
          : "เตรียมตัวอย่างอวตารไม่สำเร็จ — ยังลากตำแหน่งด้วยกรอบได้ตามปกติ"
      );
    }
  }

  useEffect(() => {
    let alive = true;
    setAvatarPreviewUrl(null);
    setAvatarPreviewState("loading");

    // Safari (and any browser without VP9-alpha) can't play the keyed webm at all — bail before
    // even hitting the network.
    const probe = document.createElement("video");
    const supportsVp9 = !!probe.canPlayType('video/webm; codecs="vp9"');
    if (!supportsVp9) {
      fallbackToBox("unsupported");
      return () => { alive = false; };
    }

    // Abort the in-flight request on unmount / when avatarVideoUrl changes, so reopening the
    // panel quickly (or switching avatars mid-request) doesn't leave an orphaned fetch racing a
    // newer one. The server-side encode keeps running (harmless, and other callers may still
    // benefit from the cache it produces) — this only stops the CLIENT from waiting on it.
    const controller = new AbortController();

    fetch("/api/heygen/preview-bg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarVideoUrl, maxSec: 4, halfRes: true }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`preview-bg failed (${r.status})`))))
      .then((d) => {
        if (!alive) return;
        if (!d?.previewUrl) throw new Error("no previewUrl");
        setAvatarPreviewUrl(d.previewUrl as string);
        setAvatarPreviewState("ready");
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof DOMException && err.name === "AbortError") return; // intentional — swallow silently, no toast
        fallbackToBox("error");
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarVideoUrl]);

  // ค่าเริ่มต้น = preset ที่บันทึกไว้ (ใกล้เคียงค่าที่งานนี้ใช้เรนเดอร์ที่สุด)
  useEffect(() => {
    let alive = true;
    fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.layout) setLayout(d.layout as AvatarLayout); })
      .catch(() => {});
    return () => { alive = false; };
  }, [avatarId]);

  const box = normalizedBox(layout);

  function onBoxPointerDown(e: React.PointerEvent) {
    if (busy) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.offsetX, origY: layout.offsetY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onBoxPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const frame = frameRef.current;
    if (!d || !frame) return;
    const rect = frame.getBoundingClientRect();
    // ลากเต็มกรอบ = ±200 หน่วย (สเปซเดียวกับ v1 OrderPanel: nx ±1 → ×200) · แกน y บวก = ลง
    const nx = ((e.clientX - d.startX) / rect.width) * 2 * 200;
    const ny = ((e.clientY - d.startY) / rect.height) * 2 * 200;
    setLayout((l) => ({
      ...l,
      offsetX: Math.max(-200, Math.min(200, Math.round(d.origX + nx))),
      offsetY: Math.max(-200, Math.min(200, Math.round(d.origY + ny))),
    }));
  }
  function onBoxPointerUp() { dragRef.current = null; }

  async function apply() {
    if (busy) return;
    setBusy(true);
    let presetSaved = false;
    try {
      // 1) save preset ก่อน — ต่อให้ composite พังก็ยังได้ประโยชน์รอบหน้า (spec: error handling)
      const pres = await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });
      if (!pres.ok) throw new Error("บันทึกตำแหน่งไม่สำเร็จ — ลองใหม่อีกครั้ง");
      presetSaved = true;

      // 2) re-composite ฟรีบน base เดิม (ไม่เรียก HeyGen ใหม่)
      const res = await fetch("/api/heygen/composite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          avatarVideoUrl,
          ...(tailAvatarUrl ? { tailAvatarVideoUrl: tailAvatarUrl } : {}),
          bgVideoUrl,
          mode: "chromakey",
          avatarTiming: avatarMode,
          avatarBookendSecs: introSecs,
          avatarTailSecs: tailSecs,
          avatarLayout: layout,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.videoUrl) throw new Error(d?.error ?? `composite failed (${res.status})`);

      // 3) persist ลง job — resume งานที่ยังไม่ export จะเห็นตำแหน่งใหม่ (best-effort)
      if (jobId) {
        await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: d.videoUrl }),
        }).catch(() => {});
      }

      toast.success("ปรับตำแหน่งอวตารแล้ว — บันทึกเป็นค่าเริ่มต้นของอวตารนี้ให้ด้วย");
      onDone(d.videoUrl as string);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "re-composite ไม่สำเร็จ";
      toast.error(presetSaved ? `${msg} — ตำแหน่งถูกบันทึกไว้แล้ว จะถูกใช้ในการเรนเดอร์ครั้งหน้า` : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20" style={{ borderRadius: radius.cardLg, overflow: "hidden", background: "rgba(10,10,16,.97)" }}>
      {/* เวทีเฟรมวิดีโอ: ย่อทั้งเฟรม 9:16 ให้อยู่ "เหนือ" แถบคุมแบบเห็นครบ 100% (letterbox) —
          ห้ามให้แถบคุมทับเฟรมเด็ดขาด: ขอบล่างที่เห็นต้องเป็นขอบล่างวิดีโอจริง (บั๊ก QA 07-06
          จัดชิดล่างแล้วของจริงลอย เพราะแถบบังท่อนล่างของเฟรม). normalizedBox ยังคิด % จาก
          เฟรมเต็มเหมือนเดิม — เวทีคือเฟรมเต็ม แค่ย่อสเกลการแสดงผล คณิตไม่เปลี่ยน. */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-center" style={{ bottom: controlsH }}>
        <div ref={frameRef} className="relative h-full" style={{ aspectRatio: "9/16", maxWidth: "100%", border: `1px solid ${color.cardBorder}`, borderRadius: 8, overflow: "hidden" }}>
          {/* ชั้นหลัง (backdrop): base render ก่อน composite อวตาร — เห็นฉาก/บีรอลจริง แทนที่จะเห็น
              อวตารเก่าที่ baked ไว้ในพรีวิวเดิม (ผ่านสครีมโปร่งแสง). paused ที่เฟรมแรกสุด. */}
          <video
            src={bgVideoUrl}
            muted
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              try { v.currentTime = Math.min(0.05, v.duration || 0.05); } catch { /* ignore */ }
            }}
          />
          <div className="absolute inset-0" style={{ background: "rgba(10,10,16,.35)" }} />
        <div
          onPointerDown={onBoxPointerDown}
          onPointerMove={onBoxPointerMove}
          onPointerUp={onBoxPointerUp}
          onPointerCancel={onBoxPointerUp}
          className="absolute flex items-center justify-center overflow-hidden"
          style={{
            left: `${box.centerXPct}%`, top: `${box.centerYPct}%`,
            width: `${box.widthPct}%`, height: `${box.heightPct}%`,
            transform: "translate(-50%,-50%)",
            border: `1.5px dashed ${color.primary300}`, borderRadius: 10,
            background: avatarPreviewState === "ready" ? "transparent" : "rgba(139,92,246,.10)",
            cursor: busy ? "wait" : "move",
            touchAction: "none",
          }}
        >
          {/* ชั้นอวตาร: keyed webm เต็มกรอบ = ตำแหน่งเดียวกับที่จะเรนเดอร์จริง (ไม่มีคณิตใหม่) */}
          {avatarPreviewState === "ready" && avatarPreviewUrl && (
            <video
              key={avatarPreviewUrl}
              src={avatarPreviewUrl}
              autoPlay
              muted
              loop
              playsInline
              // A 200 response can still point at a file the browser can't actually decode (e.g.
              // cache poisoned by a truncated write, or a codec edge case canPlayType missed) —
              // degrade to the same dashed-box fallback rather than showing a broken/blank video.
              onError={() => fallbackToBox("error")}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}
            />
          )}
          <div className="relative flex flex-col items-center gap-1" style={{ zIndex: 1 }}>
            <span className="flex items-center gap-1" style={{ fontSize: 10.5, color: color.primary300, background: "rgba(10,10,16,.55)", padding: "3px 8px", borderRadius: 8 }}>
              <Move size={11} /> อวตาร — ลากเพื่อย้าย
            </span>
            {avatarPreviewState === "loading" && (
              <span style={{ fontSize: 9.5, color: color.textSecondary, background: "rgba(10,10,16,.55)", padding: "2px 7px", borderRadius: 7, whiteSpace: "nowrap" }}>
                กำลังเตรียมตัวอย่างอวตาร…
              </span>
            )}
          </div>
        </div>
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: "rgba(10,10,16,.66)" }}>
            <Loader2 size={22} className="animate-spin" color={color.primary300} />
            <span style={{ fontSize: 11.5, color: color.textSecondary }}>กำลังวางอวตารตำแหน่งใหม่… (~1-2 นาที ไม่คิดค่า HeyGen เพิ่ม)</span>
          </div>
        )}
        </div>
      </div>

      {/* แถบคุมล่าง — ต้องเป็น 2 แถวเสมอ: overlay กว้างเท่า preview 9:16 (~330-360px)
          แถวเดียวล้นแล้วโดน overflow:hidden ของกรอบตัดปุ่มขวาสุดทิ้ง → ผู้ใช้เห็นแต่
          "ยกเลิก" หาปุ่มบันทึกไม่เจอ (บั๊ก QA 07-04) */}
      <div ref={controlsRef} className="absolute bottom-0 left-0 right-0 flex flex-col gap-2 px-4 py-3" style={{ background: "rgba(10,10,16,.88)", borderTop: `1px solid ${color.cardBorder}` }}>
        <div className="flex items-center gap-3">
          <GroupLabel>ขนาด</GroupLabel>
          <input
            type="range" min={0.1} max={2.5} step={0.05} value={layout.scale}
            disabled={busy}
            onChange={(e) => setLayout((l) => ({ ...l, scale: Number(e.target.value) }))}
            className="min-w-0 flex-1"
            style={{ accentColor: color.primary500 }}
          />
          <span style={{ fontSize: 11, color: color.textSecondary, fontVariantNumeric: "tabular-nums", width: 38 }}>{layout.scale.toFixed(2)}×</span>
          <button onClick={() => setLayout(DEFAULT_LAYOUT)} disabled={busy} title="รีเซ็ต" className="flex shrink-0 items-center gap-1" style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer", fontSize: 11 }}>
            <RotateCcw size={11} /> รีเซ็ต
          </button>
        </div>
        <div className="flex items-center gap-2">
          <BtnGhost onClick={onClose} disabled={busy} style={{ padding: "8px 14px" }}>ยกเลิก</BtnGhost>
          <BtnPrimary onClick={() => void apply()} disabled={busy} style={{ flex: 1, padding: "8px 16px", ...(busy ? { opacity: 0.7, cursor: "wait" } : {}) }}>
            {busy ? "กำลังประมวลผล…" : "บันทึกตำแหน่งนี้"}
          </BtnPrimary>
        </div>
      </div>
    </div>
  );
}
