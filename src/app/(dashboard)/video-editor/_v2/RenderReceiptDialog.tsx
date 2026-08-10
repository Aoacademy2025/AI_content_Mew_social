"use client";

/**
 * Render Receipt (D5) — mandatory pre-render summary dialog for Editor v2.
 * Sits between the render click and the actual submit: it discloses the estimated
 * minutes + AI credit spend (and any overflow) BEFORE the server's overflow auto-spend
 * (minute-credits.ts) runs. Numbers are estimates; the authoritative receipt is the
 * post-render fireCreditReceipt toast. Only mounted when NEXT_PUBLIC_CREDITS_LIVE==="1"
 * (the caller gates it), so with the flag off there is no behavioural change.
 *
 * Pure decision logic (which lines show + the interpolated values) lives in receipt.ts;
 * this component only wires live data (usage minutes, credit balance, selected model
 * price) into buildReceipt and renders the result.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { color, font } from "./tokens";
import { GlassPanel, BtnPrimary, BtnSecondary, GroupLabel } from "./ui";
import { buildReceipt } from "./receipt";
import { estimateClipSecV2 } from "./estimate";
import { PRESET_WEIGHTS, presetUsesAi } from "./mix-presets";
import { creditCostFor, HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { CREDITS_LIVE_CLIENT } from "../_hooks/useCreditsQuota";
import type { V2Project } from "./useV2Project";
import { fetchClientJson } from "@/lib/client-request-cache";

type CreditBalanceResponse = { total?: number; reserved?: number };
type VisualContextResponse = {
  reusableAiSceneIndices?: number[];
  preserveEstablishedAiDensity?: boolean;
};

export function RenderReceiptDialog({ p, open, submitting, onConfirm, onCancel }: {
  p: V2Project;
  open: boolean;
  /** True while the confirmed submit is in flight — locks both buttons. */
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [credits, setCredits] = useState<{ available: number; reserved: number } | null>(null);
  const [reusableAiSceneIndices, setReusableAiSceneIndices] = useState<number[]>([]);
  const [preserveEstablishedAiDensity, setPreserveEstablishedAiDensity] = useState(false);

  // Fresh credit balance each time the dialog opens (best-effort — same endpoint the
  // post-render receipt uses). null while loading → insufficient-credit warning stays
  // hidden until a real value lands (conservative: never warn on unknown).
  useEffect(() => {
    if (!open || !CREDITS_LIVE_CLIENT) return;
    let alive = true;
    setCredits(null);
    fetchClientJson<CreditBalanceResponse>("/api/credits/balance")
      .then((result) => {
        if (!alive) return;
        const b = result.ok ? result.data : null;
        setCredits(typeof b?.total === "number"
          ? {
              available: b.total,
              reserved: typeof b?.reserved === "number" ? b.reserved : 0,
            }
          : null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open || !(p.brandVisualAllowed || p.hasPersistedVisualPin) || !p.projectId || !p.brandContentPreflightId) {
      setReusableAiSceneIndices([]);
      setPreserveEstablishedAiDensity(false);
      return;
    }
    let alive = true;
    setReusableAiSceneIndices([]);
    setPreserveEstablishedAiDensity(false);
    fetchClientJson<VisualContextResponse>(
      `/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context?preflightId=${encodeURIComponent(p.brandContentPreflightId)}`,
    ).then((result) => {
      if (!alive || !result.ok) return;
      setReusableAiSceneIndices(Array.isArray(result.data?.reusableAiSceneIndices)
        ? result.data.reusableAiSceneIndices.filter((value) => Number.isSafeInteger(value) && value >= 0)
        : []);
      setPreserveEstablishedAiDensity(result.data?.preserveEstablishedAiDensity === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [open, p.brandVisualAllowed, p.hasPersistedVisualPin, p.projectId, p.brandContentPreflightId]);

  // Esc = กลับไปแก้ไข (blocked while submitting so we can't dismiss mid-submit).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !submitting) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onCancel]);

  // Upload mode knows the real file duration after metadata/upload. Script mode can only
  // estimate until TTS returns the actual audio duration.
  const estSec = useMemo(
    () => (p.mode === "upload" && p.clipDurationSec > 0 ? p.clipDurationSec : estimateClipSecV2(p.mode === "upload" ? "" : p.script)),
    [p.mode, p.script, p.clipDurationSec],
  );
  const exactDuration = p.mode === "upload" && p.clipDurationSec > 0;

  // AI usage: non-admins go by preset (ฟรีล้วน = none); admins by the raw b-roll source.
  const usesAi = p.brollSource === "kie-image" || (p.isAdmin
    ? p.brollSource === "automix"
    : presetUsesAi(p.mixPreset));

  const presetWeights = useMemo(() => {
    if (p.brollSource === "kie-image") return { video: 0, photo: 0, ai: 1 };
    if (!p.isAdmin) return PRESET_WEIGHTS[p.mixPreset];
    if (p.brollSource === "automix") return PRESET_WEIGHTS.recommended;
    return { video: 1, photo: 0, ai: 0 };
  }, [p.isAdmin, p.brollSource, p.mixPreset]);

  // Per-image price — ONE price for every customer AI image. Hero AI Image mode and
  // AutoMix "ai" slots both generate on the Hero RunPod seam (fetch-stock), charged
  // from the same cost key the server reserves against, so the quote cannot drift.
  const perImageCredits = useMemo(() => {
    return HERO_AI_IMAGE_CREDITS;
  }, []);

  const model = useMemo(
    () => buildReceipt({
      estSec,
      remainingMinutes: p.usage?.minutes?.remaining ?? null,
      totalMinutes: p.usage?.minutes?.limit ?? null,
      usesAi,
      presetWeights,
      perImageCredits,
      creditBalance: credits?.available ?? null,
      reservedCredits: credits?.reserved ?? 0,
      minuteCreditRate: creditCostFor("minute"),
      hasAvatar: p.mode !== "upload" && p.useAvatar && !!p.avatarId,
      exactDuration,
      insufficientCreditBehavior: p.brollSource === "kie-image" ? "block" : "stock-fallback",
      targetClipCount: p.targetClipCount,
      starterImageAllowance: p.starterAiImageAllowance?.eligible ? {
        remaining: p.starterAiImageAllowance.remainingImages,
        limit: p.starterAiImageAllowance.limitImages,
      } : null,
      reusableAiSceneIndices,
      preserveEstablishedAiDensity,
    }),
    [estSec, p.usage, usesAi, presetWeights, perImageCredits, credits, p.mode, p.useAvatar, p.avatarId, p.brollSource, p.targetClipCount, p.starterAiImageAllowance, reusableAiSceneIndices, preserveEstablishedAiDensity, exactDuration],
  );

  // Deficit disables the render CTA (Task 5 item B) — buildReceipt already computed
  // the exact "Hero credits ไม่พอ" line above; reuse that decision instead of
  // re-deriving a second insufficiency check that could drift from it.
  const insufficientCredits = model.lines.some((l) => l.key === "insufficient" || l.key === "allowance-insufficient");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(6,6,12,.62)" }}
      onClick={() => { if (!submitting) onCancel(); }}
    >
      <GlassPanel
        className="flex w-[440px] max-w-full flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="สรุปก่อนเรนเดอร์"
      >
        <div className="px-5 pb-1 pt-4"><GroupLabel>สรุปก่อนเรนเดอร์</GroupLabel></div>

        <div className="flex flex-col gap-2 px-5 pb-4 pt-2">
          {[
            ...model.lines.filter((l) => l.key === "credits" || l.key === "insufficient"),
            ...model.lines.filter((l) => l.key !== "credits" && l.key !== "insufficient"),
          ].map((l) => (
            <div
              key={l.key}
              className={`flex items-start gap-2 ${l.kind === "info" ? "" : "rounded-xl px-3 py-2.5"}`}
              role={l.kind === "warn" ? "alert" : l.kind === "success" ? "status" : undefined}
              style={{
                fontSize: l.kind === "info" ? 12.5 : 13,
                lineHeight: 1.6,
                fontFamily: font.body,
                fontWeight: l.kind === "info" ? 400 : 600,
                color: l.kind === "warn"
                  ? color.warning
                  : l.kind === "success"
                    ? color.success
                    : color.textSecondary,
                background: l.kind === "warn"
                  ? "rgba(251,191,36,.08)"
                  : l.kind === "success"
                    ? "rgba(52,211,153,.08)"
                    : undefined,
                border: l.kind === "warn"
                  ? "1px solid rgba(251,191,36,.20)"
                  : l.kind === "success"
                    ? "1px solid rgba(52,211,153,.20)"
                    : undefined,
              }}
            >
              {l.kind === "warn" && (
                <AlertTriangle size={14} strokeWidth={1.8} style={{ marginTop: 2, flex: "none" }} />
              )}
              {l.kind === "success" && (
                <CheckCircle2 size={14} strokeWidth={2} style={{ marginTop: 2, flex: "none" }} />
              )}
              <span>{l.text}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 px-5 pb-5">
          <div className="flex gap-2">
            <BtnSecondary
              className="flex-1"
              onClick={onCancel}
              disabled={submitting}
              style={submitting ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              กลับไปแก้ไข
            </BtnSecondary>
            <BtnPrimary
              className="flex-1"
              onClick={onConfirm}
              disabled={submitting || insufficientCredits}
              title={insufficientCredits ? "เครดิตไม่พอ — เติมเครดิตก่อนเริ่มเรนเดอร์" : undefined}
              style={submitting
                ? { opacity: 0.6, cursor: "wait" }
                : insufficientCredits
                  ? { opacity: 0.5, cursor: "not-allowed" }
                  : undefined}
            >
              {submitting ? "กำลังส่งงาน…" : "เริ่มเรนเดอร์"}
            </BtnPrimary>
          </div>
          {insufficientCredits && (
            <a
              href="/pricing?from=editor"
              className="flex min-h-11 items-center justify-center rounded-lg text-center focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                fontSize: 12.5, fontWeight: 500, color: color.primary300,
                background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
                padding: "10px 16px",
              }}
            >
              {p.starterAiImageAllowance?.eligible ? "ดูแผนรายเดือน" : "เติมเครดิต"}
            </a>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
