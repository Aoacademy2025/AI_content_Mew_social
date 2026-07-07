"use client";

/**
 * Dashboard badge สำหรับงาน background render ของ Editor v2 (in-app notify — decision #10):
 * อ่าน jobId ที่ v2 จำไว้ใน localStorage → เช็คสถานะ → แถบเล็ก "กำลังทำ/เสร็จแล้ว" + ลิงก์กลับ editor.
 * ไม่มีงาน (หรือ v2 ยังไม่เคยใช้) = ไม่ render อะไรเลย — ผู้ใช้ UI เก่าไม่เห็นการเปลี่ยนแปลง
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, CheckCircle2 } from "lucide-react";

const STORAGE_KEY = "editor-v2-job"; // sync กับ useV2Job

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function V2JobBadge() {
  const [state, setState] = useState<{ status: string; progress: number; queuePosition: number | null } | null>(null);

  useEffect(() => {
    let jobId: string | null = null;
    try { jobId = browserStorage()?.getItem(STORAGE_KEY) ?? null; } catch {}
    if (!jobId) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/videos/jobs/${encodeURIComponent(jobId!)}`);
        if (!alive) return;
        if (!res.ok) { if (res.status === 404) setState(null); return; }
        const d = await res.json();
        if (d.status === "queued" || d.status === "processing" || d.status === "done") {
          setState({ status: d.status, progress: d.progress ?? 0, queuePosition: d.queuePosition ?? null });
        } else {
          setState(null);
        }
      } catch { /* เงียบ — badge เป็นของเสริม */ }
    };
    void poll();
    const t = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!state) return null;
  const running = state.status !== "done";

  return (
    <Link
      href="/video-editor?ui=v2"
      className="mb-3 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[12px] transition-colors"
      style={{
        background: running ? "rgba(139,92,246,.10)" : "rgba(52,211,153,.10)",
        border: `1px solid ${running ? "rgba(167,139,250,.35)" : "rgba(52,211,153,.35)"}`,
        color: running ? "#B9A6FF" : "#34D399",
      }}
    >
      {running
        ? (state.queuePosition
            ? <><Loader2 size={13} className="animate-spin" /> วิดีโอของคุณอยู่ในคิวเรนเดอร์ (คิว #{state.queuePosition}) — เปิดดูสถานะ</>
            : <><Loader2 size={13} className="animate-spin" /> วิดีโอของคุณกำลังเรนเดอร์อยู่ ({state.progress}%) — เปิดดูสถานะ</>)
        : <><CheckCircle2 size={13} /> วิดีโอเรนเดอร์เสร็จแล้ว — เข้าไปแต่งซับ + ส่งออกได้เลย</>}
    </Link>
  );
}
