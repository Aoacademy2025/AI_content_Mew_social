"use client";

import React from "react";
import { Clock3, LifeBuoy, RefreshCw, TriangleAlert } from "lucide-react";
import type { ProjectMediaState } from "@/lib/media-retention";
import type { V2JobPhase } from "./useV2Job";
import { color, font, radius } from "./tokens";
import { BtnPrimary } from "./ui";

const EXPIRED_COPY = "ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้";

export function shouldShowUnavailablePreview(
  phase: V2JobPhase,
  state: ProjectMediaState | null,
): boolean {
  return phase === "done" && state?.status !== "available";
}

export function previewMediaStateAfterVideoError(
  state: ProjectMediaState | null,
): ProjectMediaState {
  if (state?.status === "expired" || state?.status === "missing") return state;
  return { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" };
}

export function mediaStateFromJobPoll(
  polledState: ProjectMediaState | null | undefined,
  projectState: ProjectMediaState | null,
): ProjectMediaState | null {
  return polledState !== undefined ? polledState : projectState;
}

export function prepareExpiredPreviewRerender(
  resetJob: () => void,
  setPreparationStep: (step: 1) => void,
): void {
  resetJob();
  setPreparationStep(1);
}

export function ExpiredPreviewView({
  state,
  onRerender,
}: {
  state: ProjectMediaState | null;
  onRerender: () => void;
}) {
  const expired = state?.status === "expired";
  const supportCode = state?.status === "missing"
    ? state.supportCode
    : state === null
      ? "MEDIA_EXPIRY_UNKNOWN"
      : null;
  const unknown = supportCode === "MEDIA_EXPIRY_UNKNOWN";
  const canRerender = state?.status !== "missing" || state.canRerender;

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-5 py-10">
      <section
        aria-labelledby="preview-unavailable-title"
        className="w-full max-w-[560px] overflow-hidden"
        style={{
          borderRadius: radius.cardLg,
          border: `1px solid ${expired ? color.selectedBorder : "rgba(251,191,36,.28)"}`,
          background: color.bg1,
          boxShadow: "0 24px 80px rgba(0,0,0,.28)",
        }}
      >
        <div
          aria-hidden="true"
          className="h-1 w-full"
          style={{ background: expired ? color.gradientPrimary : color.warning }}
        />
        <div className="flex flex-col gap-6 px-6 py-7 sm:px-8 sm:py-9">
          <div className="flex items-start gap-4">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              style={{
                background: expired ? color.selectedBg : "rgba(251,191,36,.10)",
                color: expired ? color.primary300 : color.warning,
              }}
            >
              {expired ? <Clock3 size={20} /> : <TriangleAlert size={20} />}
            </div>
            <div className="min-w-0 pt-0.5">
              <h1
                id="preview-unavailable-title"
                style={{ font: `600 18px ${font.heading}`, color: color.text }}
              >
                {expired
                  ? "Preview นี้หมดอายุแล้ว"
                  : unknown
                    ? "ยังตรวจสอบสถานะ Preview ไม่ได้"
                    : "ไฟล์ Preview ไม่พร้อมใช้งาน"}
              </h1>
              <p className="mt-2" style={{ fontSize: 13.5, lineHeight: 1.75, color: color.textSecondary }}>
                {expired
                  ? EXPIRED_COPY
                  : unknown
                    ? "ยังตรวจสอบสถานะไฟล์ Preview ไม่ได้ กรุณาสร้าง Preview ใหม่หรือติดต่อทีม Support เพื่อตรวจสอบ"
                    : "ไฟล์ Preview ไม่พร้อมใช้งานโดยไม่คาดคิด กรุณาสร้าง Preview ใหม่หรือติดต่อทีม Support เพื่อตรวจสอบ"}
              </p>
              {supportCode && (
                <p className="mt-3" style={{ fontSize: 11.5, color: color.textFaint }}>
                  รหัสสำหรับแจ้งทีมงาน: <code style={{ color: color.textSecondary }}>{supportCode}</code>
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <BtnPrimary
              onClick={onRerender}
              disabled={!canRerender}
              style={{
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                ...(!canRerender ? { opacity: 0.5, cursor: "not-allowed" } : {}),
              }}
            >
              <RefreshCw size={15} />
              สร้าง Preview ใหม่
            </BtnPrimary>
            {!expired && (
              <a
                href="/settings"
                className="flex min-h-11 items-center justify-center gap-2 px-6"
                style={{
                  borderRadius: radius.control + 1,
                  background: "rgba(255,255,255,.07)",
                  border: "1px solid rgba(255,255,255,.12)",
                  color: color.textSecondary,
                  font: `500 13.5px ${font.body}`,
                }}
              >
                <LifeBuoy size={15} />
                ติดต่อทีม Support
              </a>
            )}
          </div>

          <p style={{ fontSize: 11.5, lineHeight: 1.6, color: color.textFaintest }}>
            ข้อมูลสคริปต์และการตั้งค่าเดิมยังอยู่ ระบบจะเริ่มสร้าง Preview เมื่อคุณยืนยันในขั้นตอนปกติเท่านั้น
          </p>
        </div>
      </section>
    </main>
  );
}
