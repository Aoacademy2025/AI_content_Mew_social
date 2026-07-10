"use client";

import React, { useState } from "react";
import { FileClock, TriangleAlert } from "lucide-react";
import { SupportModal } from "@/components/ui/support-modal";
import type { ProjectMediaState } from "@/lib/media-retention";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary } from "./ui";

type UnavailableMediaState = Exclude<ProjectMediaState, { status: "available" }>;

export function selectUnavailablePreviewState(job: {
  phase: string;
  mediaState: ProjectMediaState | null;
}): UnavailableMediaState | null {
  if (job.phase !== "done" || job.mediaState?.status === "available") return null;
  return job.mediaState ?? {
    status: "missing",
    canRerender: true,
    supportCode: "MEDIA_EXPIRY_UNKNOWN",
  };
}

export function unavailablePreviewCopy(mediaState: UnavailableMediaState) {
  if (mediaState.status === "expired") {
    return {
      eyebrow: "PREVIEW RETENTION",
      title: "Preview นี้ครบกำหนดจัดเก็บแล้ว",
      description: "ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้",
      primaryAction: "สร้าง Preview ใหม่",
      supportCode: null,
    };
  }

  const expiryUnknown = mediaState.supportCode === "MEDIA_EXPIRY_UNKNOWN";
  return {
    eyebrow: "PREVIEW INCIDENT",
    title: "ไฟล์ Preview ไม่พร้อมใช้งาน",
    description: expiryUnknown
      ? "ไม่สามารถยืนยันวันหมดอายุและไฟล์ Preview ไม่พร้อมใช้งานโดยไม่คาดคิด คุณสามารถสร้างใหม่หรือแจ้งทีมช่วยเหลือเพื่อตรวจสอบได้"
      : "ไฟล์ Preview ไม่พร้อมใช้งานโดยไม่คาดคิดก่อนถึงวันหมดอายุ คุณสามารถสร้างใหม่หรือแจ้งทีมช่วยเหลือเพื่อตรวจสอบได้",
    primaryAction: "สร้าง Preview ใหม่",
    supportCode: mediaState.supportCode,
  };
}

export function ExpiredPreviewView({ mediaState, onRerender }: {
  mediaState: UnavailableMediaState;
  onRerender: () => void;
}) {
  const [supportOpen, setSupportOpen] = useState(false);
  const copy = unavailablePreviewCopy(mediaState);
  const isIncident = mediaState.status === "missing";
  const Icon = isIncident ? TriangleAlert : FileClock;

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-5 py-10" aria-labelledby="preview-unavailable-title">
      <section
        className="relative w-full max-w-[680px] overflow-hidden"
        style={{
          borderRadius: radius.panel,
          border: `1px solid ${isIncident ? "rgba(248,113,113,.24)" : color.cardBorder}`,
          background: color.bg1,
        }}
        aria-live="polite"
      >
        <div
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: isIncident ? color.danger : color.primary500 }}
          aria-hidden="true"
        />
        <div className="grid gap-7 px-7 py-8 sm:grid-cols-[52px_1fr] sm:px-10 sm:py-10">
          <div
            className="flex h-[52px] w-[52px] items-center justify-center"
            style={{
              borderRadius: radius.control,
              background: isIncident ? "rgba(248,113,113,.09)" : color.selectedBg,
              color: isIncident ? color.danger : color.primary300,
            }}
            aria-hidden="true"
          >
            <Icon size={24} strokeWidth={1.7} />
          </div>

          <div className="min-w-0">
            <p style={{ margin: 0, color: isIncident ? color.danger : color.primary300, font: `600 10px ${font.heading}`, letterSpacing: ".14em" }}>
              {copy.eyebrow}
            </p>
            <h1 id="preview-unavailable-title" style={{ margin: "8px 0 0", color: color.text, font: `600 clamp(20px, 3vw, 28px) ${font.heading}`, lineHeight: 1.35 }}>
              {copy.title}
            </h1>
            <p style={{ margin: "12px 0 0", maxWidth: 520, color: color.textSecondary, font: `400 13px ${font.body}`, lineHeight: 1.8 }}>
              {copy.description}
            </p>

            {copy.supportCode && (
              <p style={{ margin: "14px 0 0", color: color.textFaint, font: `400 11px ${font.body}` }}>
                รหัสสำหรับทีมช่วยเหลือ: <strong style={{ color: color.textSecondary, fontWeight: 600 }}>{copy.supportCode}</strong>
              </p>
            )}

            <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:items-center">
              {mediaState.canRerender && (
                <BtnPrimary onClick={onRerender} style={{ minHeight: 44 }}>
                  {copy.primaryAction}
                </BtnPrimary>
              )}
              {isIncident && (
                <BtnSecondary onClick={() => setSupportOpen(true)} style={{ minHeight: 44 }}>
                  ติดต่อฝ่ายช่วยเหลือ
                </BtnSecondary>
              )}
            </div>
          </div>
        </div>
      </section>
      {isIncident && <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />}
    </main>
  );
}
