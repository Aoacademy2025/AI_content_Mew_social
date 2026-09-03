"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ImageIcon, Loader2, LockKeyhole, RefreshCcw, Sparkles, SwatchBook } from "lucide-react";
import { toast } from "sonner";
import { trackEvent } from "@/lib/client-telemetry";
import { shouldLoadBrandVisualContext } from "@/lib/automix-plan";
import type { TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import {
  visualFormatThaiLabel,
  type ActiveVisualFormatId,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import {
  buildTreatmentChoiceGroups,
  buildVisualSummary,
} from "@/lib/brand-treatment-presentation";
import { StylePackPicker } from "@/app/(dashboard)/brands/_components/StylePackPicker";
import type { StylePackId } from "@/lib/style-pack-catalog";
import {
  sceneContentPolicyFromPreference,
  type SceneContentPolicyWarning,
} from "@/lib/scene-content-policy";
import type { V2Project } from "./useV2Project";
import type { ProjectStylePack } from "./project-style-pack";
import { color, font, radius } from "./tokens";

type VisualFormat = { id: ActiveVisualFormatId; label: string; description: string; previewUrl: string };
/** Exactly what /api/brand-library publishes about a ready-made style. The
 * catalog itself never ships to the browser: only ACTIVE styles are listed
 * there (ADR 0058), so a style still awaiting its benchmark cannot be tapped. */
type StylePackOption = {
  id: StylePackId;
  thaiLabel: string;
  tagline: string;
  palette: [string, string, string];
  sampleImage: string;
};
type TreatmentOption = { id: TreatmentPresetId; label: string };
type Profile = { id: string; name: string; frozen: boolean; legacyVisualFormat: boolean; activeRevisionNumber: number; activeRevisionId: string | null };
type Preflight = {
  id: string;
  sourceHash: string;
  suggestedVisualFormatId: ActiveVisualFormatId;
  suggestedTreatment: { presetId: TreatmentPresetId; version: string; label: string; rationale: string };
  rankedTreatmentPresetIds: TreatmentPresetId[];
  formatRecommendation?: { visualFormatId: ActiveVisualFormatId; reason: string } | null;
  visualBeats: Array<{ id: string; status: string; existingAssetUrl: string | null }>;
  policyWarnings?: SceneContentPolicyWarning[];
};
type Context = {
  source: "project-look" | "brand-revision" | "suggested";
  visualFormatId: VisualFormatId;
  treatment: string;
  treatmentPin?: { presetId: TreatmentPresetId; version: string };
  legacyCustomTreatment?: boolean;
};
type SelectedBrandProfile = { profileId: string; name: string; revisionId: string; revisionNumber: number };
export type BrandVisualPreflightStatus = "idle" | "loading" | "ready" | "error";
type PendingChange =
  | { kind: "look"; formatId: ActiveVisualFormatId; treatmentPresetId: TreatmentPresetId; label: string; existingImageCount: number; quotedCredits: number }
  | { kind: "pack"; packId: StylePackId | null; label: string; existingImageCount: number; quotedCredits: number }
  | { kind: "profile"; profileId: string; revisionId?: string; label: string; existingImageCount: number; quotedCredits: number };

const TARGET_CLIP_COUNT_SETTLE_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}

function PendingChangeConfirmation({
  p,
  pending,
  changing,
  onConfirm,
  onCancel,
}: {
  p: V2Project;
  pending: PendingChange;
  changing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <div aria-live="polite" className="mt-3 rounded-xl p-3" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.28)" }}>
    <div className="flex gap-2">
      <ImageIcon size={15} color={color.warning} className="mt-0.5 shrink-0" />
      <div>
        <p style={{ color: color.text, font: `600 11.5px ${font.heading}` }}>ยังไม่ได้เปลี่ยนเป็น “{pending.label}”</p>
        <p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>คลิปนี้มีภาพ AI เดิม {pending.existingImageCount} ภาพ การเปลี่ยนแนวต้องสร้างภาพชุดนี้ใหม่ทั้งหมด ({imageFundingText(p, pending.existingImageCount)}) หรือยกเลิกเพื่อเก็บแนวเดิม</p>
        {starterFundingInsufficient(p, pending.existingImageCount) && <p className="mt-1" style={{ color: color.dangerText, fontSize: 10.5 }}>สิทธิ์ทดลองไม่พอสำหรับสร้างภาพทั้งหมด กรุณาอัปเกรดหรือยกเลิกเพื่อเก็บแนวเดิม</p>}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={changing || starterFundingInsufficient(p, pending.existingImageCount)} onClick={onConfirm} className="min-h-9 rounded-lg px-3 disabled:opacity-40" style={{ background: color.warning, color: color.bg0, fontSize: 10.5, fontWeight: 700 }}>สร้างทุกภาพใหม่ให้เป็นแนวเดียวกัน</button>
      <button type="button" disabled={changing} onClick={onCancel} className="min-h-9 rounded-lg px-3" style={{ color: color.textFaint, fontSize: 10.5 }}>ยกเลิก</button>
    </div>
  </div>;
}

async function payload(response: Response) {
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function imageFundingText(p: V2Project, imageCount: number): string {
  const allowance = p.starterAiImageAllowance;
  if (!allowance?.eligible) return `${imageCount * 2} เครดิต (${imageCount} ภาพ × 2 เครดิต)`;
  return allowance.remainingImages >= imageCount
    ? `สิทธิ์ทดลอง ${imageCount} ภาพ · หลังสร้างจะเหลือ ${allowance.remainingImages - imageCount}/${allowance.limitImages}`
    : `ต้องใช้สิทธิ์ทดลอง ${imageCount} ภาพ แต่เหลือ ${allowance.remainingImages}/${allowance.limitImages}`;
}

function starterFundingInsufficient(p: V2Project, imageCount: number): boolean {
  return p.starterAiImageAllowance?.eligible === true
    && p.starterAiImageAllowance.remainingImages < imageCount;
}

export function BrandVisualSelector({
  p,
  onPreflightStatusChange,
  onPolicyWarningsChange,
  onSelectionBlockedChange,
}: {
  p: V2Project;
  onPreflightStatusChange?: (status: BrandVisualPreflightStatus) => void;
  onPolicyWarningsChange?: (warnings: SceneContentPolicyWarning[]) => void;
  onSelectionBlockedChange?: (blocked: boolean) => void;
}) {
  const [formats, setFormats] = useState<VisualFormat[]>([]);
  const [treatmentPresets, setTreatmentPresets] = useState<TreatmentOption[]>([]);
  const [stylePacks, setStylePacks] = useState<StylePackOption[]>([]);
  const [packPickerOpen, setPackPickerOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [selectedBrandProfile, setSelectedBrandProfile] = useState<SelectedBrandProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showAllTreatments, setShowAllTreatments] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryAuthorized, setLibraryAuthorized] = useState(false);

  const narrative = p.script.trim();
  const canLoadWithoutNarrative = p.mode === "upload";
  const canChooseFormatBeforeTranscript = p.mode === "upload" && !narrative;
  const settledTargetClipCount = useDebouncedValue(
    p.targetClipCount,
    TARGET_CLIP_COUNT_SETTLE_MS,
  );
  // People/location is part of Content Preflight, not the persisted Visual
  // Context. Before an Upload has a transcript it has no semantic work to
  // refresh; once a Narrative Source exists, rapid changes settle into one
  // replacement preflight instead of flashing the panel per click.
  const sceneContentPreference = narrative ? p.brollRegionPreference : null;
  const settledSceneContentPreference = useDebouncedValue(
    sceneContentPreference,
    TARGET_CLIP_COUNT_SETTLE_MS,
  );
  const treatment = context?.legacyCustomTreatment
    ? "ใช้แนวที่ตั้งไว้เดิม"
    : context?.treatment?.trim() || preflight?.suggestedTreatment.label || "กำลังเลือกจากเนื้อหา";
  const outdatedBeatCount = preflight?.visualBeats.filter((beat) => beat.status === "outdated").length ?? 0;
  // The long-lived Editor can cross a rolling deploy with an older capability
  // snapshot. Internal candidates therefore confirm access against the actual
  // Brand Library endpoint instead of permanently hiding the selector. The
  // endpoint remains authoritative: a kill switch/downgrade returns 403 and
  // `libraryAuthorized` stays false.
  const canProbeBrandLibrary = p.brandVisualAllowed || p.isAdmin || p.heroAiBeta;
  const canManageBrandVisual = p.brandVisualAllowed || libraryAuthorized;
  const canRenderPersistedVisual = canManageBrandVisual || p.hasPersistedVisualPin;
  const visualSelectionEnabled = p.brollSource === "kie-image"
    || (p.brollSource === "automix" && p.mixPreset !== "free")
    || p.hasPersistedVisualPin
    || Boolean(pending);
  const shouldLoadVisualContext = shouldLoadBrandVisualContext({
    brollSource: p.brollSource,
    mixPreset: p.mixPreset,
    hasPersistedVisualPin: p.hasPersistedVisualPin,
    settingsOpen: expanded,
  });

  async function loadLibrary(signal?: AbortSignal) {
    if (!canProbeBrandLibrary) {
      setLibraryAuthorized(false);
      return;
    }
    const result = await fetch("/api/brand-library", { cache: "no-store", signal }).then(payload);
    if (result.response.status === 401 || result.response.status === 403) {
      setLibraryAuthorized(false);
      return;
    }
    if (!result.response.ok) throw new Error(result.body.error || "โหลดคลังแบรนด์ไม่สำเร็จ");
    setLibraryAuthorized(true);
    setFormats(result.body.visualFormats ?? []);
    setTreatmentPresets(result.body.treatmentPresets ?? []);
    setProfiles(result.body.profiles ?? []);
    setStylePacks((result.body.stylePacks ?? []) as StylePackOption[]);
  }

  async function loadContext(signal?: AbortSignal) {
    if (!p.projectId || (!narrative && !canLoadWithoutNarrative)) return;
    // A valid preflight remains visible and render-authoritative until its
    // replacement succeeds. Step 2's status still blocks rendering while this
    // refresh runs, so preserving the panel cannot submit stale scene windows.
    setLoading(true); setError(null); onPreflightStatusChange?.("loading");
    try {
      const preflightResult = narrative
        ? await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/content-preflight`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              previousPreflightId: preflight?.id ?? undefined,
              narrativeSource: {
                kind: p.mode === "upload" ? "upload-transcript" : p.narrativeSourceKind,
                text: narrative,
                ...(settledTargetClipCount > 0 ? { windowCount: settledTargetClipCount } : {}),
                sceneContentPolicy: sceneContentPolicyFromPreference(
                  settledSceneContentPreference ?? p.brollRegionPreference,
                ),
              },
            }),
            signal,
          }).then(payload)
        : null;
      if (preflightResult && !preflightResult.response.ok) throw new Error(preflightResult.body.error || "วิเคราะห์เนื้อหาไม่สำเร็จ");
      const resolvedPreflight = preflightResult?.body.preflight as Preflight | null ?? null;
      if (narrative && (!resolvedPreflight || !Array.isArray(resolvedPreflight.visualBeats) || resolvedPreflight.visualBeats.length === 0)) {
        throw new Error("วิเคราะห์ฉากสำหรับแนวภาพยังไม่ครบ กรุณาลองอีกครั้ง");
      }
      const preflightQuery = resolvedPreflight
        ? `?preflightId=${encodeURIComponent(resolvedPreflight.id)}`
        : "";
      const visualResult = await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context${preflightQuery}`, {
        cache: "no-store",
        signal,
      }).then(payload);
      if (!visualResult.response.ok) throw new Error(visualResult.body.error || "โหลดแนวภาพไม่สำเร็จ");
      setPreflight(resolvedPreflight);
      onPolicyWarningsChange?.(resolvedPreflight?.policyWarnings ?? []);
      setContext(visualResult.body.context);
      if (Array.isArray(visualResult.body.treatmentPresets)) {
        setTreatmentPresets(visualResult.body.treatmentPresets);
      }
      setSelectedBrandProfile(visualResult.body.selectedBrandProfile ?? null);
      // The pinned Style Pack drives Step 2's read-only footage-style line AND
      // the per-window search body, so it is lifted into project state rather
      // than kept local to this panel.
      p.setProjectStylePack((visualResult.body.stylePack as ProjectStylePack | null) ?? null);
      p.setBrandContentPreflightId(resolvedPreflight?.id ?? null);
      if (narrative) onPreflightStatusChange?.("ready");
      else onPreflightStatusChange?.("idle");
      trackEvent("brand_visual_step2_reached", {
        path: "/video-editor",
        properties: {
          source: visualResult.body.context?.source,
          visualFormatId: visualResult.body.context?.visualFormatId,
          beatCount: preflightResult?.body.preflight?.visualBeats?.length ?? 0,
        },
      });
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        p.setBrandContentPreflightId(null);
        p.setProjectStylePack(null);
        onPolicyWarningsChange?.([]);
        setError(caught instanceof Error ? caught.message : "โหลดแนวภาพไม่สำเร็จ");
        onPreflightStatusChange?.("error");
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => {
    if (!canProbeBrandLibrary) {
      setLibraryAuthorized(false);
      return;
    }
    const controller = new AbortController();
    void loadLibrary(controller.signal).catch((caught) => {
      if ((caught as Error).name !== "AbortError") {
        setError(caught instanceof Error ? caught.message : "โหลดคลังแบรนด์ไม่สำเร็จ");
      }
    });
    return () => controller.abort();
  }, [canProbeBrandLibrary]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (
      !preflight
      || !canRenderPersistedVisual
      || !shouldLoadVisualContext
      || !p.projectId
      || (!narrative && !canLoadWithoutNarrative)
    ) return;
    // Block the render CTA as soon as the creator touches the count, but keep
    // the current panel mounted while the spinner value settles. Returning to
    // the already-analyzed count before the debounce expires cancels the
    // refresh and immediately restores readiness.
    onPreflightStatusChange?.(
      p.targetClipCount === settledTargetClipCount
        && sceneContentPreference === settledSceneContentPreference
        ? "ready"
        : "loading",
    );
  }, [canRenderPersistedVisual, shouldLoadVisualContext, p.projectId, narrative, canLoadWithoutNarrative, p.targetClipCount, settledTargetClipCount, sceneContentPreference, settledSceneContentPreference, preflight, onPreflightStatusChange]);

  useEffect(() => {
    if (!canRenderPersistedVisual || !shouldLoadVisualContext || !p.projectId || (!narrative && !canLoadWithoutNarrative)) {
      p.setBrandContentPreflightId(null);
      onPolicyWarningsChange?.([]);
      onPreflightStatusChange?.("idle");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadContext(controller.signal);
    return () => controller.abort();
  }, [canRenderPersistedVisual, shouldLoadVisualContext, p.projectId, narrative, p.mode, settledTargetClipCount, settledSceneContentPreference, onPreflightStatusChange, onPolicyWarningsChange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onSelectionBlockedChange?.(changing || pending !== null);
  }, [changing, onSelectionBlockedChange, pending]);

  useEffect(() => () => {
    onSelectionBlockedChange?.(false);
  }, [onSelectionBlockedChange]);

  async function applyLook(
    formatId: ActiveVisualFormatId,
    treatmentPresetId?: TreatmentPresetId,
    applyMode?: "regenerate-all",
  ) {
    if (!p.projectId) return;
    if (!treatmentPresetId && !canChooseFormatBeforeTranscript) return;
    setChanging(true); setPending(null);
    const requestBody = treatmentPresetId
      ? {
          look: { visualFormatId: formatId, treatmentPresetId },
          deferTreatmentUntilPreflight: !treatmentPresetId,
          applyMode,
          preflightId: preflight?.id,
        }
      : {
          look: { visualFormatId: formatId },
          deferTreatmentUntilPreflight: !treatmentPresetId,
          applyMode,
          preflightId: preflight?.id,
        };
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      if (treatmentPresetId) {
        setPending({ kind: "look", formatId, treatmentPresetId, label: treatmentPresets.find((item) => item.id === treatmentPresetId)?.label ?? treatmentPresetId, existingImageCount: result.body.existingImageCount, quotedCredits: result.body.quotedCredits });
        setExpanded(true);
      } else {
        toast.error(result.body.error || "โปรเจกต์นี้มีผลวิเคราะห์เดิม กรุณาโหลดข้อมูลล่าสุดก่อนเปลี่ยนแนวภาพ");
      }
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เปลี่ยนแนวภาพไม่สำเร็จ");
    } else {
      const look = result.body.look;
      setContext({
        source: "project-look",
        visualFormatId: formatId,
        treatment: typeof look?.treatment === "string" ? look.treatment : treatment,
        treatmentPin: look?.treatmentPin,
      });
      p.setHasPersistedVisualPin(true);
      // Choosing a format or a narrative style unlinks the ready-made style
      // SERVER-side, so the panel must re-read what is actually pinned. Without
      // this the summary keeps naming the old style, Step 2 keeps printing
      // "จากคลิปนี้", and the per-window search keeps sending its stock mood.
      await loadContext();
      toast.success(applyMode === "regenerate-all" ? "บันทึกแนวภาพแล้ว — รอคุณยืนยันฉากที่จะสร้างใหม่" : "บันทึกแนวภาพของคลิปนี้แล้ว");
    }
    setChanging(false);
  }

  /** Choosing a ready-made style for THIS clip. It travels the same Project
   * Look save path as the format/treatment controls below — same ownership
   * check, same existing-image confirmation, same image guard (ADR 0059
   * amendment). The server resolves the style: the browser sends only its id,
   * never a format, treatment, palette or stock mood of its own.
   *
   * `null` is "กำหนดเอง": unlink the style but keep the look it resolved, then
   * hand the creator the format/treatment controls that were always there.
   *
   * This is also the ONE seam every per-clip style choice passes through, so a
   * later `style_pack_selected` / `surface: "project"` event has exactly one
   * place to be emitted from. */
  async function applyStylePackChoice(
    packId: StylePackId | null,
    applyMode?: "regenerate-all",
  ) {
    if (!p.projectId) return;
    let look: { look: Record<string, unknown> };
    if (packId) {
      look = { look: { stylePackId: packId } };
    } else {
      setPackPickerOpen(false);
      const keptFormatId = selectedActiveFormat?.id;
      const keptTreatmentPresetId = selectedTreatmentPresetId;
      // Nothing linked yet, or nothing resolved to keep: just reveal the
      // controls instead of writing a look the creator never chose.
      if (!p.projectStylePack || !keptFormatId || !keptTreatmentPresetId) return;
      look = { look: { visualFormatId: keptFormatId, treatmentPresetId: keptTreatmentPresetId, stylePackId: null } };
    }
    setChanging(true); setPending(null);
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...look, applyMode, preflightId: preflight?.id }),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      // Unlinking is a look change too: it must offer the same all-or-cancel
      // confirmation, never a dead-end error the creator cannot act on.
      setPending({
        kind: "pack",
        packId,
        label: packId
          ? stylePacks.find((pack) => pack.id === packId)?.thaiLabel ?? packId
          : "กำหนดเอง",
        existingImageCount: result.body.existingImageCount,
        quotedCredits: result.body.quotedCredits,
      });
      setExpanded(true);
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เปลี่ยนสไตล์ของคลิปนี้ไม่สำเร็จ");
    } else {
      p.setHasPersistedVisualPin(true);
      setPackPickerOpen(false);
      // The authoritative style — including the exact footage mood the
      // per-window search must send back — is only known to the server, so the
      // panel re-reads it instead of guessing from the card that was tapped.
      await loadContext();
      toast.success(packId ? "ใช้สไตล์นี้กับคลิปนี้แล้ว" : "คลิปนี้กำหนดแนวภาพเองแล้ว");
    }
    setChanging(false);
  }

  async function pinProfile(
    profileId: string,
    applyMode?: "regenerate-all",
    revisionId?: string,
  ) {
    if (!p.projectId) return;
    setChanging(true); setPending(null);
    if (!await p.flushPendingProjectDraft()) {
      toast.error("บันทึกข้อมูลโปรเจกต์ล่าสุดไม่สำเร็จ กรุณาลองใหม่ก่อนเลือกแบรนด์");
      setChanging(false);
      return;
    }
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/brand-revision`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId, revisionId, applyMode, preflightId: preflight?.id }),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      setPending({ kind: "profile", profileId, revisionId, label: profiles.find((item) => item.id === profileId)?.name ?? "แบรนด์นี้", existingImageCount: result.body.existingImageCount, quotedCredits: result.body.quotedCredits });
      setExpanded(true);
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เลือกแบรนด์ไม่สำเร็จ");
    } else {
      p.setHasPersistedVisualPin(true);
      const accepted = result.body.project
        && typeof result.body.project === "object"
        && p.acceptAuthoritativeProjectSnapshot(result.body.project as Record<string, unknown>);
      if (!accepted) {
        // The draft was flushed before the atomic Brand pin, so the server is
        // authoritative and already durable. Replaying Revision defaults through
        // public setters here creates a second autosave lineage and can turn one
        // rolling-deploy mismatch into an invalid local draft. Reload the exact
        // saved project instead; this preserves both the upload and the Brand pin.
        trackEvent("brand_profile_snapshot_recovery", {
          category: "error",
          step: "editor.step2",
          status: "error",
          properties: {
            projectId: p.projectId,
            profileId,
            responseHadProject: Boolean(result.body.project),
          },
        });
        toast.error("บันทึกแบรนด์แล้ว กำลังโหลดข้อมูลโปรเจกต์ล่าสุด");
        setChanging(false);
        window.location.reload();
        return;
      }
      toast.success("คลิปนี้ใช้แนวภาพของแบรนด์ที่เลือกแล้ว");
      await loadContext();
    }
    setChanging(false);
  }

  if (!canRenderPersistedVisual) return null;
  if (!narrative && !canLoadWithoutNarrative) return <div className="px-3 py-3" style={{ border: `1px dashed ${color.cardBorder}`, borderRadius: radius.card, color: color.textFaint, fontSize: 11.5 }}>ใส่สคริปต์ก่อน ระบบจึงจะแนะนำแนวภาพจากเนื้อหาจริง</div>;

  const selected = context?.visualFormatId ?? preflight?.suggestedVisualFormatId;
  const selectedActiveFormat = formats.find((item) => item.id === selected);
  const selectedFormatLabel = selectedActiveFormat?.label
    ?? (selected ? visualFormatThaiLabel(selected) : undefined);
  const selectedTreatmentPresetId = context?.treatmentPin?.presetId
    ?? preflight?.suggestedTreatment.presetId;
  const treatmentChoices = preflight
    ? buildTreatmentChoiceGroups(
        preflight.suggestedTreatment.presetId,
        preflight.rankedTreatmentPresetIds ?? [],
      )
    : null;
  const visibleTreatmentChoices = showAllTreatments
    ? treatmentChoices?.all ?? []
    : treatmentChoices?.featured ?? [];
  const activeStylePack = p.projectStylePack
    ? { thaiLabel: p.projectStylePack.thaiLabel, source: p.projectStylePack.source }
    : null;
  const visualSummary = activeStylePack
    ? buildVisualSummary("", treatment, false, activeStylePack)
    : selectedFormatLabel
      ? buildVisualSummary(selectedFormatLabel, treatment, context?.legacyCustomTreatment)
      : treatment;
  const pendingBrandProfileId = pending?.kind === "profile" ? pending.profileId : null;
  const selectedLibraryProfile = selectedBrandProfile
    ? profiles.find((profile) => profile.id === selectedBrandProfile.profileId) ?? null
    : null;
  const canAdoptLatestRevision = Boolean(
    canManageBrandVisual
    && selectedBrandProfile
    && selectedLibraryProfile?.activeRevisionId
    && !selectedLibraryProfile.legacyVisualFormat
    && selectedLibraryProfile.activeRevisionNumber > selectedBrandProfile.revisionNumber,
  );
  const needsCurrentPreflight = Boolean(narrative);
  const preflightReadyForSelection = !needsCurrentPreflight
    || (preflight !== null && !loading && !error);
  const brandSelectionDisabled = changing || !preflightReadyForSelection;
  const confirmPendingChange = () => {
    if (!pending) return;
    if (pending.kind === "look") {
      void applyLook(pending.formatId, pending.treatmentPresetId, "regenerate-all");
    } else if (pending.kind === "pack") {
      void applyStylePackChoice(pending.packId, "regenerate-all");
    } else {
      void pinProfile(pending.profileId, "regenerate-all", pending.revisionId);
    }
  };
  const showInitialLoading = loading && preflight === null;
  const headerActionLabel = loading
    ? "กำลังวิเคราะห์…"
    : error
      ? "ลองวิเคราะห์อีกครั้ง"
      : expanded
        ? "ปิดตัวเลือก"
        : "เปลี่ยนแนวเล่าเรื่อง";
  const handleHeaderAction = () => {
    if (!visualSelectionEnabled || loading) return;
    if (error) {
      setExpanded(true);
      void loadContext();
      return;
    }
    setExpanded((value) => !value);
  };
  return <section className="shrink-0" style={{ border: `1px solid ${color.cardBorder}`, borderRadius: radius.card, background: color.cardBg, overflow: "hidden" }}>
    <div className="flex min-h-14 w-full flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "rgba(56,189,248,.12)", color: color.info }}><SwatchBook size={16} /></span>
      <span className="min-w-0 flex-1"><span className="block" style={{ font: `600 13px ${font.heading}`, color: color.text }}>แบรนด์และแนวภาพของคลิปนี้</span><span className="block truncate" style={{ fontSize: 10.5, color: color.textFaint }}>{showInitialLoading ? "กำลังอ่านเนื้อหา…" : selectedBrandProfile ? `${selectedBrandProfile.name} · ${visualSummary} · รุ่น ${selectedBrandProfile.revisionNumber}${context?.source === "project-look" ? " · ปรับเฉพาะคลิปนี้" : ""}` : visualSelectionEnabled ? visualSummary : "เลือกแบรนด์แบบรวดเร็ว แล้วเลือกระดับ B-roll ด้านล่าง"}</span></span>
      {p.starterAiImageAllowance?.eligible && <span className="rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: color.infoText, fontSize: 10, fontWeight: 600 }}>เหลือ {p.starterAiImageAllowance.remainingImages}/8 ภาพ</span>}
      {visualSelectionEnabled && <button
        type="button"
        onClick={handleHeaderAction}
        disabled={loading}
        aria-expanded={expanded}
        aria-controls="brand-visual-options"
        className="inline-flex min-h-10 w-full shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 text-center transition-[background-color,border-color,transform] duration-150 active:translate-y-px disabled:cursor-wait disabled:opacity-60 sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F0F17]"
        style={{
          border: `1px solid ${error ? "rgba(248,113,113,.42)" : "rgba(56,189,248,.42)"}`,
          background: error ? "rgba(248,113,113,.10)" : expanded ? "rgba(56,189,248,.16)" : "rgba(56,189,248,.09)",
          color: error ? color.dangerText : color.infoText,
          font: `600 11px ${font.heading}`,
        }}
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : error ? <RefreshCcw size={14} /> : null}
        <span>{headerActionLabel}</span>
        {!loading && !error && <ChevronDown size={15} aria-hidden="true" style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 150ms" }} />}
      </button>}
    </div>
    {canManageBrandVisual && profiles.length > 0 && <div className="border-t px-4 py-3" style={{ borderColor: color.cardBorder }}>
      <label className="flex max-w-sm flex-col gap-1.5">
        <span style={{ color: color.textFaint, fontSize: 10.5 }}>แบรนด์ที่ใช้ (ถ้ามี)</span>
        <select
          value={pendingBrandProfileId ?? selectedBrandProfile?.profileId ?? ""}
          disabled={brandSelectionDisabled}
          aria-describedby={!preflightReadyForSelection ? "brand-profile-analysis-help" : undefined}
          onChange={(event) => {
            if (brandSelectionDisabled) return;
            if (event.target.value) void pinProfile(event.target.value);
            else if (pending?.kind === "profile") setPending(null);
          }}
          className="min-h-10 w-full rounded-lg px-3 disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
          style={{ background: "rgba(255,255,255,.05)", border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 12 }}
        ><option value="" style={{ background: color.bg1 }}>ใช้แนวภาพของคลิปนี้</option>{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.frozen || profile.legacyVisualFormat || profile.activeRevisionNumber <= 0} style={{ background: color.bg1 }}>{profile.name} · รุ่น {profile.activeRevisionNumber}{profile.legacyVisualFormat ? " (รุ่นเดิม · เลือกใช้กับงานใหม่ไม่ได้)" : profile.frozen ? " (อ่านอย่างเดียว)" : profile.activeRevisionNumber <= 0 ? " (ต้องนำเข้าก่อน)" : ""}</option>)}</select>
        {!preflightReadyForSelection && <span id="brand-profile-analysis-help" style={{ color: error ? color.dangerText : color.textFaint, fontSize: 10, lineHeight: 1.45 }}>{error ? "ยังเลือกแบรนด์ไม่ได้ เพราะผลวิเคราะห์ของเนื้อหาปัจจุบันยังไม่พร้อม กดลองวิเคราะห์อีกครั้งด้านบน" : "กำลังวิเคราะห์เนื้อหาปัจจุบันก่อนเปิดให้เลือกแบรนด์"}</span>}
      </label>
      {pending?.kind === "profile" && <PendingChangeConfirmation p={p} pending={pending} changing={changing} onConfirm={confirmPendingChange} onCancel={() => setPending(null)} />}
      {canAdoptLatestRevision && selectedLibraryProfile?.activeRevisionId && <button type="button" disabled={changing} onClick={() => void pinProfile(selectedLibraryProfile.id, undefined, selectedLibraryProfile.activeRevisionId ?? undefined)} className="mt-2 min-h-9 rounded-lg px-3 text-left" style={{ border: `1px solid ${color.info}`, color: color.infoText, fontSize: 10.5, fontWeight: 700 }}>ใช้รุ่นล่าสุดกับคลิปนี้ · รุ่น {selectedLibraryProfile.activeRevisionNumber}</button>}
    </div>}
    {visualSelectionEnabled && expanded && <div id="brand-visual-options" className="border-t px-4 py-4" style={{ borderColor: color.cardBorder }}>
      {!canManageBrandVisual && p.hasPersistedVisualPin && <div className="mb-3 rounded-lg px-3 py-2" style={{ background: "rgba(56,189,248,.08)", color: color.infoText, fontSize: 10.5, lineHeight: 1.55 }}>แนวภาพเดิมของโปรเจกต์นี้ยังใช้สร้างซ้ำได้ตามเดิม ขณะนี้ปิดการเลือกหรือสร้างแนวภาพใหม่ชั่วคราว</div>}
      {error && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2.5" style={{ background: "rgba(248,113,113,.09)", color: color.dangerText, fontSize: 11 }}><span className="min-w-0 flex-1"><span className="block">{error}</span><span className="mt-0.5 block" style={{ color: color.textSecondary, fontSize: 10 }}>ยังไม่มีการเปลี่ยนแบรนด์หรือคิดเครดิตภาพ</span></span><button type="button" onClick={() => void loadContext()} className="min-h-9 rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/70" style={{ border: "1px solid rgba(248,113,113,.32)", color: color.dangerText, fontWeight: 600 }}>ลองวิเคราะห์อีกครั้ง</button></div>}
      {!narrative && canLoadWithoutNarrative && <div className="mb-3 rounded-lg px-3 py-2" style={{ background: "rgba(56,189,248,.08)", color: color.infoText, fontSize: 10.5, lineHeight: 1.55 }}>เลือกแบรนด์หรือแนวภาพล่วงหน้าได้ ระบบจะอ่านคำพูดจากเสียงหลังเริ่มสร้าง แล้วใช้ผลนั้นกับภาพของคลิปนี้</div>}
      {showInitialLoading ? <div className="flex items-center gap-2 py-5" style={{ color: color.textFaint, fontSize: 11 }}><Loader2 size={14} className="animate-spin" /> กำลังวิเคราะห์แนวภาพและฉากของคลิปครั้งแรก…</div> : <>
        {canManageBrandVisual && stylePacks.length > 0 && <div className="mb-3 rounded-xl p-3" style={{ border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.025)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="block" style={{ color: color.textSecondary, font: `500 11px ${font.heading}` }}>สไตล์ของคลิปนี้</span>
              <span className="mt-0.5 block" style={{ color: color.textFaint, fontSize: 10, lineHeight: 1.45 }}>{activeStylePack ? `${activeStylePack.thaiLabel} · ${activeStylePack.source === "project" ? "จากคลิปนี้" : "จากแบรนด์"}` : "ยังไม่ได้เลือกสไตล์สำเร็จรูป · ระบบเลือกจากเนื้อหาให้"}</span>
            </span>
            <button
              type="button"
              disabled={changing}
              aria-expanded={packPickerOpen}
              onClick={() => setPackPickerOpen((value) => !value)}
              className="min-h-9 shrink-0 rounded-lg px-3 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
              style={{ border: `1px solid ${color.info}`, color: color.infoText, fontSize: 10.5, fontWeight: 600 }}
            >เปลี่ยนเฉพาะคลิปนี้</button>
          </div>
          {packPickerOpen && <div className="mt-3">
            <StylePackPicker
              packs={stylePacks}
              value={(p.projectStylePack?.packId ?? null) as StylePackId | null}
              disabled={changing}
              onChange={(id) => void applyStylePackChoice(id)}
              title="สไตล์ของคลิปนี้"
              description="เลือกสไตล์สำเร็จรูปให้คลิปนี้คลิปเดียว ไม่กระทบคลิปอื่นของแบรนด์ หรือเลือก กำหนดเอง เพื่อตั้งรูปแบบภาพและแนวเล่าเรื่องด้านล่างเอง"
            />
          </div>}
        </div>}
        {preflight && <div className="mb-3 flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: color.infoText, fontSize: 10 }}><Sparkles size={11} /> แนะนำหลัก · {preflight.suggestedTreatment.label}</span><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight.suggestedTreatment.rationale}</span></div>}
        {preflight?.formatRecommendation && preflight.formatRecommendation.visualFormatId !== selected && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2.5" style={{ border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.025)" }}><span style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>รูปแบบภาพที่อาจเหมาะกับคลิปนี้: {formats.find((item) => item.id === preflight.formatRecommendation?.visualFormatId)?.label} · {preflight.formatRecommendation.reason}</span>{selectedTreatmentPresetId && <button type="button" disabled={changing} onClick={() => void applyLook(preflight.formatRecommendation!.visualFormatId, selectedTreatmentPresetId)} className="min-h-8 rounded-lg px-2.5" style={{ border: `1px solid ${color.info}`, color: color.infoText, fontSize: 10.5, fontWeight: 600 }}>เปลี่ยนเฉพาะคลิปนี้</button>}</div>}
        {outdatedBeatCount > 0 && <div className="mb-3 rounded-xl px-3 py-2.5" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.25)" }}><p style={{ color: color.warningText, font: `600 11px ${font.heading}` }}>ฉากที่เนื้อหาเปลี่ยน {outdatedBeatCount} ฉาก · {imageFundingText(p, outdatedBeatCount)}</p><p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>ภาพเดิมยังอยู่และยังไม่ถูกคิดซ้ำ เมื่อคุณยืนยันสร้างครั้งถัดไป ระบบจะใช้ภาพที่ยังตรงกับสคริปต์ซ้ำ และสร้างใหม่เฉพาะ {outdatedBeatCount} ภาพนี้</p></div>}
        {canManageBrandVisual && (selectedTreatmentPresetId || canChooseFormatBeforeTranscript) && <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{formats.map((format) => { const isSelected = selected === format.id; return <button key={format.id} type="button" disabled={changing} onClick={() => void applyLook(format.id, selectedTreatmentPresetId)} className="relative overflow-hidden text-left" style={{ border: `1px solid ${isSelected ? color.info : color.cardBorder}`, borderRadius: 8, background: isSelected ? "rgba(56,189,248,.09)" : "rgba(255,255,255,.025)", opacity: changing ? .65 : 1 }}><div className="relative aspect-[16/9] overflow-hidden"><img src={format.previewUrl} alt="" className="h-full w-full object-cover object-[center_30%]" /></div><div className="flex min-h-10 items-center justify-between gap-1 px-2 py-1.5"><span style={{ color: isSelected ? color.infoText : color.textSecondary, font: `500 10.5px ${font.heading}`, lineHeight: 1.25 }}>{format.label}</span>{isSelected && <Check size={12} color={color.info} />}</div></button>; })}</div>}
        {canManageBrandVisual && selected && !selectedActiveFormat && <div className="mt-3 rounded-xl px-3 py-2.5" style={{ border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.025)", color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>คลิปนี้ยังใช้แนวภาพรุ่นเดิมและลองภาพเดิมใหม่ได้ หากต้องการเปลี่ยนแนวเล่าเรื่อง ให้เลือกรูปแบบภาพใหม่สำหรับคลิปนี้ก่อน</div>}
        {canManageBrandVisual && preflight && selectedActiveFormat && treatmentChoices && <div className="mt-3 rounded-xl p-3" style={{ border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.025)" }}><p style={{ color: color.textSecondary, font: `500 11px ${font.heading}` }}>แนวเล่าเรื่องของคลิปนี้</p><p className="mt-1" style={{ color: color.textFaint, fontSize: 10, lineHeight: 1.45 }}>คำแนะนำหลักและทางเลือกใกล้เคียงมาจากภาพรวมของเนื้อหาทั้งคลิป</p><div className="mt-2 grid gap-2 sm:grid-cols-3">{visibleTreatmentChoices.map((choice) => { const isSelected = selectedTreatmentPresetId === choice.id; return <button key={choice.id} type="button" disabled={changing} onClick={() => void applyLook(selectedActiveFormat.id, choice.id)} className="min-h-10 rounded-lg px-3 text-left" style={{ border: `1px solid ${isSelected ? color.info : color.cardBorder}`, background: isSelected ? "rgba(56,189,248,.09)" : "rgba(255,255,255,.025)", color: isSelected ? color.infoText : color.textSecondary, fontSize: 10.5, fontWeight: isSelected ? 700 : 500 }}>{choice.role === "recommended" ? "แนะนำหลัก · " : choice.role === "alternative" ? "ทางเลือก · " : ""}{choice.label}</button>; })}</div><button type="button" onClick={() => setShowAllTreatments((value) => !value)} className="mt-2 min-h-8 px-1" style={{ color: color.infoText, fontSize: 10.5, fontWeight: 600 }}>{showAllTreatments ? "ดูคำแนะนำใกล้เคียง" : "ดูทั้งหมด"}</button></div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight?.visualBeats.length ?? 0} ฉาก · การวิเคราะห์ไม่ใช้สิทธิ์หรือเครดิต</span><span className="flex flex-wrap gap-3">{canManageBrandVisual && !p.starterAiImageAllowance?.eligible && <Link href={p.projectId ? `/brands?new=1&projectId=${encodeURIComponent(p.projectId)}${preflight?.id ? `&preflightId=${encodeURIComponent(preflight.id)}` : ""}` : "/brands?new=1"} className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: color.infoText, fontWeight: 600 }}>+ สร้างแบรนด์จากคลิปนี้</Link>}<Link href="/brands" className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: color.textFaint, fontWeight: 600 }}>จัดการแบรนด์ของฉัน</Link></span></div>
      </>}
      {pending?.kind === "look" && <PendingChangeConfirmation p={p} pending={pending} changing={changing} onConfirm={confirmPendingChange} onCancel={() => setPending(null)} />}
      {pending?.kind === "pack" && <PendingChangeConfirmation p={p} pending={pending} changing={changing} onConfirm={confirmPendingChange} onCancel={() => setPending(null)} />}
      {p.starterAiImageAllowance?.eligible && p.starterAiImageAllowance.remainingImages === 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3" style={{ background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.25)" }}><span className="flex items-center gap-2" style={{ fontSize: 11, color: color.dangerText }}><LockKeyhole size={14} /> ใช้สิทธิ์ทดลองภาพครบแล้ว ระบบจะไม่เปลี่ยนเป็น Stock เอง</span><span className="flex gap-2"><Link href="/pricing" className="rounded-lg bg-white px-3 py-2 text-[10.5px] font-bold text-black">อัปเกรดรายเดือน</Link><button onClick={() => p.setMixPreset("free")} className="rounded-lg px-3 py-2" style={{ border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 10.5 }}>ใช้ Stock ฟรี</button></span></div>}
    </div>}
  </section>;
}
