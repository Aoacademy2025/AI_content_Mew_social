"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ImageIcon, Loader2, LockKeyhole, Sparkles, SwatchBook } from "lucide-react";
import { toast } from "sonner";
import { trackEvent } from "@/lib/client-telemetry";
import { normalizeLogoOverlayConfig } from "@/lib/logo-overlay";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import type { V2Project } from "./useV2Project";
import { color, font, radius } from "./tokens";

type VisualFormatId = "cinematic-realism" | "stick-figure-story" | "dramatic-comic" | "clear-infographic" | "retro-story";
type VisualFormat = { id: VisualFormatId; label: string; description: string; previewUrl: string };
type Profile = { id: string; name: string; frozen: boolean; activeRevisionNumber: number };
type RevisionDefaults = {
  voice?: { provider?: unknown; voiceId?: unknown };
  subtitle?: { config?: unknown };
  brandMark?: { assetId?: unknown; enabled?: unknown; position?: unknown; sizePct?: unknown; opacity?: unknown };
};
type Preflight = {
  suggestedVisualFormatId: VisualFormatId;
  suggestedTreatment: { label: string; mood: string };
  visualBeats: Array<{ id: string; status: string; existingAssetUrl: string | null }>;
};
type Context = { source: "project-look" | "brand-revision" | "suggested"; visualFormatId: VisualFormatId; treatment: string };
type PendingChange =
  | { kind: "look"; formatId: VisualFormatId; label: string; existingImageCount: number; quotedCredits: number }
  | { kind: "profile"; profileId: string; label: string; existingImageCount: number; quotedCredits: number };

