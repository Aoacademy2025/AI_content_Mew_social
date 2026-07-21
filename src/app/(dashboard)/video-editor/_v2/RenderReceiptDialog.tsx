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
import { AlertTriangle } from "lucide-react";
import { color, font } from "./tokens";
import { GlassPanel, BtnPrimary, BtnSecondary, GroupLabel } from "./ui";
import { buildReceipt } from "./receipt";
import { estimateClipSecV2 } from "./estimate";
import { PRESET_WEIGHTS, presetUsesAi } from "./mix-presets";
import { costKeyForKieModel, creditCostFor } from "@/lib/credit-costs";
import { CREDITS_LIVE_CLIENT } from "../_hooks/useCreditsQuota";
import type { V2Project } from "./useV2Project";

export function RenderReceiptDialog({ p, open, submitting, onConfirm, onCancel }: {
  p: V2Project;
  open: boolean;
  /** True while the confirmed submit is in flight — locks both buttons. */
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [balance, setBalance] = useState<number | null>(null);

  // Fresh credit balance each time the dialog opens (best-effort — same endpoint the
  // post-render receipt uses). null while loading → insufficient-credit warning stays
  // hidden until a real value lands (conservative: never warn on unknown).
  useEffect(() => {
    if (!open || !CREDITS_LIVE_CLIENT) return;
    let alive = true;
    setBalance(null);
    fetch("/api/credits/balance")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (alive) setBalance(typeof b?.total === "number" ? b.total : null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);

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

  // Per-image price from the SELECTED model, via the same map the server charges from.
  // Non-admins default to gpt-image-2 when unset (matches server coercion + the picker).
  const perImageCredits = useMemo(() => {
    if (p.brollSource === "kie-image") return creditCostFor("image-open-fast-1k");
    const effectiveModel = p.isAdmin ? p.kieModel : (p.kieModel || "gpt-image-2-text-to-image");
    const costKey = effectiveModel ? costKeyForKieModel(effectiveModel) : null;
    return costKey ? creditCostFor(costKey) : 0;
  }, [p.brollSource, p.isAdmin, p.kieModel]);

  const model = useMemo(
    () => buildReceipt({
      estSec,
      remainingMinutes: p.usage?.minutes?.remaining ?? null,
      totalMinutes: p.usage?.minutes?.limit ?? null,
      usesAi,
      presetWeights,
      perImageCredits,
      creditBalance: balance,
      minuteCreditRate: creditCostFor("minute"),
      hasAvatar: p.mode !== "upload" && p.useAvatar && !!p.avatarId,
      exactDuration,
      insufficientCreditBehavior: p.brollSource === "kie-image" ? "block" : "stock-fallback",
    }),
    [estSec, p.usage, usesAi, presetWeights, perImageCredits, balance, p.mode, p.useAvatar, p.avatarId, p.brollSource, exactDuration],
  );

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
          {model.lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start gap-2"
              style={{
                fontSize: 12.5,
                lineHeight: 1.6,
                fontFamily: font.body,
                color: l.kind === "warn" ? color.warning : color.textSecondary,
              }}
            >
              {l.kind === "warn" && (
                <AlertTriangle size={14} strokeWidth={1.8} style={{ marginTop: 2, flex: "none" }} />
              )}
              <span>{l.text}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-2 px-5 pb-5">
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
            disabled={submitting}
            style={submitting ? { opacity: 0.6, cursor: "wait" } : undefined}
          >
            {submitting ? "กำลังส่งงาน…" : "เริ่มเรนเดอร์"}
          </BtnPrimary>
        </div>
      </GlassPanel>
    </div>
  );
}
