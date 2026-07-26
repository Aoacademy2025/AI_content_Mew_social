"use client";

import { Eye, EyeOff } from "lucide-react";
import type { EditableEditorLayer } from "@/lib/editor-layer-visibility";
import { color, font, radius } from "./tokens";

type LayerState = Record<EditableEditorLayer, boolean>;

export function LayerVisibilityControls({
  hasAvatar,
  hasLogo,
  visibility,
  availability,
  disabled = false,
  onChange,
}: {
  hasAvatar: boolean;
  hasLogo: boolean;
  visibility: LayerState;
  availability: LayerState;
  disabled?: boolean;
  onChange: (layer: EditableEditorLayer, enabled: boolean) => void;
}) {
  const rows: Array<{
    id: EditableEditorLayer;
    label: string;
    description: string;
    color: string;
    unavailableReason: string;
  }> = [
    ...(hasAvatar ? [{
      id: "avatar" as const,
      label: "อวตาร",
      description: "ภาพพิธีกร AI",
      color: color.trackAvatar,
      unavailableReason: "วิดีโองานเก่านี้รวมอวตารไว้แล้ว จึงปิดแยกไม่ได้",
    }] : []),
    {
      id: "subtitles",
      label: "ซับไทย",
      description: "ข้อความและเอฟเฟกต์ซับ",
      color: color.trackSub,
      unavailableReason: "วิดีโอนี้ไม่มีซับให้เปิด–ปิด",
    },
    ...(hasLogo ? [{
      id: "logo" as const,
      label: "โลโก้",
      description: "โลโก้ที่แสดงตลอดคลิป",
      color: color.primary300,
      unavailableReason: "ยังไม่ได้เพิ่มโลโก้",
    }] : []),
  ];

  return (
    <div className="pt-2">
      <p style={{ margin: "0 0 10px", color: color.textSecondary, fontSize: 12, lineHeight: 1.6 }}>
        ปิดชั่วคราวโดยไม่ลบการตั้งค่า และมีผลกับทั้ง Preview และไฟล์ส่งออก
      </p>
      <div
        style={{
          borderTop: `1px solid ${color.cardBorder}`,
          borderBottom: `1px solid ${color.cardBorder}`,
        }}
      >
        {rows.map((row, index) => {
          const enabled = visibility[row.id];
          const available = availability[row.id];
          const controlDisabled = disabled || !available;
          return (
            <button
              key={row.id}
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-describedby={!available ? `layer-${row.id}-reason` : undefined}
              disabled={controlDisabled}
              onClick={() => onChange(row.id, !enabled)}
              className="layer-visibility-row flex w-full items-center gap-3 text-left"
              style={{
                minHeight: 64,
                padding: "9px 2px",
                border: "none",
                borderTop: index === 0 ? "none" : `1px solid ${color.cardBorder}`,
                background: "transparent",
                color: color.text,
                cursor: controlDisabled ? "not-allowed" : "pointer",
                opacity: controlDisabled ? 0.52 : 1,
                fontFamily: font.body,
              }}
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                style={{
                  color: enabled ? row.color : color.textFaint,
                  background: enabled ? `${row.color}1A` : "rgba(255,255,255,.04)",
                  border: `1px solid ${enabled ? `${row.color}40` : color.cardBorder}`,
                }}
              >
                {enabled ? <Eye size={18} /> : <EyeOff size={18} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block" style={{ font: `500 13.5px ${font.heading}`, color: color.text }}>
                  {row.label}
                </span>
                <span
                  id={!available ? `layer-${row.id}-reason` : undefined}
                  className="block"
                  style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.45, color: color.textFaint }}
                >
                  {available ? row.description : row.unavailableReason}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="relative h-7 w-12 shrink-0 rounded-full"
                style={{
                  background: enabled && available ? color.primary500 : "rgba(255,255,255,.10)",
                  border: `1px solid ${enabled && available ? color.selectedBorderStrong : color.cardBorder}`,
                  transition: "background 150ms ease, border-color 150ms ease",
                }}
              >
                <span
                  className="absolute top-1/2 h-5 w-5 rounded-full"
                  style={{
                    left: enabled && available ? 25 : 3,
                    transform: "translateY(-50%)",
                    background: enabled && available ? "#FFFFFF" : color.textFaint,
                    boxShadow: "0 1px 4px rgba(0,0,0,.35)",
                    transition: "left 150ms ease",
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>
      <style>{`
        .layer-visibility-row:focus-visible {
          outline: 2px solid ${color.primary300};
          outline-offset: 3px;
          border-radius: ${radius.control}px;
        }
        @media (hover: hover) {
          .layer-visibility-row:not(:disabled):hover {
            background: rgba(255,255,255,.035) !important;
          }
        }
      `}</style>
    </div>
  );
}
