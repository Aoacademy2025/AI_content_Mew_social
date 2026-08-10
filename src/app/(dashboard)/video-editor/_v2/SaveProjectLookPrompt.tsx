"use client";

import Link from "next/link";
import { BookmarkPlus, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/client-telemetry";
import { color, font } from "./tokens";

export function SaveProjectLookPrompt({
  projectId,
  videoJobId,
  brandVisualAllowed,
}: {
  projectId: string | null;
  videoJobId: string | null;
  brandVisualAllowed: boolean;
}) {
  const [source, setSource] = useState<"loading" | "brand-revision" | "project-look" | "suggested" | "error">("loading");
  const [preflightId, setPreflightId] = useState<string | null>(null);
  const tracked = useRef(false);

  useEffect(() => {
    if (!projectId || !videoJobId || !brandVisualAllowed) return;
    const controller = new AbortController();
    setSource("loading");
    setPreflightId(null);
    tracked.current = false;
    fetch(`/api/videos/jobs/${encodeURIComponent(videoJobId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("video job unavailable")))
      .then((job) => {
        const exactPreflightId = typeof job?.contentPreflightId === "string"
          ? job.contentPreflightId.trim()
          : "";
        const visualSource = job?.projectVisualContext?.source;
        if (
          job?.status !== "done"
          || job?.projectId !== projectId
          || !exactPreflightId
          || (visualSource !== "brand-revision" && visualSource !== "project-look" && visualSource !== "suggested")
        ) {
          throw new Error("completed visual lineage unavailable");
        }
        return { exactPreflightId, visualSource };
      })
      .then(({ exactPreflightId, visualSource }) => {
        setPreflightId(exactPreflightId);
        setSource(visualSource);
      })
      .catch((error) => { if ((error as Error).name !== "AbortError") setSource("error"); });
    return () => controller.abort();
  }, [brandVisualAllowed, projectId, videoJobId]);

  if (!brandVisualAllowed || !projectId || !videoJobId || source === "brand-revision" || source === "error") return null;
  if (source === "loading") {
    return <div className="flex min-h-10 items-center gap-2 px-4 text-[11px]" style={{ color: color.textFaint }}><Loader2 size={13} className="animate-spin" /> กำลังตรวจแนวภาพของคลิป…</div>;
  }
  if (!tracked.current) {
    tracked.current = true;
    trackEvent("brand_profile_save_prompt_shown", {
      path: "/video-editor",
      properties: { projectId, videoJobId, preflightId, source },
    });
  }
  if (!preflightId) return null;
  return <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: "rgba(56,189,248,.10)", border: "1px solid rgba(56,189,248,.28)" }}>
    <div className="flex min-w-0 items-start gap-2.5"><BookmarkPlus size={17} color={color.info} className="mt-0.5 shrink-0" /><div><p style={{ color: color.text, font: `600 12px ${font.heading}` }}>ชอบแนวภาพของคลิปนี้ไหม?</p><p className="mt-0.5" style={{ color: color.textSecondary, fontSize: 10.5 }}>บันทึกเป็นแบรนด์หลังเห็นผลงานจริง โปรเจกต์นี้จะใช้แนวภาพรุ่นที่บันทึกไว้</p></div></div>
    <Link href={`/brands?new=1&projectId=${encodeURIComponent(projectId)}&preflightId=${encodeURIComponent(preflightId)}&videoJobId=${encodeURIComponent(videoJobId)}`} onClick={() => trackEvent("brand_profile_save_prompt_clicked", { path: "/video-editor", properties: { projectId, videoJobId, preflightId, source } })} className="min-h-9 rounded-lg px-3 py-2 text-[10.5px] font-bold" style={{ background: color.info, color: color.bg0 }}>บันทึกแนวนี้เป็นแบรนด์</Link>
  </div>;
}
