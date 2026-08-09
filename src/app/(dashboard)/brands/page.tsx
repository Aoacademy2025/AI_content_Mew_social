"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Eye,
  ImageIcon,
  Loader2,
  LockKeyhole,
  Plus,
  Save,
  Sparkles,
  SwatchBook,
  WandSparkles,
} from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import { fetchMe, type MeData } from "@/lib/use-me";

type VisualFormatId = "cinematic-realism" | "stick-figure-story" | "dramatic-comic" | "clear-infographic" | "retro-story";
type BrandPayload = {
  schemaVersion: 1;
  name: string;
  niche: string;
  audience: string;
  script: {
    styleId: string | null;
    tone: string;
    bannedWords: string[];
    ctaStyle: string;
    language: string;
    analysisNotes?: string | null;
    sampleText?: string | null;
  };
  voice: { provider: string; voiceId: string | null };
  subtitle: { presetId: string | null; config: Record<string, string | number | boolean | null> };
  brandMark: { assetId: string | null; enabled: boolean; position: string; sizePct: number; opacity: number };
  visual: {
    primaryVisualFormatId: VisualFormatId;
    palette: string[];
    personality: string;
    peopleAndSetting: string;
    memorableCues: string[];
    visualNotes: string;
    defaultTreatment: string;
  };
};
type VisualFormat = { id: VisualFormatId; label: string; description: string; recipeVersion: string; previewUrl: string };
type Revision = { id: string; version: number; payload: BrandPayload | null; createdAt: string };
type BrandProfile = {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  bannedWords: string[];
  ctaStyle: string;
  language: string;
  analysisNotes: string | null;
  sampleText: string | null;
  activeRevisionNumber: number;
  frozen: boolean;
  updatedAt: string;
  draft: { baseRevisionNumber: number; payload: BrandPayload | null } | null;
  revisions: Revision[];
};
type BrandDefaults = {
  script: { styleId: string | null; tone: string; analysisNotes: string | null; sampleText: string | null };
  voice: { provider: string; voiceId: string | null };
  subtitle: { presetId: string | null; config: Record<string, string | number | boolean | null> };
  brandMark: { assetId: string | null; assetName: string | null; enabled: boolean; position: string; sizePct: number; opacity: number };
};
type LibraryResponse = {
  profiles: BrandProfile[];
  cap: number | null;
  canCreate: boolean;
  availabilitySelectionRequired: boolean;
  canRestoreAll: boolean;
  visualFormats: VisualFormat[];
  defaults: BrandDefaults;
};
type PreviewItem = { id: string; phase: string; status: string; outputUrl: string | null; sourceType: string; errorCode: string | null };
type PreviewBatch = { id: string; status: string; items: PreviewItem[] };
type ProjectVisualSeed = {
  contentDomain?: string | null;
  context?: {
    visualFormatId?: VisualFormatId;
    treatment?: string;
    brandVisualLanguage?: Partial<BrandPayload["visual"]> | null;
  };
};

const INK = "#151515";
const BLUE = "#38BDF8";
const PAPER = "#F6F1E8";

function newPayload(defaults?: BrandDefaults): BrandPayload {
  return {
    schemaVersion: 1,
    name: "",
    niche: "",
    audience: "",
    script: {
      styleId: defaults?.script.styleId ?? null,
      tone: defaults?.script.tone || "ชัดเจน เป็นกันเอง และมีพลัง",
      bannedWords: [],
      ctaStyle: "follow",
      language: "th",
      analysisNotes: defaults?.script.analysisNotes ?? null,
      sampleText: defaults?.script.sampleText ?? null,
    },
    voice: defaults?.voice ?? { provider: "elevenlabs", voiceId: null },
    subtitle: defaults?.subtitle ?? { presetId: null, config: {} },
    brandMark: defaults?.brandMark
      ? { assetId: defaults.brandMark.assetId, enabled: defaults.brandMark.enabled, position: defaults.brandMark.position, sizePct: defaults.brandMark.sizePct, opacity: defaults.brandMark.opacity }
      : { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "stick-figure-story",
      palette: ["#151515", "#F6F1E8", BLUE],
      personality: "กล้าตรง มีพลัง และจดจำง่าย",
      peopleAndSetting: "ผู้ชมชาวไทยในสถานการณ์จริงที่คุ้นเคย",
      memorableCues: ["วงกลมเน้นจุดสำคัญ", "ลูกศรนำสายตา"],
      visualNotes: "เว้นพื้นที่ช่วงล่างให้โล่งและรักษาองค์ประกอบหลักให้เด่น",
      defaultTreatment: "ชัด กระชับ และมีพลัง",
    },
  };
}

