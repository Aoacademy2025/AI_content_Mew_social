"use client";

/**
 * Dashboard badge สำหรับงาน background render ของ Editor v2 (in-app notify — decision #10):
 * อ่าน project/job pointer ที่ server เป็นหลัก → เช็คสถานะ → แถบเล็ก
 * "กำลังทำ/เสร็จแล้ว" + ลิงก์กลับ project เจ้าของงานโดยตรง.
 * ไม่มีงาน (หรือ v2 ยังไม่เคยใช้) = ไม่ render อะไรเลย — ผู้ใช้ UI เก่าไม่เห็นการเปลี่ยนแปลง
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, CheckCircle2 } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { createClientPoller, type ClientPoller } from "@/lib/client-polling";
import {
  editorDashboardJobHref,
  resolveDashboardEditorJobPointer,
  type DashboardEditorJobPointer,
} from "@/lib/editor-dashboard-job";

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function V2JobBadge() {
  const [state, setState] = useState<{
    pointer: DashboardEditorJobPointer;
    status: string;
    progress: number;
    queuePosition: number | null;
  } | null>(null);
  const pollerRef = useRef<ClientPoller | null>(null);

  useEffect(() => {
    let alive = true;
    let hasRunningJob = true;
    const poller = createClientPoller({
      task: async (signal) => {
        const pointer = await resolveDashboardEditorJobPointer({
          fetchProjects: () => authenticatedFetch("/api/editor-projects", {
            cache: "no-store",
            signal,
          }),
          storage: browserStorage(),
        });
        if (!alive || signal.aborted) return;
        if (!pointer) {
          hasRunningJob = false;
          setState(null);
          return;
        }
        const res = await authenticatedFetch(`/api/videos/jobs/${encodeURIComponent(pointer.jobId)}`, {
          cache: "no-store",
          signal,
        });
        if (!alive || signal.aborted) return;
        if (res.status === 404) {
          hasRunningJob = false;
          setState(null);
          return;
        }
        if (!res.ok) throw new Error(`dashboard_job_poll_${res.status}`);
        const d = await res.json();
        if (d.status === "queued" || d.status === "processing" || d.status === "done") {
          hasRunningJob = d.status !== "done";
          setState({
            pointer,
            status: d.status,
            progress: d.progress ?? 0,
            queuePosition: d.queuePosition ?? null,
          });
        } else {
          hasRunningJob = false;
          setState(null);
        }
      },
      isActive: () => alive,
      isVisible: () => document.visibilityState === "visible",
      nextDelayMs: ({ isVisible, failures }) => {
        if (!isVisible) return null;
        return failures >= 3 ? 60_000 : hasRunningJob ? 15_000 : 60_000;
      },
    });
    pollerRef.current = poller;
    const wake = () => {
      if (document.visibilityState === "visible") poller.wake();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    poller.start();
    return () => {
      alive = false;
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  if (!state) return null;
  const running = state.status !== "done";

  return (
    <Link
      href={editorDashboardJobHref(state.pointer)}
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
