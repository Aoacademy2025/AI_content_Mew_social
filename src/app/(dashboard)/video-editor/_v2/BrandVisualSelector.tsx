"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ImageIcon, Loader2, LockKeyhole, Sparkles, SwatchBook } from "lucide-react";
import { toast } from "sonner";
import { trackEvent } from "@/lib/client-telemetry";
import { normalizeLogoOverlayConfig } from "@/lib/logo-overlay";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { shouldLoadBrandVisualContext } from "@/lib/automix-plan";
import type { V2Project } from "./useV2Project";
import { color, font, radius } from "./tokens";

type VisualFormatId = "cinematic-realism" | "stick-figure-story" | "dramatic-comic" | "clear-infographic" | "retro-story";
type VisualFormat = { id: VisualFormatId; label: string; description: string; previewUrl: string };
type Profile = { id: string; name: string; frozen: boolean; activeRevisionNumber: number; activeRevisionId: string | null };
type RevisionDefaults = {
  voice?: { provider?: unknown; voiceId?: unknown };
  subtitle?: { config?: unknown };
  brandMark?: { assetId?: unknown; enabled?: unknown; position?: unknown; sizePct?: unknown; opacity?: unknown };
};
type Preflight = {
  id: string;
  sourceHash: string;
  suggestedVisualFormatId: VisualFormatId;
  suggestedTreatment: { label: string; mood: string };
  visualBeats: Array<{ id: string; status: string; existingAssetUrl: string | null }>;
};
type Context = { source: "project-look" | "brand-revision" | "suggested"; visualFormatId: VisualFormatId; treatment: string };
type SelectedBrandProfile = { profileId: string; name: string; revisionId: string; revisionNumber: number };
export type BrandVisualPreflightStatus = "idle" | "loading" | "ready" | "error";
type PendingChange =
  | { kind: "look"; formatId: VisualFormatId; treatment: string; label: string; existingImageCount: number; quotedCredits: number }
  | { kind: "profile"; profileId: string; revisionId?: string; label: string; existingImageCount: number; quotedCredits: number };

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
}: {
  p: V2Project;
  onPreflightStatusChange?: (status: BrandVisualPreflightStatus) => void;
}) {
  const [formats, setFormats] = useState<VisualFormat[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [selectedBrandProfile, setSelectedBrandProfile] = useState<SelectedBrandProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treatmentDraft, setTreatmentDraft] = useState("");
  const [libraryAuthorized, setLibraryAuthorized] = useState(false);

  const narrative = p.script.trim();
  const canLoadWithoutNarrative = p.mode === "upload";
  const suggestedTreatment = useMemo(() => preflight
    ? `${preflight.suggestedTreatment.label}, ${preflight.suggestedTreatment.mood}`
    : "ชัดเจนและเหมาะกับเนื้อหา", [preflight]);
  const treatment = context?.treatment?.trim() || suggestedTreatment;
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
    setProfiles(result.body.profiles ?? []);
  }

  async function loadContext(signal?: AbortSignal) {
    if (!p.projectId || (!narrative && !canLoadWithoutNarrative)) return;
    setLoading(true); setError(null); p.setBrandContentPreflightId(null); onPreflightStatusChange?.("loading");
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
                ...(p.targetClipCount > 0 ? { windowCount: p.targetClipCount } : {}),
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
      setContext(visualResult.body.context);
      setSelectedBrandProfile(visualResult.body.selectedBrandProfile ?? null);
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
    if (!canRenderPersistedVisual || !shouldLoadVisualContext || !p.projectId || (!narrative && !canLoadWithoutNarrative)) {
      p.setBrandContentPreflightId(null);
      onPreflightStatusChange?.("idle");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadContext(controller.signal);
    return () => controller.abort();
  }, [canRenderPersistedVisual, shouldLoadVisualContext, p.projectId, narrative, p.mode, p.targetClipCount, onPreflightStatusChange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTreatmentDraft(treatment);
  }, [treatment]);

  async function applyLook(
    formatId: VisualFormatId,
    applyMode?: "new-only" | "regenerate-all",
    requestedTreatment?: string,
  ) {
    if (!p.projectId) return;
    const nextTreatment = requestedTreatment?.trim() || treatmentDraft.trim() || treatment;
    setChanging(true); setPending(null);
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ look: { visualFormatId: formatId, treatment: nextTreatment }, applyMode, preflightId: preflight?.id }),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      setPending({ kind: "look", formatId, treatment: nextTreatment, label: formats.find((item) => item.id === formatId)?.label ?? formatId, existingImageCount: result.body.existingImageCount, quotedCredits: result.body.quotedCredits });
      setExpanded(true);
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เปลี่ยนแนวภาพไม่สำเร็จ");
    } else {
      setContext({ source: "project-look", visualFormatId: formatId, treatment: nextTreatment });
      setTreatmentDraft(nextTreatment);
      p.setHasPersistedVisualPin(true);
      toast.success(applyMode === "regenerate-all" ? "บันทึกแนวภาพแล้ว — รอคุณยืนยันฉากที่จะสร้างใหม่" : "บันทึกแนวภาพของคลิปนี้แล้ว");
    }
    setChanging(false);
  }

  async function pinProfile(
    profileId: string,
    applyMode?: "new-only" | "regenerate-all",
    revisionId?: string,
  ) {
    if (!p.projectId) return;
    setChanging(true); setPending(null);
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
        // Rolling-deploy fallback for an older API response. New servers always
        // return the authoritative draft snapshot committed with the pin.
        const defaults = result.body.revisionDefaults as RevisionDefaults | undefined;
        const provider = defaults?.voice?.provider;
        const voiceId = defaults?.voice?.voiceId;
        if (provider === "gemini" || provider === "elevenlabs" || provider === "omnivoice") {
          p.setVoiceEngine(provider);
          if (typeof voiceId === "string" && voiceId.trim()) {
            if (provider === "gemini") p.setGeminiVoiceName(voiceId.trim());
            if (provider === "elevenlabs") p.setVoiceId(voiceId.trim());
            if (provider === "omnivoice") p.setOmniVoiceId(voiceId.trim());
          }
        }
        p.setBrandSubtitleDefault(
          normalizeSubtitleStylePresetConfig(defaults?.subtitle?.config) ?? undefined,
        );
        p.setLogoOverlay(normalizeLogoOverlayConfig(defaults?.brandMark) ?? undefined);
      }
      toast.success("คลิปนี้ใช้แนวภาพของแบรนด์ที่เลือกแล้ว");
      await loadContext();
    }
    setChanging(false);
  }

  if (!canRenderPersistedVisual) return null;
  if (!narrative && !canLoadWithoutNarrative) return <div className="px-3 py-3" style={{ border: `1px dashed ${color.cardBorder}`, borderRadius: radius.card, color: color.textFaint, fontSize: 11.5 }}>ใส่สคริปต์ก่อน ระบบจึงจะแนะนำแนวภาพจากเนื้อหาจริง</div>;

  const selected = context?.visualFormatId ?? preflight?.suggestedVisualFormatId;
  const selectedLibraryProfile = selectedBrandProfile
    ? profiles.find((profile) => profile.id === selectedBrandProfile.profileId) ?? null
    : null;
  const canAdoptLatestRevision = Boolean(
    canManageBrandVisual
    && selectedBrandProfile
    && selectedLibraryProfile?.activeRevisionId
    && selectedLibraryProfile.activeRevisionNumber > selectedBrandProfile.revisionNumber,
  );
  return <section style={{ border: `1px solid ${color.cardBorder}`, borderRadius: radius.card, background: color.cardBg, overflow: "hidden" }}>
    <button type="button" onClick={() => { if (visualSelectionEnabled) setExpanded((value) => !value); }} className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={visualSelectionEnabled && expanded} aria-disabled={!visualSelectionEnabled}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "rgba(56,189,248,.12)", color: color.info }}><SwatchBook size={16} /></span>
      <span className="min-w-0 flex-1"><span className="block" style={{ font: `600 13px ${font.heading}`, color: color.text }}>แบรนด์และแนวภาพของคลิปนี้</span><span className="block truncate" style={{ fontSize: 10.5, color: color.textFaint }}>{loading ? "กำลังอ่านเนื้อหา…" : selectedBrandProfile ? `ใช้แนวภาพจาก ${selectedBrandProfile.name} · รุ่น ${selectedBrandProfile.revisionNumber}${context?.source === "project-look" ? " · ปรับเฉพาะคลิปนี้" : ""}` : visualSelectionEnabled ? context?.source === "project-look" ? "ใช้แนวภาพที่เลือกให้คลิปนี้" : "AI เลือกแนวภาพจากเนื้อหาไว้แล้ว" : "เลือกแบรนด์แบบรวดเร็ว แล้วเลือกระดับ B-roll ด้านล่าง"}</span></span>
      {p.starterAiImageAllowance?.eligible && <span className="rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: color.infoText, fontSize: 10, fontWeight: 600 }}>เหลือ {p.starterAiImageAllowance.remainingImages}/8 ภาพ</span>}
      {visualSelectionEnabled && <><span style={{ color: color.infoText, fontSize: 10.5, fontWeight: 700 }}>{expanded ? "ซ่อน" : "เปลี่ยนแนวภาพ"}</span><ChevronDown size={15} style={{ color: color.textFaint, transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 150ms" }} /></>}
    </button>
    {canManageBrandVisual && profiles.length > 0 && <div className="border-t px-4 py-3" style={{ borderColor: color.cardBorder }}><label className="flex max-w-sm flex-col gap-1.5"><span style={{ color: color.textFaint, fontSize: 10.5 }}>แบรนด์ที่ใช้ (ถ้ามี)</span><select value={selectedBrandProfile?.profileId ?? ""} disabled={changing} onChange={(event) => { if (event.target.value) void pinProfile(event.target.value); }} className="min-h-10 w-full rounded-lg px-3" style={{ background: "rgba(255,255,255,.05)", border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 12 }}><option value="" style={{ background: color.bg1 }}>ใช้แนวภาพของคลิปนี้</option>{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.frozen || profile.activeRevisionNumber <= 0} style={{ background: color.bg1 }}>{profile.name} · รุ่น {profile.activeRevisionNumber}{profile.frozen ? " (อ่านอย่างเดียว)" : profile.activeRevisionNumber <= 0 ? " (ต้องนำเข้าก่อน)" : ""}</option>)}</select></label>{canAdoptLatestRevision && selectedLibraryProfile?.activeRevisionId && <button type="button" disabled={changing} onClick={() => void pinProfile(selectedLibraryProfile.id, undefined, selectedLibraryProfile.activeRevisionId ?? undefined)} className="mt-2 min-h-9 rounded-lg px-3 text-left" style={{ border: `1px solid ${color.info}`, color: color.infoText, fontSize: 10.5, fontWeight: 700 }}>ใช้รุ่นล่าสุดกับคลิปนี้ · รุ่น {selectedLibraryProfile.activeRevisionNumber}</button>}</div>}
    {visualSelectionEnabled && expanded && <div className="border-t px-4 py-4" style={{ borderColor: color.cardBorder }}>
      {!canManageBrandVisual && p.hasPersistedVisualPin && <div className="mb-3 rounded-lg px-3 py-2" style={{ background: "rgba(56,189,248,.08)", color: color.infoText, fontSize: 10.5, lineHeight: 1.55 }}>แนวภาพเดิมของโปรเจกต์นี้ยังใช้สร้างซ้ำได้ตามเดิม ขณะนี้ปิดการเลือกหรือสร้างแนวภาพใหม่ชั่วคราว</div>}
      {error && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: "rgba(248,113,113,.09)", color: color.dangerText, fontSize: 11 }}><span>{error}</span><button type="button" onClick={() => void loadContext()} className="min-h-8 rounded-md px-2.5" style={{ border: "1px solid rgba(248,113,113,.28)", color: color.dangerText, fontWeight: 600 }}>ลองวิเคราะห์อีกครั้ง</button></div>}
      {!narrative && canLoadWithoutNarrative && <div className="mb-3 rounded-lg px-3 py-2" style={{ background: "rgba(56,189,248,.08)", color: color.infoText, fontSize: 10.5, lineHeight: 1.55 }}>เลือกแบรนด์หรือแนวภาพล่วงหน้าได้ ระบบจะอ่านคำพูดจากเสียงหลังเริ่มสร้าง แล้วใช้ผลนั้นกับภาพของคลิปนี้</div>}
      {loading ? <div className="flex items-center gap-2 py-5" style={{ color: color.textFaint, fontSize: 11 }}><Loader2 size={14} className="animate-spin" /> กำลังวิเคราะห์แนวภาพและฉากของคลิปครั้งแรก…</div> : <>
        {preflight && <div className="mb-3 flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: color.infoText, fontSize: 10 }}><Sparkles size={11} /> AI แนะนำ {formats.find((item) => item.id === preflight.suggestedVisualFormatId)?.label}</span><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight.suggestedTreatment.label}</span></div>}
        {outdatedBeatCount > 0 && <div className="mb-3 rounded-xl px-3 py-2.5" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.25)" }}><p style={{ color: color.warningText, font: `600 11px ${font.heading}` }}>ฉากที่เนื้อหาเปลี่ยน {outdatedBeatCount} ฉาก · {imageFundingText(p, outdatedBeatCount)}</p><p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>ภาพเดิมยังอยู่และยังไม่ถูกคิดซ้ำ เมื่อคุณยืนยันสร้างครั้งถัดไป ระบบจะใช้ภาพที่ยังตรงกับสคริปต์ซ้ำ และสร้างใหม่เฉพาะ {outdatedBeatCount} ภาพนี้</p></div>}
        {canManageBrandVisual && <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{formats.map((format) => { const isSelected = selected === format.id; return <button key={format.id} type="button" disabled={changing} onClick={() => void applyLook(format.id)} className="relative overflow-hidden text-left" style={{ border: `1px solid ${isSelected ? color.info : color.cardBorder}`, borderRadius: 8, background: isSelected ? "rgba(56,189,248,.09)" : "rgba(255,255,255,.025)", opacity: changing ? .65 : 1 }}><div className="relative aspect-[16/9] overflow-hidden"><img src={format.previewUrl} alt="" className="h-full w-full object-cover object-[center_30%]" /></div><div className="flex min-h-10 items-center justify-between gap-1 px-2 py-1.5"><span style={{ color: isSelected ? color.infoText : color.textSecondary, font: `500 10.5px ${font.heading}`, lineHeight: 1.25 }}>{format.label}</span>{isSelected && <Check size={12} color={color.info} />}</div></button>; })}</div>}
        {canManageBrandVisual && preflight && selected && <div className="mt-3 rounded-xl p-3" style={{ border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.025)" }}><label htmlFor="brand-visual-treatment" className="block" style={{ color: color.textSecondary, font: `500 11px ${font.heading}` }}>อารมณ์และวิธีเล่าของคลิปนี้</label><p className="mt-1" style={{ color: color.textFaint, fontSize: 10, lineHeight: 1.45 }}>AI เติมให้จากเนื้อหา คุณแก้เป็นทิศทางสั้น ๆ ของคลิปนี้ได้ โดยไม่เปลี่ยนลายเซ็นประจำแบรนด์</p><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="brand-visual-treatment" value={treatmentDraft} maxLength={300} onChange={(event) => setTreatmentDraft(event.target.value)} disabled={changing} className="min-h-10 min-w-0 flex-1 rounded-lg px-3" style={{ background: "rgba(255,255,255,.05)", border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 11.5 }} /><button type="button" disabled={changing || !treatmentDraft.trim() || treatmentDraft.trim() === treatment} onClick={() => void applyLook(selected, undefined, treatmentDraft)} className="min-h-10 rounded-lg px-3 disabled:opacity-40" style={{ background: color.info, color: color.bg0, fontSize: 10.5, fontWeight: 700 }}>ใช้กับคลิปนี้</button>{treatmentDraft.trim() !== suggestedTreatment && <button type="button" disabled={changing} onClick={() => setTreatmentDraft(suggestedTreatment)} className="min-h-10 rounded-lg px-3" style={{ border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 10.5 }}>กลับไปใช้คำแนะนำ AI</button>}</div></div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight?.visualBeats.length ?? 0} ฉาก · การวิเคราะห์ไม่ใช้สิทธิ์หรือเครดิต</span><span className="flex flex-wrap gap-3">{canManageBrandVisual && !p.starterAiImageAllowance?.eligible && <Link href={p.projectId ? `/brands?new=1&projectId=${encodeURIComponent(p.projectId)}${preflight?.id ? `&preflightId=${encodeURIComponent(preflight.id)}` : ""}` : "/brands?new=1"} className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: color.infoText, fontWeight: 600 }}>+ สร้างแบรนด์จากคลิปนี้</Link>}<Link href="/brands" className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: color.textFaint, fontWeight: 600 }}>จัดการแบรนด์ของฉัน</Link></span></div>
      </>}
      {pending && <div className="mt-4 rounded-xl p-3" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.28)" }}><div className="flex gap-2"><ImageIcon size={15} color={color.warning} className="mt-0.5 shrink-0" /><div><p style={{ color: color.text, font: `600 11.5px ${font.heading}` }}>มีภาพเดิม {pending.existingImageCount} ภาพ</p><p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>ระบบจะไม่สร้างใหม่เอง เลือกว่าจะเตรียมสร้างทั้งหมดใหม่ ({imageFundingText(p, pending.existingImageCount)}) หรือใช้ “{pending.label}” เฉพาะภาพต่อจากนี้</p>{starterFundingInsufficient(p, pending.existingImageCount) && <p className="mt-1" style={{ color: color.dangerText, fontSize: 10.5 }}>สิทธิ์ทดลองไม่พอสำหรับสร้างทั้งหมด เลือกใช้แนวใหม่กับภาพต่อไป หรืออัปเกรดก่อน</p>}</div></div><div className="mt-3 flex flex-wrap gap-2"><button disabled={changing || starterFundingInsufficient(p, pending.existingImageCount)} onClick={() => pending.kind === "look" ? void applyLook(pending.formatId, "regenerate-all", pending.treatment) : void pinProfile(pending.profileId, "regenerate-all", pending.revisionId)} className="min-h-9 rounded-lg px-3 disabled:opacity-40" style={{ background: color.warning, color: color.bg0, fontSize: 10.5, fontWeight: 700 }}>สร้างทุกภาพใหม่ให้เป็นแนวเดียวกัน</button><button disabled={changing} onClick={() => pending.kind === "look" ? void applyLook(pending.formatId, "new-only", pending.treatment) : void pinProfile(pending.profileId, "new-only", pending.revisionId)} className="min-h-9 rounded-lg px-3" style={{ border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 10.5 }}>ใช้แนวใหม่เฉพาะภาพต่อจากนี้</button></div><p className="mt-2" style={{ color: color.warningText, fontSize: 10 }}>ตัวเลือกหลังทำให้คลิปมีมากกว่าหนึ่งแนวภาพ</p></div>}
      {p.starterAiImageAllowance?.eligible && p.starterAiImageAllowance.remainingImages === 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3" style={{ background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.25)" }}><span className="flex items-center gap-2" style={{ fontSize: 11, color: color.dangerText }}><LockKeyhole size={14} /> ใช้สิทธิ์ทดลองภาพครบแล้ว ระบบจะไม่เปลี่ยนเป็น Stock เอง</span><span className="flex gap-2"><Link href="/pricing" className="rounded-lg bg-white px-3 py-2 text-[10.5px] font-bold text-black">อัปเกรดรายเดือน</Link><button onClick={() => p.setMixPreset("free")} className="rounded-lg px-3 py-2" style={{ border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 10.5 }}>ใช้ Stock ฟรี</button></span></div>}
    </div>}
  </section>;
}