async function payload(response: Response) {
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

export function BrandVisualSelector({ p }: { p: V2Project }) {
  const [formats, setFormats] = useState<VisualFormat[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const narrative = p.script.trim();
  const treatment = useMemo(() => preflight
    ? `${preflight.suggestedTreatment.label}, ${preflight.suggestedTreatment.mood}`
    : "ชัดเจนและเหมาะกับเนื้อหา", [preflight]);
  const outdatedBeatCount = preflight?.visualBeats.filter((beat) => beat.status === "outdated").length ?? 0;

  async function loadContext(signal?: AbortSignal) {
    if (!p.projectId || !narrative) return;
    setLoading(true); setError(null);
    try {
      const libraryRequest = fetch("/api/brand-library", { cache: "no-store", signal });
      const preflightRequest = fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/content-preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrativeSource: {
            kind: p.mode === "upload" ? "upload-transcript" : p.narrativeSourceKind,
            text: narrative,
          },
        }),
        signal,
      });
      const [libraryResult, preflightResult] = await Promise.all([libraryRequest.then(payload), preflightRequest.then(payload)]);
      if (!libraryResult.response.ok) throw new Error(libraryResult.body.error || "โหลด Brand Library ไม่สำเร็จ");
      if (!preflightResult.response.ok) throw new Error(preflightResult.body.error || "วิเคราะห์เนื้อหาไม่สำเร็จ");
      setFormats(libraryResult.body.visualFormats ?? []);
      setProfiles(libraryResult.body.profiles ?? []);
      setPreflight(preflightResult.body.preflight);
      const visualResult = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context`, { cache: "no-store", signal }));
      if (!visualResult.response.ok) throw new Error(visualResult.body.error || "โหลดแนวภาพไม่สำเร็จ");
      setContext(visualResult.body.context);
      trackEvent("brand_visual_step2_reached", {
        path: "/video-editor",
        properties: {
          source: visualResult.body.context?.source,
          visualFormatId: visualResult.body.context?.visualFormatId,
          beatCount: preflightResult.body.preflight?.visualBeats?.length ?? 0,
        },
      });
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : "โหลดแนวภาพไม่สำเร็จ");
    } finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => {
    if (!p.brandVisualAllowed || !p.projectId || !narrative) return;
    const controller = new AbortController();
    void loadContext(controller.signal);
    return () => controller.abort();
  }, [p.brandVisualAllowed, p.projectId, narrative, p.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyLook(formatId: VisualFormatId, applyMode?: "new-only" | "regenerate-all") {
    if (!p.projectId) return;
    setChanging(true); setPending(null);
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ look: { visualFormatId: formatId, treatment }, applyMode }),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      setPending({ kind: "look", formatId, label: formats.find((item) => item.id === formatId)?.label ?? formatId, existingImageCount: result.body.existingImageCount, quotedCredits: result.body.quotedCredits });
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เปลี่ยนแนวภาพไม่สำเร็จ");
    } else {
      setContext({ source: "project-look", visualFormatId: formatId, treatment });
      toast.success(applyMode === "regenerate-all" ? "บันทึกแนวภาพแล้ว — รอคุณยืนยันฉากที่จะสร้างใหม่" : "บันทึกแนวภาพของคลิปนี้แล้ว");
    }
    setChanging(false);
  }

  async function pinProfile(profileId: string, applyMode?: "new-only" | "regenerate-all") {
    if (!p.projectId) return;
    setChanging(true); setPending(null);
    const result = await payload(await fetch(`/api/editor-projects/${encodeURIComponent(p.projectId)}/brand-revision`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId, applyMode }),
    }));
    if (result.response.status === 409 && result.body.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
      setPending({ kind: "profile", profileId, label: profiles.find((item) => item.id === profileId)?.name ?? "แบรนด์นี้", existingImageCount: result.body.existingImageCount, quotedCredits: result.body.quotedCredits });
    } else if (!result.response.ok) {
      toast.error(result.body.error || "เลือกแบรนด์ไม่สำเร็จ");
    } else {
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
      toast.success("โปรเจกต์ pin Brand Revision นี้แล้ว");
      await loadContext();
    }
    setChanging(false);
  }

  if (!p.brandVisualAllowed) return null;
  if (!narrative) return <div className="px-3 py-3" style={{ border: `1px dashed ${color.cardBorder}`, borderRadius: radius.card, color: color.textFaint, fontSize: 11.5 }}>ใส่สคริปต์หรือ transcript ก่อน ระบบจึงจะแนะนำแนวภาพจากเนื้อหาจริง</div>;

  const selected = context?.visualFormatId ?? preflight?.suggestedVisualFormatId;
  return <section style={{ border: `1px solid ${color.cardBorder}`, borderRadius: radius.card, background: color.cardBg, overflow: "hidden" }}>
    <button type="button" onClick={() => setExpanded((value) => !value)} className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={expanded}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "rgba(56,189,248,.12)", color: "#38BDF8" }}><SwatchBook size={16} /></span>
      <span className="min-w-0 flex-1"><span className="block" style={{ font: `600 13px ${font.heading}`, color: color.text }}>แนวภาพของคลิปนี้</span><span className="block truncate" style={{ fontSize: 10.5, color: color.textFaint }}>{loading ? "กำลังอ่านเนื้อหา…" : context?.source === "brand-revision" ? "ใช้ Brand Profile Revision" : context?.source === "project-look" ? "คุณเลือกทับสำหรับโปรเจกต์นี้" : "AI แนะนำจากเนื้อหา — คุณเปลี่ยนได้"}</span></span>
      {p.starterAiImageAllowance?.eligible && <span className="rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: "#7dd3fc", fontSize: 10, fontWeight: 600 }}>เหลือ {p.starterAiImageAllowance.remainingImages}/8 ภาพ</span>}
      <ChevronDown size={15} style={{ color: color.textFaint, transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 150ms" }} />
    </button>
    {expanded && <div className="border-t px-4 py-4" style={{ borderColor: color.cardBorder }}>
      {error && <div className="mb-3 rounded-lg px-3 py-2" style={{ background: "rgba(248,113,113,.09)", color: "#fca5a5", fontSize: 11 }}>{error}</div>}
      {loading ? <div className="flex items-center gap-2 py-5" style={{ color: color.textFaint, fontSize: 11 }}><Loader2 size={14} className="animate-spin" /> กำลังหา Content Domain และ Visual Beats ครั้งแรก…</div> : <>
        {profiles.length > 0 && <label className="mb-4 flex flex-col gap-1.5"><span style={{ color: color.textFaint, fontSize: 10.5 }}>Brand Profile (ถ้ามี)</span><select defaultValue="" disabled={changing} onChange={(event) => { if (event.target.value) void pinProfile(event.target.value); }} className="min-h-10 w-full max-w-sm rounded-lg px-3" style={{ background: "rgba(255,255,255,.05)", border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 12 }}><option value="" style={{ background: color.bg1 }}>ใช้แนวภาพของคลิปนี้</option>{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.frozen} style={{ background: color.bg1 }}>{profile.name} · Revision {profile.activeRevisionNumber}{profile.frozen ? " (อ่านอย่างเดียว)" : ""}</option>)}</select></label>}
        {preflight && <div className="mb-3 flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full px-2 py-1" style={{ background: "rgba(56,189,248,.10)", color: "#7dd3fc", fontSize: 10 }}><Sparkles size={11} /> AI แนะนำ {formats.find((item) => item.id === preflight.suggestedVisualFormatId)?.label}</span><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight.suggestedTreatment.label}</span></div>}
        {outdatedBeatCount > 0 && <div className="mb-3 rounded-xl px-3 py-2.5" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.25)" }}><p style={{ color: "#fcd34d", font: `600 11px ${font.heading}` }}>สคริปต์เปลี่ยน {outdatedBeatCount} Visual Beat · ราคา {outdatedBeatCount * 2} เครดิต</p><p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>ภาพเดิมยังอยู่และยังไม่ถูกคิดเงิน เมื่อคุณยืนยันสร้างครั้งถัดไป ระบบจะใช้ภาพที่ยังตรงกับสคริปต์ซ้ำ และสร้างใหม่เฉพาะ {outdatedBeatCount} ภาพนี้</p></div>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{formats.map((format) => { const isSelected = selected === format.id; return <button key={format.id} type="button" disabled={changing} onClick={() => void applyLook(format.id)} className="relative overflow-hidden text-left" style={{ border: `1px solid ${isSelected ? "#38BDF8" : color.cardBorder}`, borderRadius: 8, background: isSelected ? "rgba(56,189,248,.09)" : "rgba(255,255,255,.025)", opacity: changing ? .65 : 1 }}><div className="relative aspect-[16/9] overflow-hidden"><img src={format.previewUrl} alt="" className="h-full w-full object-cover object-[center_30%]" /></div><div className="flex min-h-10 items-center justify-between gap-1 px-2 py-1.5"><span style={{ color: isSelected ? "#7dd3fc" : color.textSecondary, font: `500 10.5px ${font.heading}`, lineHeight: 1.25 }}>{format.label}</span>{isSelected && <Check size={12} color="#38BDF8" />}</div></button>; })}</div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span style={{ fontSize: 10.5, color: color.textFaint }}>{preflight?.visualBeats.length ?? 0} Visual Beats · การวิเคราะห์ไม่ใช้เครดิต</span><span className="flex flex-wrap gap-3"><Link href={p.projectId ? `/brands?new=1&projectId=${encodeURIComponent(p.projectId)}` : "/brands?new=1"} className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: "#7dd3fc", fontWeight: 600 }}>+ สร้างแบรนด์จากคลิปนี้</Link><Link href="/brands" className="inline-flex items-center gap-1" style={{ fontSize: 10.5, color: color.textFaint, fontWeight: 600 }}>จัดการคลัง</Link></span></div>
      </>}
      {pending && <div className="mt-4 rounded-xl p-3" style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.28)" }}><div className="flex gap-2"><ImageIcon size={15} color="#fbbf24" className="mt-0.5 shrink-0" /><div><p style={{ color: color.text, font: `600 11.5px ${font.heading}` }}>มีภาพเดิม {pending.existingImageCount} ภาพ</p><p className="mt-1" style={{ color: color.textSecondary, fontSize: 10.5, lineHeight: 1.55 }}>ระบบจะไม่สร้างใหม่เอง เลือกว่าจะเตรียมสร้างทั้งหมดใหม่ ({pending.quotedCredits} เครดิตตามราคา 2 เครดิต/ภาพ) หรือใช้ “{pending.label}” เฉพาะภาพต่อจากนี้</p></div></div><div className="mt-3 flex flex-wrap gap-2"><button disabled={changing} onClick={() => pending.kind === "look" ? void applyLook(pending.formatId, "regenerate-all") : void pinProfile(pending.profileId, "regenerate-all")} className="min-h-9 rounded-lg px-3" style={{ background: "#fbbf24", color: "#1c1917", fontSize: 10.5, fontWeight: 700 }}>สร้างทุกภาพใหม่ให้เป็นแนวเดียวกัน</button><button disabled={changing} onClick={() => pending.kind === "look" ? void applyLook(pending.formatId, "new-only") : void pinProfile(pending.profileId, "new-only")} className="min-h-9 rounded-lg px-3" style={{ border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 10.5 }}>ใช้แนวใหม่เฉพาะภาพต่อจากนี้</button></div><p className="mt-2" style={{ color: "#fcd34d", fontSize: 10 }}>ตัวเลือกหลังทำให้คลิปมีมากกว่าหนึ่งแนวภาพ</p></div>}
      {p.starterAiImageAllowance?.eligible && p.starterAiImageAllowance.remainingImages === 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3" style={{ background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.25)" }}><span className="flex items-center gap-2" style={{ fontSize: 11, color: "#fca5a5" }}><LockKeyhole size={14} /> ใช้สิทธิ์ทดลองภาพครบแล้ว ระบบจะไม่เปลี่ยนเป็น Stock เอง</span><span className="flex gap-2"><Link href="/pricing" className="rounded-lg bg-white px-3 py-2 text-[10.5px] font-bold text-black">อัปเกรดรายเดือน</Link><button onClick={() => p.setMixPreset("free")} className="rounded-lg px-3 py-2" style={{ border: `1px solid ${color.cardBorder}`, color: color.text, fontSize: 10.5 }}>ใช้ Stock ฟรี</button></span></div>}
    </div>}
  </section>;
}