async function responseJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || "ดำเนินการไม่สำเร็จ");
  return value;
}

export default function BrandLibraryPage() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrandPayload>(() => newPayload());
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [proposal, setProposal] = useState<(BrandPayload["visual"] & { rationale?: string }) | null>(null);
  const [preview, setPreview] = useState<PreviewBatch | null>(null);
  const [availabilityChoice, setAvailabilityChoice] = useState<string[]>([]);
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);

  const activeProfile = useMemo(
    () => library?.profiles.find((profile) => profile.id === activeId) ?? null,
    [activeId, library],
  );
  const allowance = me?.starterAiImageAllowance;

  async function load(preferredId?: string) {
    let [libraryData, meData] = await Promise.all([
      fetch("/api/brand-library", { cache: "no-store" }).then(responseJson) as Promise<LibraryResponse>,
      fetchMe(true),
    ]);
    if (libraryData.canRestoreAll) {
      await responseJson(await fetch("/api/brand-library/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredProfileIds: [] }),
      }));
      libraryData = await fetch("/api/brand-library", { cache: "no-store" })
        .then(responseJson) as LibraryResponse;
    }
    setLibrary(libraryData);
    setMe(meData);
    setAvailabilityChoice((current) => libraryData.availabilitySelectionRequired
      ? current.filter((id) => libraryData.profiles.some((profile) => profile.id === id))
      : []);
    const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const requestedProjectId = params?.get("projectId")?.trim() || null;
    if (!preferredId && params?.get("new") === "1") {
      let seeded = newPayload(libraryData.defaults);
      if (requestedProjectId) {
        const visualSeed = await fetch(`/api/editor-projects/${encodeURIComponent(requestedProjectId)}/visual-context`, { cache: "no-store" })
          .then(responseJson) as ProjectVisualSeed;
        const language = visualSeed.context?.brandVisualLanguage;
        seeded = {
          ...seeded,
          niche: visualSeed.contentDomain?.trim() || seeded.niche,
          visual: {
            ...seeded.visual,
            primaryVisualFormatId: visualSeed.context?.visualFormatId ?? seeded.visual.primaryVisualFormatId,
            defaultTreatment: visualSeed.context?.treatment?.trim() || seeded.visual.defaultTreatment,
            palette: Array.isArray(language?.palette) ? language.palette : seeded.visual.palette,
            personality: typeof language?.personality === "string" ? language.personality : seeded.visual.personality,
            peopleAndSetting: typeof language?.peopleAndSetting === "string" ? language.peopleAndSetting : seeded.visual.peopleAndSetting,
            memorableCues: Array.isArray(language?.memorableCues) ? language.memorableCues : seeded.visual.memorableCues,
            visualNotes: typeof language?.visualNotes === "string" ? language.visualNotes : seeded.visual.visualNotes,
          },
        };
      }
      setActiveId(null);
      setSourceProjectId(requestedProjectId);
      setDraft(seeded);
      setStep(1);
      setProposal(null);
      setPreview(null);
      setLoading(false);
      return;
    }
    setSourceProjectId(null);
    const nextId = preferredId ?? activeId ?? libraryData.profiles[0]?.id ?? null;
    if (nextId) openProfile(libraryData.profiles.find((profile) => profile.id === nextId)!, libraryData.defaults);
    else setDraft(newPayload(libraryData.defaults));
    setLoading(false);
  }

  function toggleAvailability(profileId: string) {
    const cap = library?.cap ?? 0;
    setAvailabilityChoice((current) => {
      if (current.includes(profileId)) return current.filter((id) => id !== profileId);
      if (cap <= 1) return [profileId];
      return current.length < cap ? [...current, profileId] : current;
    });
  }

  async function confirmAvailability() {
    if (!library?.availabilitySelectionRequired || library.cap === null) return;
    setBusy("availability"); setNotice(null);
    try {
      await responseJson(await fetch("/api/brand-library/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredProfileIds: availabilityChoice }),
      }));
      await load(availabilityChoice[0]);
      setNotice({ tone: "ok", text: "บันทึกแบรนด์ที่ใช้กับงานใหม่แล้ว โปรเจกต์เดิมยังใช้ Revision ที่ pin ไว้ได้ครบ" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกแบรนด์ที่เลือกไม่สำเร็จ" });
    } finally { setBusy(null); }
  }

  useEffect(() => { load().catch((error) => { setNotice({ tone: "error", text: error.message }); setLoading(false); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openProfile(profile: BrandProfile, defaults = library?.defaults) {
    setSourceProjectId(null);
    setActiveId(profile.id);
    const stored = profile.draft?.payload ?? profile.revisions[0]?.payload;
    const base = newPayload(defaults);
    setDraft(stored ?? {
      ...base,
      name: profile.name,
      niche: profile.niche,
      audience: profile.audience,
      script: {
        ...base.script,
        tone: profile.tone,
        bannedWords: profile.bannedWords,
        ctaStyle: profile.ctaStyle,
        language: profile.language,
        analysisNotes: profile.analysisNotes,
        sampleText: profile.sampleText,
      },
    });
    setStep(1);
    setProposal(null);
    setPreview(null);
    setNotice(null);
  }

  function startNew() {
    setSourceProjectId(null);
    setActiveId(null);
    setDraft(newPayload(library?.defaults));
    setStep(1);
    setProposal(null);
    setPreview(null);
    setNotice(null);
    trackEvent("brand_profile_create_started", { path: "/brands" });
  }

  function updateVisual<K extends keyof BrandPayload["visual"]>(key: K, value: BrandPayload["visual"][K]) {
    setDraft((current) => ({ ...current, visual: { ...current.visual, [key]: value } }));
  }

  async function saveDraftOnly() {
    if (!activeId) return;
    setBusy("save");
    try {
      await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
      }));
      await load(activeId);
      setNotice({ tone: "ok", text: "บันทึกร่างแล้ว งานเดิมและ Revision ที่ใช้อยู่ยังไม่เปลี่ยน" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }); }
    finally { setBusy(null); }
  }

  async function publishOrCreate() {
    setBusy("publish");
    setNotice(null);
    try {
      if (activeId) {
        await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
        }));
        await responseJson(await fetch(`/api/brand-library/${activeId}/publish`, { method: "POST" }));
        await load(activeId);
        setNotice({ tone: "ok", text: "สร้าง Revision ใหม่แล้ว โปรเจกต์เดิมยังใช้ Revision เดิมจนกว่าคุณจะเลือกเปลี่ยน" });
      } else {
        const created = await responseJson(await fetch("/api/brand-library", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
        }));
        if (sourceProjectId) {
          await responseJson(await fetch(`/api/editor-projects/${encodeURIComponent(sourceProjectId)}/brand-revision`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId: created.profileId, applyMode: "new-only" }),
          }));
          window.history.replaceState({}, "", "/brands");
        }
        await load(created.profileId);
        setNotice({
          tone: "ok",
          text: sourceProjectId
            ? "บันทึกแบรนด์และ pin Revision ให้คลิปนี้แล้ว ภาพเดิมไม่ถูกสร้างซ้ำ"
            : "บันทึกแนวภาพเข้าคลังแบรนด์แล้ว",
        });
      }
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }); }
    finally { setBusy(null); }
  }

  async function askVisualHelper() {
    setBusy("helper"); setProposal(null); setNotice(null);
    try {
      const value = await responseJson(await fetch("/api/brand-library/suggest-visual", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ niche: draft.niche, audience: draft.audience, sample: draft.visual.visualNotes }),
      }));
      setProposal(value.proposal);
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "ขอคำแนะนำไม่สำเร็จ" }); }
    finally { setBusy(null); }
  }

  async function previewLook() {
    setBusy("preview"); setPreview(null); setNotice(null);
    try {
      let endpoint = "/api/brand-library/preview";
      let body: Record<string, unknown> = { payload: draft };
      if (activeId) {
        await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
        }));
        endpoint = `/api/brand-library/${activeId}/preview`;
        body = { useDraft: true, ...(sourceProjectId ? { projectId: sourceProjectId } : {}) };
      } else if (sourceProjectId) {
        body = { payload: draft, projectId: sourceProjectId };
      }
      const value = await responseJson(await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      setPreview(value.batch);
      await fetchMe(true).then(setMe);
      trackEvent("brand_look_preview_viewed", { path: "/brands", properties: { status: value.batch.status } });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "ทดลองภาพไม่สำเร็จ" }); }
    finally { setBusy(null); }
  }

  async function rerollPreviewItem(itemId: string) {
    setBusy(`reroll:${itemId}`); setNotice(null);
    try {
      const value = await responseJson(await fetch(`/api/brand-library/preview-items/${encodeURIComponent(itemId)}/reroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      }));
      setPreview((current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === itemId ? value.item : item),
      } : current);
      await fetchMe(true).then(setMe);
    } catch (error) {
      setNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "ลองภาพใหม่ไม่สำเร็จ"} — ภาพเดิมยังอยู่`,
      });
    } finally { setBusy(null); }
  }

  if (loading) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-sky-500" /></div>;
  if (!library) return <div className="p-8 text-sm text-red-500">โหลด Brand Library ไม่สำเร็จ</div>;

  const previewCost = allowance?.eligible ? "ใช้สิทธิ์ทดลอง 3 ภาพ" : "6 เครดิต (3 ภาพ × 2 เครดิต)";
  const canPublish = draft.name.trim() && draft.niche.trim() && draft.audience.trim() && draft.script.tone.trim();

  return (
    <main className="relative flex-1 overflow-y-auto bg-[#eee9df] text-[#151515] dark:bg-[#121212] dark:text-[#f4efe5]">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.06]" style={{ backgroundImage: "linear-gradient(#151515 1px, transparent 1px), linear-gradient(90deg, #151515 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
      <div className="relative mx-auto max-w-[1440px] px-4 py-6 md:px-7 md:py-8">
        <header className="mb-7 grid gap-5 border-2 border-[#151515] bg-[#f8f4ec] p-5 shadow-[7px_7px_0_#151515] dark:border-[#f4efe5] dark:bg-[#1b1b1b] dark:shadow-[7px_7px_0_#38BDF8] md:grid-cols-[1fr_auto] md:p-7">
          <div className="max-w-3xl">
            <div className="mb-4 inline-flex items-center gap-2 bg-[#151515] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.22em] text-[#f8f4ec] dark:bg-[#38BDF8] dark:text-[#151515]">
              <SwatchBook className="h-3.5 w-3.5" /> Brand direction desk
            </div>
            <h1 className="text-3xl font-black leading-[1.05] tracking-[-.035em] md:text-5xl" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>แนวภาพที่คนเห็นแล้ว<br /><span className="text-sky-500">จำได้ว่าเป็นคุณ</span></h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-black/60 dark:text-white/60">เก็บสคริปต์ เสียง ซับ ลายน้ำ และภาษาภาพไว้ใน Brand Profile เดียว โปรเจกต์แต่ละชิ้นยังแก้แนวภาพของตัวเองได้เสมอ</p>
          </div>
          <div className="flex min-w-[220px] flex-col justify-between border-l-0 border-black/15 pt-4 md:border-l md:pl-6 md:pt-0 dark:border-white/15">
            {allowance?.eligible ? <>
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-black/45 dark:text-white/45">Starter AI images</p><p className="mt-1 text-4xl font-black tabular-nums">{allowance.remainingImages}<span className="text-base font-semibold text-black/40 dark:text-white/40"> / {allowance.limitImages}</span></p></div>
              <p className="mt-3 text-xs leading-5 text-black/55 dark:text-white/55">คงเหลือในรอบนี้ · การวิเคราะห์และเลือกแนวภาพไม่ใช้สิทธิ์</p>
            </> : <>
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-black/45 dark:text-white/45">Funding</p><p className="mt-2 text-lg font-black">Shared credit wallet</p></div>
              <p className="mt-3 text-xs text-black/55 dark:text-white/55">ภาพ AI ราคา 2 เครดิตต่อภาพ</p>
            </>}
          </div>
        </header>

        {library.availabilitySelectionRequired && library.cap !== null && <section className="relative mb-5 border-2 border-amber-500 bg-amber-100 p-4 text-amber-950 shadow-[5px_5px_0_#151515] dark:bg-amber-950 dark:text-amber-100">
          <p className="text-sm font-black">เลือก {library.cap} แบรนด์สำหรับงานใหม่</p>
          <p className="mt-1 text-xs leading-5 opacity-75">แผนปัจจุบันรองรับน้อยกว่าจำนวนที่มี ระบบไม่ลบข้อมูลใด และโปรเจกต์เดิมยัง render ด้วย Revision ที่ pin ไว้ได้</p>
          <div className="mt-3 flex flex-wrap gap-2">{library.profiles.map((profile) => { const selected = availabilityChoice.includes(profile.id); return <button key={profile.id} type="button" onClick={() => toggleAvailability(profile.id)} className={`inline-flex min-h-9 items-center gap-2 border px-3 text-xs font-bold ${selected ? "border-[#151515] bg-[#151515] text-white dark:border-amber-200 dark:bg-amber-200 dark:text-[#151515]" : "border-amber-700/35 bg-white/50 dark:bg-black/20"}`}>{selected && <Check className="h-3.5 w-3.5" />}{profile.name}</button>; })}</div>
          <button type="button" onClick={confirmAvailability} disabled={busy !== null || availabilityChoice.length !== library.cap} className="mt-3 inline-flex min-h-10 items-center gap-2 bg-[#38BDF8] px-4 text-xs font-black text-[#151515] disabled:opacity-40">{busy === "availability" && <Loader2 className="h-4 w-4 animate-spin" />} ยืนยันแบรนด์ที่ใช้ต่อ</button>
        </section>}

        <div className="grid gap-5 lg:grid-cols-[270px_minmax(0,1fr)]">
          <aside className="h-fit border border-black/20 bg-white/65 p-3 dark:border-white/15 dark:bg-white/[.04] lg:sticky lg:top-5">
            <div className="flex items-center justify-between px-2 py-2"><p className="text-xs font-black uppercase tracking-[.16em]">คลังแบรนด์</p><span className="text-[11px] text-black/45 dark:text-white/45">{library.profiles.length}/{library.cap ?? "∞"}</span></div>
            <button onClick={startNew} disabled={!library.canCreate} className="mb-3 flex min-h-11 w-full items-center justify-center gap-2 border-2 border-[#151515] bg-[#38BDF8] px-3 text-sm font-black text-[#151515] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#f4efe5]"><Plus className="h-4 w-4" /> สร้างแบรนด์ใหม่</button>
            <div className="space-y-1.5">
              {library.profiles.map((profile) => <button key={profile.id} onClick={() => openProfile(profile)} className={`w-full border px-3 py-3 text-left transition-colors ${activeId === profile.id ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-[#151515]" : "border-transparent hover:border-black/20 hover:bg-white/70 dark:hover:border-white/20 dark:hover:bg-white/[.05]"}`}>
                <div className="flex items-start justify-between gap-2"><span className="text-sm font-bold leading-5">{profile.name}</span>{profile.frozen && <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />}</div>
                <p className={`mt-1 truncate text-[11px] ${activeId === profile.id ? "opacity-70" : "text-black/45 dark:text-white/45"}`}>{profile.niche} · Revision {profile.activeRevisionNumber || "—"}</p>
              </button>)}
              {!library.profiles.length && <p className="px-2 py-6 text-center text-xs leading-5 text-black/45 dark:text-white/45">ยังไม่มีแบรนด์<br />เริ่มจากเลือกภาพที่ใช่ที่สุด</p>}
            </div>
          </aside>

          <section className="min-w-0 border border-black/20 bg-[#f8f4ec] dark:border-white/15 dark:bg-[#1a1a1a]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/15 px-4 py-4 dark:border-white/15 md:px-6">
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-sky-500">{activeProfile ? `Revision ${activeProfile.activeRevisionNumber}` : "New brand profile"}</p><h2 className="mt-1 text-lg font-black">{activeProfile?.name || "ออกแบบแนวภาพใหม่"}</h2></div>
              <div className="flex items-center gap-2 text-xs font-bold"><span className={`flex h-6 w-6 items-center justify-center border ${step === 1 ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-black" : "border-black/20 dark:border-white/20"}`}>1</span><span className="h-px w-5 bg-black/20 dark:bg-white/20" /><span className={`flex h-6 w-6 items-center justify-center border ${step === 2 ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-black" : "border-black/20 dark:border-white/20"}`}>2</span></div>
            </div>

            {sourceProjectId && <div className="border-b border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs leading-5 md:px-6"><span className="font-black">เริ่มจากคลิปที่คุณเพิ่งสร้าง</span> — แนวภาพและ Content Domain ถูกเติมให้ตรวจแล้ว การบันทึกจะสร้าง Brand Profile และ pin Revision ให้โปรเจกต์นี้อย่างชัดเจน</div>}

            {activeProfile?.frozen ? <div className="m-5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm"><p className="font-bold">แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียว</p><p className="mt-1 text-black/60 dark:text-white/60">โปรเจกต์เดิมยัง render ด้วย Revision ที่ pin ไว้ได้ อัปเกรดเพื่อแก้หรือใช้กับโปรเจกต์ใหม่</p></div> : null}

            {step === 1 ? <div className="p-4 md:p-6">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.16em]">01 — เลือกภาษาภาพ</p><p className="mt-2 text-sm text-black/55 dark:text-white/55">ภาพทั้ง 5 ใช้ฉาก benchmark เดียวกันและผ่าน Quality Gate บน Z-Image แล้ว</p></div><span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" /> ตรวจแล้ว 21/21 ภาพ</span></div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {library.visualFormats.map((format, index) => { const selected = draft.visual.primaryVisualFormatId === format.id; return <button key={format.id} onClick={() => updateVisual("primaryVisualFormatId", format.id)} className={`group relative overflow-hidden border-2 text-left transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-400/40 ${selected ? "border-[#38BDF8] shadow-[4px_4px_0_#151515] dark:shadow-[4px_4px_0_#38BDF8]" : "border-transparent opacity-75 hover:opacity-100"}`}>
                  <div className="relative aspect-[9/14] bg-neutral-200"><Image src={format.previewUrl} alt={`ตัวอย่างแนวภาพ ${format.label}`} fill sizes="(max-width: 768px) 50vw, 180px" className="object-cover" priority={index < 2} /></div>
                  <div className={`absolute inset-x-0 bottom-0 p-2.5 ${selected ? "bg-[#38BDF8] text-[#151515]" : "bg-[#151515]/90 text-white"}`}><div className="flex items-center justify-between gap-1"><p className="text-xs font-black leading-4">{format.label}</p>{selected && <Check className="h-3.5 w-3.5 shrink-0" />}</div></div>
                </button>; })}
              </div>
              <div className="mt-6 flex justify-end"><button onClick={() => setStep(2)} className="flex min-h-11 items-center gap-2 bg-[#151515] px-5 text-sm font-black text-white hover:bg-sky-500 hover:text-[#151515] dark:bg-[#f4efe5] dark:text-[#151515]">กำหนดลายเซ็นของแบรนด์ <ArrowRight className="h-4 w-4" /></button></div>
            </div> : <div className="p-4 md:p-6">
              <button onClick={() => setStep(1)} className="mb-5 inline-flex items-center gap-1.5 text-xs font-bold text-black/50 hover:text-black dark:text-white/50 dark:hover:text-white"><ChevronLeft className="h-4 w-4" /> กลับไปเลือกแนวภาพ</button>
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="ชื่อแบรนด์" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} placeholder="เช่น Mewsocial" />
                    <Field label="นิชหลัก" value={draft.niche} onChange={(value) => setDraft({ ...draft, niche: value })} placeholder="เช่น การตลาดสำหรับ Creator" />
                  </div>
                  <Field label="กลุ่มเป้าหมาย" value={draft.audience} onChange={(value) => setDraft({ ...draft, audience: value })} placeholder="ใครควรรู้สึกว่านี่ทำมาเพื่อเขา" />
                  <div><Label>สีประจำแบรนด์</Label><div className="mt-2 flex flex-wrap gap-2">{draft.visual.palette.map((color, index) => <label key={`${index}-${color}`} className="flex h-11 items-center gap-2 border border-black/20 bg-white px-2 dark:border-white/20 dark:bg-white/[.04]"><input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#151515"} onChange={(event) => updateVisual("palette", draft.visual.palette.map((item, itemIndex) => itemIndex === index ? event.target.value.toUpperCase() : item))} className="h-7 w-7 cursor-pointer border-0 bg-transparent p-0" /><span className="font-mono text-[11px]">{color}</span></label>)}</div></div>
                  <Field label="บุคลิกของภาพ" value={draft.visual.personality} onChange={(value) => updateVisual("personality", value)} />
                  <div><Label>จุดจำที่ควรกลับมาซ้ำ</Label><textarea value={draft.visual.memorableCues.join("\n")} onChange={(event) => updateVisual("memorableCues", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 6))} rows={3} className="mt-2 w-full border border-black/25 bg-white px-3 py-2.5 text-sm outline-none focus:border-sky-500 dark:border-white/20 dark:bg-white/[.04]" placeholder="หนึ่งจุดจำต่อบรรทัด" /></div>
                  <details className="border-t border-black/15 pt-4 dark:border-white/15"><summary className="cursor-pointer text-sm font-black">ตั้งค่าเพิ่มเติม — สคริปต์ เสียง ซับ โลโก้ และรายละเอียดภาพ</summary><div className="mt-4 grid gap-4">
                    <Field label="โทนสคริปต์" value={draft.script.tone} onChange={(value) => setDraft({ ...draft, script: { ...draft.script, tone: value } })} />
                    <div><Label>โน้ตสไตล์การเขียน</Label><textarea value={draft.script.analysisNotes ?? ""} onChange={(event) => setDraft({ ...draft, script: { ...draft.script, analysisNotes: event.target.value || null } })} rows={4} maxLength={4000} className="mt-2 w-full border border-black/25 bg-white px-3 py-2.5 text-sm outline-none focus:border-sky-500 dark:border-white/20 dark:bg-white/[.04]" placeholder="ระบบเติมจาก Writing Style เดิมให้ตรวจและแก้ได้" /></div>
                    <Field label="คนและสถานที่" value={draft.visual.peopleAndSetting} onChange={(value) => updateVisual("peopleAndSetting", value)} />
                    <Field label="อารมณ์เริ่มต้นของภาพ" value={draft.visual.defaultTreatment} onChange={(value) => updateVisual("defaultTreatment", value)} />
                    <div><Label>โน้ตทิศทางภาพ</Label><textarea value={draft.visual.visualNotes} onChange={(event) => updateVisual("visualNotes", event.target.value)} rows={4} className="mt-2 w-full border border-black/25 bg-white px-3 py-2.5 text-sm outline-none focus:border-sky-500 dark:border-white/20 dark:bg-white/[.04]" /></div>
                    <div className="grid gap-2 border border-black/10 bg-black/[.025] p-3 text-xs text-black/55 dark:border-white/10 dark:bg-white/[.03] dark:text-white/55 md:grid-cols-3"><span>เสียง: {draft.voice.provider}{draft.voice.voiceId ? " · ใช้ค่าปัจจุบัน" : ""}</span><span>ซับ: {draft.subtitle.presetId ? "ใช้ preset ปัจจุบัน" : "ค่าเริ่มต้น"}</span><span>ลายน้ำ: {draft.brandMark.enabled ? "เปิด" : "ปิด"}</span></div>
                  </div></details>
                </div>

                <aside className="space-y-4">
                  <div className="border-2 border-[#151515] bg-white p-4 dark:border-[#f4efe5] dark:bg-[#222]"><div className="flex items-center gap-2"><WandSparkles className="h-4 w-4 text-sky-500" /><p className="text-sm font-black">ผู้ช่วยออกแบบแนวภาพ</p></div><p className="mt-2 text-xs leading-5 text-black/55 dark:text-white/55">AI เสนอค่าให้ดูก่อนเท่านั้น ไม่สร้างภาพและไม่เปลี่ยนร่างจนกว่าคุณจะกดนำมาใช้</p><button onClick={askVisualHelper} disabled={busy !== null || !draft.niche || !draft.audience} className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 border border-black/25 text-xs font-black hover:border-sky-500 disabled:opacity-40 dark:border-white/20">{busy === "helper" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} ขอคำแนะนำ</button>
                    {proposal && <div className="mt-4 border-l-4 border-sky-400 bg-sky-400/10 p-3"><p className="text-xs font-black">AI แนะนำ: {library.visualFormats.find((format) => format.id === proposal.primaryVisualFormatId)?.label}</p><p className="mt-1 text-[11px] leading-5 text-black/55 dark:text-white/55">{proposal.rationale}</p><button onClick={() => { const { rationale: _rationale, ...visual } = proposal; setDraft((current) => ({ ...current, visual })); setProposal(null); }} className="mt-2 text-xs font-black text-sky-600 underline underline-offset-4 dark:text-sky-400">นำคำแนะนำมาใส่ในร่าง</button></div>}
                  </div>
                  <div className="border border-black/20 bg-[#151515] p-4 text-white dark:border-white/20"><div className="flex items-center gap-2"><Eye className="h-4 w-4 text-sky-400" /><p className="text-sm font-black">ทดลอง Hook · Explain · Close</p></div><p className="mt-2 text-xs leading-5 text-white/60">{sourceProjectId ? "ใช้ 3 ฉากจริงของคลิป และนำภาพเดิมกลับมาใช้โดยไม่คิดซ้ำ" : `${previewCost} · การเปิดดูเฉย ๆ ไม่คิดเพิ่ม`}</p><button onClick={previewLook} disabled={busy !== null || !canPublish || (!sourceProjectId && allowance?.eligible && allowance.remainingImages < 3)} className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 bg-[#38BDF8] px-3 text-xs font-black text-[#151515] disabled:opacity-40">{busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />} ทดลอง 3 ภาพ</button>{!sourceProjectId && allowance?.eligible && allowance.remainingImages < 3 && <Link href="/pricing" className="mt-3 block text-center text-xs font-bold text-sky-300 underline underline-offset-4">สิทธิ์ไม่พอ — ดูแผนรายเดือน</Link>}</div>
                </aside>
              </div>

              {preview && <div className="mt-6 border-t-2 border-[#151515] pt-5 dark:border-[#f4efe5]"><div className="mb-3 flex items-center justify-between"><p className="text-sm font-black">Brand Look Preview</p><span className="text-[11px] font-bold uppercase tracking-[.15em] text-black/45 dark:text-white/45">{preview.status}</span></div><div className="grid grid-cols-3 gap-2">{preview.items.map((item) => <figure key={item.id} className="relative aspect-[9/16] overflow-hidden bg-black/10 dark:bg-white/10">{item.outputUrl ? <img src={item.outputUrl} alt={`ภาพทดลอง ${item.phase}`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center px-2 text-center text-xs text-red-500">{item.errorCode || "สร้างไม่สำเร็จ"}</div>}<button type="button" onClick={() => rerollPreviewItem(item.id)} disabled={busy !== null} className="absolute right-2 top-2 inline-flex min-h-8 items-center gap-1 bg-white/90 px-2 text-[10px] font-black text-[#151515] shadow disabled:opacity-50">{busy === `reroll:${item.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} ลองภาพนี้ใหม่</button><figcaption className="absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1.5 text-[10px] font-bold uppercase tracking-[.14em] text-white">{item.phase} · {item.sourceType === "reused" ? "ใช้ภาพเดิม" : "ภาพใหม่"}</figcaption></figure>)}</div><p className="mt-2 text-[10px] text-black/45 dark:text-white/45">ลองใหม่คิด 1 ภาพ ({allowance?.eligible ? "สิทธิ์ทดลอง 1 ภาพ" : "2 เครดิต"}) และหากล้มเหลวภาพเดิมจะไม่หาย</p></div>}

              {notice && <div role="status" className={`mt-5 border-l-4 p-3 text-sm ${notice.tone === "ok" ? "border-emerald-500 bg-emerald-500/10" : "border-red-500 bg-red-500/10"}`}>{notice.text}</div>}
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-black/15 pt-5 dark:border-white/15"><p className="max-w-xl text-[11px] leading-5 text-black/45 dark:text-white/45">การแก้ร่างหรือทดลองภาพยังไม่เปลี่ยน Revision ที่โปรเจกต์ใช้อยู่ ภาพเดิมจะไม่ถูกสร้างใหม่อัตโนมัติ</p><div className="flex flex-wrap gap-2">{activeId && <button onClick={saveDraftOnly} disabled={busy !== null || !canPublish || activeProfile?.frozen} className="flex min-h-11 items-center gap-2 border border-black/30 px-4 text-sm font-black disabled:opacity-40 dark:border-white/25"><Save className="h-4 w-4" /> บันทึกร่าง</button>}<button onClick={publishOrCreate} disabled={busy !== null || !canPublish || activeProfile?.frozen} className="flex min-h-11 items-center gap-2 bg-[#151515] px-5 text-sm font-black text-white hover:bg-sky-500 hover:text-[#151515] disabled:opacity-40 dark:bg-[#f4efe5] dark:text-[#151515]">{busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{activeId ? "ใช้แนวภาพใหม่นี้" : "บันทึกเข้าคลังแบรนด์"}</button></div></div>
            </div>}
          </section>
        </div>
      </div>
    </main>
  );
}

function Label({ children }: { children: React.ReactNode }) { return <label className="text-[11px] font-black uppercase tracking-[.13em] text-black/55 dark:text-white/55">{children}</label>; }
function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <div><Label>{label}</Label><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-2 min-h-11 w-full border border-black/25 bg-white px-3 text-sm outline-none transition-colors placeholder:text-black/30 focus:border-sky-500 dark:border-white/20 dark:bg-white/[.04] dark:placeholder:text-white/25" /></div>;
}
