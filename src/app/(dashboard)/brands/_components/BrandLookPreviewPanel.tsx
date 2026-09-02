"use client";

import Link from "next/link";
import { Eye, ImageIcon, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MeData } from "@/lib/use-me";
import type { BrandImageAccess, PreviewBatch } from "./types";

type Allowance = MeData["starterAiImageAllowance"];

const PHASE_LABEL: Record<string, string> = {
  hook: "ฉากเปิด",
  explain: "ฉากอธิบาย",
  close: "ฉากปิด",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "พร้อมแล้ว",
  partial: "สำเร็จบางภาพ",
  failed: "สร้างไม่สำเร็จ",
};

export function BrandLookPreviewPanel({
  preview,
  previewGenerationCount,
  allowance,
  imageAccess,
  canPublish,
  busy,
  disabled,
  onPreview,
  onReroll,
}: {
  preview: PreviewBatch | null;
  previewGenerationCount: number | null;
  allowance: Allowance;
  imageAccess: BrandImageAccess;
  canPublish: boolean;
  busy: string | null;
  disabled: boolean;
  onPreview: () => void;
  onReroll: (itemId: string) => void;
}) {
  const imagesToGenerate = previewGenerationCount ?? 0;
  const imagesToReuse = 3 - imagesToGenerate;
  const costLabel = imagesToGenerate === 0
    ? "นำภาพเดิมมาใช้ครบ โดยไม่หักสิทธิ์หรือเครดิต"
    : allowance?.eligible
      ? `ใช้สิทธิ์ทดลอง ${imagesToGenerate} ภาพ`
      : `${imagesToGenerate * 2} เครดิต (${imagesToGenerate} ภาพ × 2 เครดิต)`;
  const fundingInsufficient = allowance?.eligible === true
    && allowance.remainingImages < imagesToGenerate;
  // ADR 0059: the Brand Library stays open to every plan — the paid/rollout gate
  // is disclosed here, on the button that actually spends an AI image.
  const disabledReason: React.ReactNode = busy !== null
    ? null
    : !canPublish
      ? "ตั้งชื่อแบรนด์ก่อนจึงจะทดลองภาพได้"
      : previewGenerationCount === null
        ? "กำลังตรวจภาพเดิมและคำนวณสิทธิ์ที่ต้องใช้…"
        : fundingInsufficient
          ? "สิทธิ์ทดลองภาพไม่พอสำหรับจำนวนภาพที่ต้องสร้าง"
          : !imageAccess.canUse
            ? imageAccess.reason === "payment_required"
              ? (
                <>
                  ภาพ AI ประจำแบรนด์ใช้ได้กับสมาชิก PRO และ BUSINESS{" "}
                  <Link href={imageAccess.upgradeUrl} className="font-semibold text-violet-500 underline underline-offset-4">
                    ดูแผนรายเดือน
                  </Link>
                </>
              )
              : imageAccess.reason === "rollout_wait"
                ? "ระบบกำลังทยอยเปิดภาพ AI ประจำแบรนด์ให้สมาชิก บัญชีนี้จะได้รับสิทธิ์ในรอบถัดไป"
                : "ภาพ AI ประจำแบรนด์ยังไม่เปิดให้บัญชีนี้"
            : null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Eye className="h-4 w-4 text-violet-500" />
            ทดลองฉากเปิด · ฉากอธิบาย · ฉากปิด
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {previewGenerationCount === null
              ? "กำลังตรวจภาพเดิมและคำนวณสิทธิ์ที่ต้องใช้…"
              : `${costLabel}${imagesToReuse > 0 ? ` · ใช้ภาพเดิม ${imagesToReuse} ภาพ` : ""}`}
          </p>
        </div>
        <Button
          type="button"
          onClick={onPreview}
          disabled={disabled || busy !== null || !canPublish || previewGenerationCount === null || fundingInsufficient || !imageAccess.canUse}
          className="h-10 bg-violet-600 text-white hover:bg-violet-600/90"
        >
          {busy === "preview" || previewGenerationCount === null ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageIcon className="h-4 w-4" />
          )}
          ทดลอง 3 ภาพ
        </Button>
      </div>

      {disabledReason && (
        <p data-testid="preview-disabled-reason" className="mt-2 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      )}

      {fundingInsufficient && (
        <Link
          href="/pricing"
          className="mt-3 inline-block text-xs font-semibold text-violet-500 underline underline-offset-4"
        >
          สิทธิ์ไม่พอ — ดูแผนรายเดือน
        </Link>
      )}

      {preview && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">ภาพทดลองแนวประจำแบรนด์</p>
            <span className="text-[11px] text-muted-foreground">
              {STATUS_LABEL[preview.status] ?? "กำลังสร้าง"}
            </span>
          </div>
          {/* Phones get two columns; a third ~100px tile leaves no room for the
              reroll control, which is why it sits BELOW the tile (full width, 44px
              tap target) until sm. From sm up the tile grid and the overlaid button
              are exactly as they were on desktop (#330). */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {preview.items.map((item) => (
              <div key={item.id} className="relative min-w-0">
                <figure className="relative aspect-[9/16] overflow-hidden rounded-lg bg-muted">
                  {item.outputUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.outputUrl}
                      alt={`ภาพทดลอง ${PHASE_LABEL[item.phase] ?? item.phase}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-2 text-center text-xs text-destructive">
                      {item.errorCode || "สร้างไม่สำเร็จ"}
                    </div>
                  )}
                  <figcaption className="absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1.5 text-[10px] font-medium text-white">
                    {PHASE_LABEL[item.phase] ?? item.phase} ·{" "}
                    {item.sourceType === "reused" ? "ใช้ภาพเดิม" : "ภาพใหม่"}
                  </figcaption>
                </figure>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => onReroll(item.id)}
                  disabled={disabled || busy !== null}
                  className="mt-2 h-11 w-full whitespace-normal sm:absolute sm:right-2 sm:top-2 sm:mt-0 sm:h-8 sm:w-auto sm:whitespace-nowrap"
                >
                  {busy === `reroll:${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  ลองภาพนี้ใหม่
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            ลองใหม่คิด 1 ภาพ ({allowance?.eligible ? "สิทธิ์ทดลอง 1 ภาพ" : "2 เครดิต"})
            และหากล้มเหลวภาพเดิมจะไม่หาย
          </p>
        </div>
      )}
    </Card>
  );
}
