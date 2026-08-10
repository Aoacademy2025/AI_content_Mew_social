"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Upload,
  WandSparkles,
} from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import { fetchMe, type MeData } from "@/lib/use-me";
import {
  brandPreviewSurfaceKey,
  clearPendingBrandPreviewOperation,
  readPendingBrandPreviewOperation,
  writePendingBrandPreviewOperation,
  type PendingBrandPreviewOperation,
  type PendingBrandPreviewSurface,
} from "@/lib/brand-preview-client-state";
import {
  createBlankBrandProfileSeed,
  createBrandProfileSeedFromCurrentDefaults,
  type BrandProfileSeed as BrandPayload,
  type CurrentBrandDefaults as BrandDefaults,
} from "@/lib/brand-profile-seed";

type VisualFormatId = "cinematic-realism" | "stick-figure-story" | "dramatic-comic" | "clear-infographic" | "retro-story";
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
type SubtitlePresetOption = {
  id: string;
  name: string;
  config: Record<string, string | number | boolean | null>;
};
type LibraryResponse = {
  profiles: BrandProfile[];
  cap: number | null;
  canCreate: boolean;
  creationRequiresResult: boolean;
  availabilitySelectionRequired: boolean;
  canRestoreAll: boolean;
  visualFormats: VisualFormat[];
  subtitlePresets: SubtitlePresetOption[];
  brandAssets: Array<{ id: string; name: string }>;
  defaults: BrandDefaults;
};
type PreviewItem = { id: string; phase: string; status: string; outputUrl: string | null; sourceType: string; errorCode: string | null };
type PreviewBatch = { id: string; requestId: string; status: string; items: PreviewItem[] };
type ProjectVisualSeed = {
  preflightId?: string | null;
  contentDomain?: string | null;
  context?: {
    visualFormatId?: VisualFormatId;
    treatment?: string;
    brandVisualLanguage?: Partial<BrandPayload["visual"]> | null;
  };
};

async function responseJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || "ดำเนินการไม่สำเร็จ");
  return value;
}

const TERMINAL_PREVIEW_STATUSES = new Set(["completed", "partial", "failed"]);

class DefinitivePreviewRequestError extends Error {}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

async function previewRequestError(response: Response): Promise<never> {
  const value = await response.json().catch(() => ({}));
  throw new DefinitivePreviewRequestError(value.message || value.error || "ดำเนินการไม่สำเร็จ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function recoverPreviewByRequestId(
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch }> {
  const discoveryDeadline = Date.now() + 30_000;
  let batch: PreviewBatch | null = null;
  while (!batch && Date.now() < discoveryDeadline) {
    const response = await fetch(
      `/api/brand-library/preview-batches?requestId=${encodeURIComponent(requestId)}`,
      { cache: "no-store" },
    );
    if (response.ok) batch = (await responseJson(response)).batch as PreviewBatch;
    else if (response.status !== 404) await responseJson(response);
    if (!batch) await delay(750);
  }
  if (!batch) throw new Error("เริ่มงานทดลองภาพไม่สำเร็จ กรุณาลองอีกครั้ง");
  onProgress(batch);

  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    const resumeController = new AbortController();
    const resumeTimeout = window.setTimeout(() => resumeController.abort(), 12_000);
    try {
      const response = await fetch("/api/brand-library/preview-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
        signal: resumeController.signal,
      });
      if (response.ok) {
        batch = (await responseJson(response)).batch as PreviewBatch;
        onProgress(batch);
      } else if (response.status !== 404 && response.status < 500) {
        await responseJson(response);
      }
    } catch (error) {
      if (!(resumeController.signal.aborted || error instanceof TypeError)) throw error;
    } finally {
      window.clearTimeout(resumeTimeout);
    }
  }

  const completionDeadline = Date.now() + 15 * 60_000;
  while (!TERMINAL_PREVIEW_STATUSES.has(batch.status) && Date.now() < completionDeadline) {
    await delay(2_000);
    const response = await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batch.id)}`,
      { cache: "no-store" },
    );
    batch = (await responseJson(response)).batch as PreviewBatch;
    onProgress(batch);
  }
  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    throw new Error("งานทดลองภาพยังดำเนินอยู่ สามารถกลับมาดูผลจากคำขอเดิมได้โดยไม่หักสิทธิ์ซ้ำ");
  }
  return { batch };
}

async function postPreviewWithRecovery(
  endpoint: string,
  body: Record<string, unknown>,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, requestId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status >= 500) {
        return recoverPreviewByRequestId(requestId, onProgress);
      }
      return await previewRequestError(response);
    }
    const value = await responseJson(response) as { batch: PreviewBatch };
    if (TERMINAL_PREVIEW_STATUSES.has(value.batch.status)) return value;
    onProgress(value.batch);
  } catch (error) {
    if (!(controller.signal.aborted || error instanceof TypeError)) throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  return recoverPreviewByRequestId(requestId, onProgress);
}

async function recoverRerollByRequestId(
  itemId: string,
  batchId: string,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch; item: PreviewItem }> {
  const discoveryDeadline = Date.now() + 30_000;
  let item: PreviewItem | null = null;
  while (!item && Date.now() < discoveryDeadline) {
    const response = await fetch(
      `/api/brand-library/preview-items/${encodeURIComponent(itemId)}/reroll?requestId=${encodeURIComponent(requestId)}`,
      { cache: "no-store" },
    );
    if (response.ok) item = (await responseJson(response)).item as PreviewItem;
    else if (response.status !== 404) await responseJson(response);
    if (!item) await delay(750);
  }
  if (!item) throw new Error("คำขอลองภาพใหม่ยังยืนยันผลไม่ได้ ระบบจะใช้ request เดิมเมื่อกลับมาหน้านี้");

  const completionDeadline = Date.now() + 15 * 60_000;
  let batch = (await responseJson(await fetch(
    `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
    { cache: "no-store" },
  ))).batch as PreviewBatch;
  onProgress(batch);
  while (!TERMINAL_PREVIEW_STATUSES.has(batch.status) && Date.now() < completionDeadline) {
    await delay(2_000);
    batch = (await responseJson(await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
      { cache: "no-store" },
    ))).batch as PreviewBatch;
    onProgress(batch);
  }
  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    throw new Error("งานลองภาพใหม่ยังดำเนินอยู่ ระบบจะกลับมาติดตาม request เดิมโดยไม่หักซ้ำ");
  }
  return { batch, item: batch.items.find((candidate) => candidate.id === itemId) ?? item };
}

async function postRerollWithRecovery(
  itemId: string,
  batchId: string,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch; item: PreviewItem }> {
  const endpoint = `/api/brand-library/preview-items/${encodeURIComponent(itemId)}/reroll`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status >= 500) return recoverRerollByRequestId(itemId, batchId, requestId, onProgress);
      return await previewRequestError(response);
    }
    const value = await responseJson(response) as { item: PreviewItem };
    const batch = (await responseJson(await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
      { cache: "no-store" },
    ))).batch as PreviewBatch;
    onProgress(batch);
    if (TERMINAL_PREVIEW_STATUSES.has(batch.status)) return { batch, item: value.item };
  } catch (error) {
    if (!(controller.signal.aborted || error instanceof TypeError)) throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  return recoverRerollByRequestId(itemId, batchId, requestId, onProgress);
}

export default function BrandLibraryPage() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrandPayload>(() => createBlankBrandProfileSeed());
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [proposal, setProposal] = useState<(BrandPayload["visual"] & { rationale?: string }) | null>(null);
  const [preview, setPreview] = useState<PreviewBatch | null>(null);
  const [availabilityChoice, setAvailabilityChoice] = useState<string[]>([]);
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);
  const [sourcePreflightId, setSourcePreflightId] = useState<string | null>(null);
  const [sourceVideoJobId, setSourceVideoJobId] = useState<string | null>(null);
  const [sourceVisualContext, setSourceVisualContext] = useState<ProjectVisualSeed["context"] | null>(null);
  const [previewGenerationCount, setPreviewGenerationCount] = useState<number | null>(null);
  const resumedOperationForUserRef = useRef<string | null>(null);

  const activeProfile = useMemo(
    () => library?.profiles.find((profile) => profile.id === activeId) ?? null,
    [activeId, library],
  );
  const allowance = me?.starterAiImageAllowance;
  const previewQuoteInput = useMemo(() => JSON.stringify({
    payload: draft,
    projectId: sourceProjectId,
    preflightId: sourcePreflightId,
  }), [draft, sourceProjectId, sourcePreflightId]);

  useEffect(() => {
    if (step !== 2) return;
    if (!sourceProjectId) {
      setPreviewGenerationCount(3);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreviewGenerationCount(null);
      void fetch("/api/brand-library/preview-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: previewQuoteInput,
        signal: controller.signal,
      }).then(responseJson).then((value: { generationCount?: unknown }) => {
        const count = typeof value.generationCount === "number" ? value.generationCount : Number.NaN;
        setPreviewGenerationCount(Number.isInteger(count) && count >= 0 && count <= 3 ? count : null);
      }).catch((error) => {
        if ((error as Error).name !== "AbortError") setPreviewGenerationCount(null);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [previewQuoteInput, sourceProjectId, step]);

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
    const requestedPreflightId = params?.get("preflightId")?.trim() || null;
    const requestedVideoJobId = params?.get("videoJobId")?.trim() || null;
    let resolvedSourcePreflightId = requestedPreflightId;
    let resolvedSourceVisualContext: ProjectVisualSeed["context"] | null = null;
    if (!preferredId && params?.get("new") === "1") {
      let seeded = createBlankBrandProfileSeed();
      if (requestedProjectId) {
        if (requestedVideoJobId) {
          const sourceJob = await fetch(`/api/videos/jobs/${encodeURIComponent(requestedVideoJobId)}`, {
            cache: "no-store",
          }).then(responseJson) as {
            status?: string;
            projectId?: string | null;
            contentPreflightId?: string | null;
            projectVisualContext?: ProjectVisualSeed["context"] | null;
          };
          const jobPreflightId = sourceJob.contentPreflightId?.trim() || null;
          if (
            sourceJob.status !== "done"
            || sourceJob.projectId !== requestedProjectId
            || !jobPreflightId
            || !sourceJob.projectVisualContext
            || (requestedPreflightId && requestedPreflightId !== jobPreflightId)
          ) {
            throw new Error("คลิปที่เลือกไม่ตรงกับข้อมูลฉากชุดนี้");
          }
          resolvedSourcePreflightId = jobPreflightId;
          resolvedSourceVisualContext = sourceJob.projectVisualContext;
        }
        const visualSeed = await fetch(`/api/editor-projects/${encodeURIComponent(requestedProjectId)}/visual-context${resolvedSourcePreflightId ? `?preflightId=${encodeURIComponent(resolvedSourcePreflightId)}` : ""}`, { cache: "no-store" })
          .then(responseJson) as ProjectVisualSeed;
        const exactContext = requestedVideoJobId
          ? resolvedSourceVisualContext
          : visualSeed.context ?? null;
        resolvedSourceVisualContext = exactContext;
        const language = exactContext?.brandVisualLanguage;
        resolvedSourcePreflightId = visualSeed.preflightId?.trim() || resolvedSourcePreflightId;
        seeded = {
          ...seeded,
          niche: visualSeed.contentDomain?.trim() || seeded.niche,
          visual: {
            ...seeded.visual,
            primaryVisualFormatId: exactContext?.visualFormatId ?? seeded.visual.primaryVisualFormatId,
            defaultTreatment: exactContext?.treatment?.trim() || seeded.visual.defaultTreatment,
            languageMode: language ? "defined" : "none",
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
      setSourcePreflightId(resolvedSourcePreflightId);
      setSourceVideoJobId(requestedVideoJobId);
      setSourceVisualContext(resolvedSourceVisualContext);
      setDraft(seeded);
      setStep(1);
      setProposal(null);
      setPreview(null);
      setLoading(false);
      return;
    }
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setSourceVisualContext(null);
    const nextId = preferredId ?? activeId ?? libraryData.profiles[0]?.id ?? null;
    if (nextId) openProfile(libraryData.profiles.find((profile) => profile.id === nextId)!);
    else setDraft(createBlankBrandProfileSeed());
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
      setNotice({ tone: "ok", text: "บันทึกแบรนด์ที่ใช้กับงานใหม่แล้ว คลิปเดิมยังใช้แนวภาพรุ่นเดิมได้ครบ" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกแบรนด์ที่เลือกไม่สำเร็จ" });
    } finally { setBusy(null); }
  }

  useEffect(() => { load().catch((error) => { setNotice({ tone: "error", text: error.message }); setLoading(false); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const userId = me?.id;
    const storage = browserStorage();
    if (loading || !userId || !storage || resumedOperationForUserRef.current === userId) return;
    resumedOperationForUserRef.current = userId;
    const operation = readPendingBrandPreviewOperation(storage, userId);
    if (!operation) return;
    if (operation.kind === "preview") {
      try {
        const restoredDraft = JSON.parse(operation.surface.payloadJson) as BrandPayload;
        setActiveId(operation.surface.profileId);
        setDraft(restoredDraft);
        setSourceProjectId(operation.surface.projectId);
        setSourcePreflightId(operation.surface.preflightId);
        setSourceVideoJobId(operation.surface.videoJobId);
        setSourceVisualContext(null);
        setStep(2);
        setProposal(null);
        setPreview(null);
      } catch {
        clearPendingBrandPreviewOperation(storage, userId, operation.requestId);
        return;
      }
    }
    setBusy(operation.kind === "preview" ? "preview" : `reroll:${operation.itemId}`);
    const resume = operation.kind === "preview"
      ? recoverPreviewByRequestId(operation.requestId, setPreview)
      : postRerollWithRecovery(operation.itemId, operation.batchId, operation.requestId, setPreview);
    void resume.then((value) => {
      setPreview(value.batch);
      clearPendingBrandPreviewOperation(storage, userId, operation.requestId);
      return fetchMe(true).then(setMe);
    }).catch((error) => {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "กู้คืนคำขอทดลองภาพไม่สำเร็จ",
      });
    }).finally(() => setBusy(null));
  }, [loading, me?.id]);

  function openProfile(profile: BrandProfile) {
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setSourceVisualContext(null);
    setActiveId(profile.id);
    const stored = profile.draft?.payload ?? profile.revisions[0]?.payload;
    const base = createBlankBrandProfileSeed();
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
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setSourceVisualContext(null);
    setActiveId(null);
    setDraft(createBlankBrandProfileSeed());
    setStep(1);
    setProposal(null);
    setPreview(null);
    setNotice(null);
    trackEvent("brand_profile_create_started", { path: "/brands" });
  }

  function startFromCurrentDefaults() {
    if (!library) return;
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setSourceVisualContext(null);
    setActiveId(null);
    setDraft(createBrandProfileSeedFromCurrentDefaults(library.defaults));
    setStep(1);
    setProposal(null);
    setPreview(null);
    setNotice({
      tone: "ok",
      text: "เติมสไตล์การเขียน เสียง ซับ และลายน้ำที่ใช้อยู่แล้ว กรุณาตรวจและกำหนดแนวภาพก่อนบันทึก",
    });
    trackEvent("brand_profile_create_from_current_started", { path: "/brands" });
  }

  function updateVisual<K extends keyof BrandPayload["visual"]>(key: K, value: BrandPayload["visual"][K]) {
    const definesBrandLanguage = key === "palette"
      || key === "personality"
      || key === "peopleAndSetting"
      || key === "memorableCues"
      || key === "visualNotes";
    setDraft((current) => ({
      ...current,
      visual: {
        ...current.visual,
        [key]: value,
        ...(definesBrandLanguage ? { languageMode: "defined" as const } : {}),
      },
    }));
  }

  async function uploadBrandMark(file: File) {
    if (!library) return;
    setBusy("brand-mark");
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (sourceProjectId) form.set("projectId", sourceProjectId);
      const value = await responseJson(await fetch("/api/user/brand-assets", {
        method: "POST",
        body: form,
      })) as { asset?: { id?: unknown; displayName?: unknown } };
      const id = typeof value.asset?.id === "string" ? value.asset.id : "";
      const name = typeof value.asset?.displayName === "string" ? value.asset.displayName : file.name;
      if (!id) throw new Error("อัปโหลดโลโก้ไม่สำเร็จ");
      setLibrary((current) => current ? {
        ...current,
        brandAssets: [
          { id, name },
          ...current.brandAssets.filter((asset) => asset.id !== id),
        ],
      } : current);
      setDraft((current) => ({
        ...current,
        brandMark: { ...current.brandMark, assetId: id, enabled: true },
      }));
      setNotice({ tone: "ok", text: "อัปโหลดโลโก้แล้ว และเลือกเป็นลายน้ำเริ่มต้นให้ร่างนี้" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "อัปโหลดโลโก้ไม่สำเร็จ" });
    } finally {
      setBusy(null);
    }
  }

  async function saveDraftOnly() {
    if (!activeId) return;
    setBusy("save");
    try {
      await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
      }));
      await load(activeId);
      setNotice({ tone: "ok", text: "บันทึกร่างแล้ว งานเดิมและแนวภาพรุ่นที่ใช้อยู่ยังไม่เปลี่ยน" });
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
        setNotice({ tone: "ok", text: "สร้างแนวภาพรุ่นใหม่แล้ว คลิปเดิมยังใช้รุ่นเดิมจนกว่าคุณจะเลือกเปลี่ยน" });
      } else {
        const created = sourceProjectId
          ? await responseJson(await fetch("/api/brand-library/from-project-look", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              payload: draft,
              projectId: sourceProjectId,
              preflightId: sourcePreflightId,
              videoJobId: sourceVideoJobId,
            }),
          }))
          : await responseJson(await fetch("/api/brand-library", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ payload: draft }),
            }));
        if (sourceProjectId) {
          window.history.replaceState({}, "", "/brands");
        }
        await load(created.profileId);
        setNotice({
          tone: "ok",
          text: sourceProjectId
            ? "บันทึกแบรนด์และเลือกแนวภาพรุ่นนี้ให้คลิปแล้ว ภาพเดิมไม่ถูกสร้างซ้ำ"
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
    const userId = me?.id;
    const storage = browserStorage();
    const surface: PendingBrandPreviewSurface = {
      profileId: activeId,
      payloadJson: JSON.stringify(draft),
      projectId: sourceProjectId,
      preflightId: sourcePreflightId,
      videoJobId: sourceVideoJobId,
    };
    const priorOperation = userId && storage
      ? readPendingBrandPreviewOperation(storage, userId)
      : null;
    const requestId = priorOperation?.kind === "preview"
      && brandPreviewSurfaceKey(priorOperation.surface) === brandPreviewSurfaceKey(surface)
      ? priorOperation.requestId
      : crypto.randomUUID();
    if (userId && storage) {
      const operation: PendingBrandPreviewOperation = {
        version: 2,
        kind: "preview",
        userId,
        requestId,
        surface,
        createdAt: new Date().toISOString(),
      };
      writePendingBrandPreviewOperation(storage, operation);
    }
    try {
      let endpoint = "/api/brand-library/preview";
      let body: Record<string, unknown> = { payload: draft };
      if (activeId) {
        await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: draft }),
        }));
        endpoint = `/api/brand-library/${activeId}/preview`;
        body = { useDraft: true, ...(sourceProjectId ? { projectId: sourceProjectId, preflightId: sourcePreflightId } : {}) };
      } else if (sourceProjectId) {
        body = { payload: draft, projectId: sourceProjectId, preflightId: sourcePreflightId };
      }
      const value = await postPreviewWithRecovery(endpoint, body, requestId, setPreview);
      setPreview(value.batch);
      if (userId && storage) clearPendingBrandPreviewOperation(storage, userId, requestId);
      await fetchMe(true).then(setMe);
      trackEvent("brand_look_preview_viewed", { path: "/brands", properties: { status: value.batch.status } });
    } catch (error) {
      if (error instanceof DefinitivePreviewRequestError && userId && storage) {
        clearPendingBrandPreviewOperation(storage, userId, requestId);
      }
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "ทดลองภาพไม่สำเร็จ" });
    }
    finally { setBusy(null); }
  }

  async function rerollPreviewItem(itemId: string) {
    setBusy(`reroll:${itemId}`); setNotice(null);
    const batchId = preview?.id;
    const userId = me?.id;
    const storage = browserStorage();
    if (!batchId) { setBusy(null); return; }
    const priorOperation = userId && storage
      ? readPendingBrandPreviewOperation(storage, userId)
      : null;
    const requestId = priorOperation?.kind === "reroll" && priorOperation.itemId === itemId
      ? priorOperation.requestId
      : crypto.randomUUID();
    if (userId && storage) {
      writePendingBrandPreviewOperation(storage, {
        version: 1,
        kind: "reroll",
        userId,
        requestId,
        batchId,
        itemId,
        createdAt: new Date().toISOString(),
      });
    }
    try {
      const value = await postRerollWithRecovery(itemId, batchId, requestId, setPreview);
      setPreview(value.batch);
      if (userId && storage) clearPendingBrandPreviewOperation(storage, userId, requestId);
      await fetchMe(true).then(setMe);
    } catch (error) {
      if (error instanceof DefinitivePreviewRequestError && userId && storage) {
        clearPendingBrandPreviewOperation(storage, userId, requestId);
      }
      setNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "ลองภาพใหม่ไม่สำเร็จ"} — ภาพเดิมยังอยู่`,
      });
    } finally { setBusy(null); }
  }

  if (loading) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-sky-500" /></div>;
  if (!library) return <div className="p-8 text-sm text-red-500">โหลดคลังแบรนด์ไม่สำเร็จ</div>;

  const previewImagesToGenerate = previewGenerationCount ?? 0;
  const previewImagesToReuse = 3 - previewImagesToGenerate;
  const previewCost = previewImagesToGenerate === 0
    ? "นำภาพเดิมมาใช้ครบ โดยไม่หักสิทธิ์หรือเครดิต"
    : allowance?.eligible
      ? `ใช้สิทธิ์ทดลอง ${previewImagesToGenerate} ภาพ`
      : `${previewImagesToGenerate * 2} เครดิต (${previewImagesToGenerate} ภาพ × 2 เครดิต)`;
  const previewFundingInsufficient = allowance?.eligible === true
    && allowance.remainingImages < previewImagesToGenerate;
  const canPublish = draft.name.trim() && draft.niche.trim() && draft.audience.trim() && draft.script.tone.trim();

  return (
    <main className="relative flex-1 overflow-y-auto bg-[#eee9df] text-[#151515] dark:bg-[#121212] dark:text-[#f4efe5]">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.06]" style={{ backgroundImage: "linear-gradient(#151515 1px, transparent 1px), linear-gradient(90deg, #151515 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
      <div className="relative mx-auto max-w-[1440px] px-4 py-6 md:px-7 md:py-8">
        <header className="mb-7 grid gap-5 border-2 border-[#151515] bg-[#f8f4ec] p-5 shadow-[7px_7px_0_#151515] dark:border-[#f4efe5] dark:bg-[#1b1b1b] dark:shadow-[7px_7px_0_#38BDF8] md:grid-cols-[1fr_auto] md:p-7">
          <div className="max-w-3xl">
            <div className="mb-4 inline-flex items-center gap-2 bg-[#151515] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.22em] text-[#f8f4ec] dark:bg-[#38BDF8] dark:text-[#151515]">
              <SwatchBook className="h-3.5 w-3.5" /> แบรนด์ของฉัน
            </div>
            <h1 className="text-3xl font-black leading-[1.05] tracking-[-.035em] md:text-5xl" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>แนวภาพที่คนเห็นแล้ว<br /><span className="text-sky-500">จำได้ว่าเป็นคุณ</span></h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-black/60 dark:text-white/60">เก็บสคริปต์ เสียง ซับ ลายน้ำ และภาษาภาพไว้ในโปรไฟล์แบรนด์เดียว แต่ละคลิปยังปรับแนวภาพของตัวเองได้เสมอ</p>
          </div>
          <div className="flex min-w-[220px] flex-col justify-between border-l-0 border-black/15 pt-4 md:border-l md:pl-6 md:pt-0 dark:border-white/15">
            {allowance?.eligible ? <>
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-black/45 dark:text-white/45">สิทธิ์ทดลองสร้างภาพ</p><p className="mt-1 text-4xl font-black tabular-nums">{allowance.remainingImages}<span className="text-base font-semibold text-black/40 dark:text-white/40"> / {allowance.limitImages}</span></p></div>
              <p className="mt-3 text-xs leading-5 text-black/55 dark:text-white/55">คงเหลือในรอบนี้ · การวิเคราะห์และเลือกแนวภาพไม่ใช้สิทธิ์</p>
            </> : <>
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-black/45 dark:text-white/45">เครดิตสำหรับสร้างภาพ</p><p className="mt-2 text-lg font-black">ใช้ยอดเครดิตเดียวกับบัญชี</p></div>
              <p className="mt-3 text-xs text-black/55 dark:text-white/55">ภาพ AI ราคา 2 เครดิตต่อภาพ</p>
            </>}
          </div>
        </header>

        {library.availabilitySelectionRequired && library.cap !== null && <section className="relative mb-5 border-2 border-amber-500 bg-amber-100 p-4 text-amber-950 shadow-[5px_5px_0_#151515] dark:bg-amber-950 dark:text-amber-100">
          <p className="text-sm font-black">เลือก {library.cap} แบรนด์สำหรับงานใหม่</p>
          <p className="mt-1 text-xs leading-5 opacity-75">แผนปัจจุบันรองรับน้อยกว่าจำนวนที่มี ระบบไม่ลบข้อมูลใด และคลิปเดิมยังสร้างซ้ำด้วยแนวภาพรุ่นที่เลือกไว้ได้</p>
          <div className="mt-3 flex flex-wrap gap-2">{library.profiles.map((profile) => { const selected = availabilityChoice.includes(profile.id); return <button key={profile.id} type="button" onClick={() => toggleAvailability(profile.id)} className={`inline-flex min-h-9 items-center gap-2 border px-3 text-xs font-bold ${selected ? "border-[#151515] bg-[#151515] text-white dark:border-amber-200 dark:bg-amber-200 dark:text-[#151515]" : "border-amber-700/35 bg-white/50 dark:bg-black/20"}`}>{selected && <Check className="h-3.5 w-3.5" />}{profile.name}</button>; })}</div>
          <button type="button" onClick={confirmAvailability} disabled={busy !== null || availabilityChoice.length !== library.cap} className="mt-3 inline-flex min-h-10 items-center gap-2 bg-[#38BDF8] px-4 text-xs font-black text-[#151515] disabled:opacity-40">{busy === "availability" && <Loader2 className="h-4 w-4 animate-spin" />} ยืนยันแบรนด์ที่ใช้ต่อ</button>
        </section>}

        <div className="grid gap-5 lg:grid-cols-[270px_minmax(0,1fr)]">
          <aside className="h-fit border border-black/20 bg-white/65 p-3 dark:border-white/15 dark:bg-white/[.04] lg:sticky lg:top-5">
            <div className="flex items-center justify-between px-2 py-2"><p className="text-xs font-black uppercase tracking-[.16em]">คลังแบรนด์</p><span className="text-[11px] text-black/45 dark:text-white/45">{library.profiles.length}/{library.cap ?? "∞"}</span></div>
            {library.creationRequiresResult ? <Link href="/video-editor" className="mb-3 flex min-h-11 w-full items-center justify-center gap-2 border-2 border-[#151515] bg-[#38BDF8] px-3 text-center text-xs font-black text-[#151515] transition-transform hover:-translate-y-0.5 dark:border-[#f4efe5]"><WandSparkles className="h-4 w-4 shrink-0" /> สร้างคลิปแรก แล้วบันทึกแนวภาพจากผลงานจริง</Link> : <><button onClick={startNew} disabled={!library.canCreate} className="mb-2 flex min-h-11 w-full items-center justify-center gap-2 border-2 border-[#151515] bg-[#38BDF8] px-3 text-sm font-black text-[#151515] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#f4efe5]"><Plus className="h-4 w-4" /> สร้างแบรนด์ใหม่</button><button onClick={startFromCurrentDefaults} disabled={!library.canCreate} className="mb-3 flex min-h-11 w-full items-center justify-center gap-2 border border-black/30 bg-transparent px-3 text-xs font-black text-[#151515] transition-colors hover:border-sky-500 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/25 dark:text-[#f4efe5]"><WandSparkles className="h-4 w-4" /> สร้างแบรนด์จากค่าที่ใช้อยู่</button></>}
            <div className="space-y-1.5">
              {library.profiles.map((profile) => <button key={profile.id} onClick={() => openProfile(profile)} className={`w-full border px-3 py-3 text-left transition-colors ${activeId === profile.id ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-[#151515]" : "border-transparent hover:border-black/20 hover:bg-white/70 dark:hover:border-white/20 dark:hover:bg-white/[.05]"}`}>
                <div className="flex items-start justify-between gap-2"><span className="text-sm font-bold leading-5">{profile.name}</span>{profile.frozen && <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />}</div>
                <p className={`mt-1 truncate text-[11px] ${activeId === profile.id ? "opacity-70" : "text-black/45 dark:text-white/45"}`}>{profile.niche} · รุ่น {profile.activeRevisionNumber || "—"}</p>
              </button>)}
              {!library.profiles.length && <p className="px-2 py-6 text-center text-xs leading-5 text-black/45 dark:text-white/45">ยังไม่มีแบรนด์<br />เริ่มจากเลือกภาพที่ใช่ที่สุด</p>}
            </div>
          </aside>

          <section className="min-w-0 border border-black/20 bg-[#f8f4ec] dark:border-white/15 dark:bg-[#1a1a1a]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/15 px-4 py-4 dark:border-white/15 md:px-6">
              <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-sky-500">{activeProfile ? `แนวภาพรุ่น ${activeProfile.activeRevisionNumber}` : "สร้างโปรไฟล์แบรนด์"}</p><h2 className="mt-1 text-lg font-black">{activeProfile?.name || "ออกแบบแนวภาพใหม่"}</h2></div>
              <div className="flex items-center gap-2 text-xs font-bold"><span className={`flex h-6 w-6 items-center justify-center border ${step === 1 ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-black" : "border-black/20 dark:border-white/20"}`}>1</span><span className="h-px w-5 bg-black/20 dark:bg-white/20" /><span className={`flex h-6 w-6 items-center justify-center border ${step === 2 ? "border-[#151515] bg-[#151515] text-white dark:border-[#38BDF8] dark:bg-[#38BDF8] dark:text-black" : "border-black/20 dark:border-white/20"}`}>2</span></div>
            </div>

            {sourceProjectId && <div className="border-b border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs leading-5 md:px-6"><span className="font-black">เริ่มจากคลิปที่คุณเพิ่งสร้าง</span> — ระบบเติมแนวภาพและบริบทของเนื้อหาให้ตรวจแล้ว การบันทึกจะสร้างโปรไฟล์แบรนด์และเลือกแนวภาพรุ่นนี้ให้คลิปโดยตรง</div>}

            {activeProfile?.frozen ? <div className="m-5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm"><p className="font-bold">แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียว</p><p className="mt-1 text-black/60 dark:text-white/60">คลิปเดิมยังสร้างซ้ำด้วยแนวภาพรุ่นที่เลือกไว้ได้ อัปเกรดเพื่อแก้หรือใช้กับคลิปใหม่</p></div> : null}

            {step === 1 ? <div className="p-4 md:p-6">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.16em]">01 — เลือกภาษาภาพ</p><p className="mt-2 text-sm text-black/55 dark:text-white/55">ภาพทั้ง 5 ใช้ฉากทดสอบเดียวกัน และผ่านการตรวจคุณภาพครบแล้ว</p></div><span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" /> ตรวจแล้ว 21/21 ภาพ</span></div>
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
                    <Field label="อารมณ์สำรองเมื่อยังไม่มีเนื้อหาให้วิเคราะห์" value={draft.visual.defaultTreatment} onChange={(value) => updateVisual("defaultTreatment", value)} />
                    <div><Label>โน้ตทิศทางภาพ</Label><textarea value={draft.visual.visualNotes} onChange={(event) => updateVisual("visualNotes", event.target.value)} rows={4} className="mt-2 w-full border border-black/25 bg-white px-3 py-2.5 text-sm outline-none focus:border-sky-500 dark:border-white/20 dark:bg-white/[.04]" /></div>
                    <fieldset className="border border-black/15 bg-black/[.025] p-4 dark:border-white/15 dark:bg-white/[.03]"><legend className="px-1 text-xs font-black">เสียงเริ่มต้นของแบรนด์</legend><div className="grid gap-4 md:grid-cols-2"><label><Label>ผู้ให้บริการเสียง</Label><select value={draft.voice.provider} onChange={(event) => setDraft((current) => ({ ...current, voice: { provider: event.target.value, voiceId: null } }))} className="mt-2 min-h-11 w-full border border-black/25 bg-white px-3 text-sm dark:border-white/20 dark:bg-[#222]"><option value="elevenlabs">ElevenLabs</option><option value="gemini">Gemini</option><option value="omnivoice">Hero Voice</option></select></label><Field label={draft.voice.provider === "gemini" ? "ชื่อเสียง Gemini" : "Voice ID"} value={draft.voice.voiceId ?? ""} onChange={(value) => setDraft((current) => ({ ...current, voice: { ...current.voice, voiceId: value.trim() ? value : null } }))} placeholder="เว้นว่างเพื่อใช้ค่าเริ่มต้นบัญชี" /></div><p className="mt-2 text-[11px] text-black/45 dark:text-white/45">โปรเจกต์ใหม่รับค่านี้เป็นค่าเริ่มต้น และยังเลือกเสียงอื่นรายคลิปได้</p></fieldset>
                    <fieldset className="border border-black/15 bg-black/[.025] p-4 dark:border-white/15 dark:bg-white/[.03]"><legend className="px-1 text-xs font-black">ซับเริ่มต้น</legend><label><Label>รูปแบบซับ</Label><select value={draft.subtitle.presetId ?? ""} onChange={(event) => { const preset = library.subtitlePresets.find((item) => item.id === event.target.value); setDraft((current) => ({ ...current, subtitle: preset ? { presetId: preset.id, config: preset.config } : { presetId: null, config: {} } })); }} className="mt-2 min-h-11 w-full border border-black/25 bg-white px-3 text-sm dark:border-white/20 dark:bg-[#222]"><option value="">ใช้ค่าเริ่มต้นของคลิป</option>{library.subtitlePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><p className="mt-2 text-[11px] text-black/45 dark:text-white/45">เลือกได้ทุกแผน ระบบเก็บค่านี้ไว้กับแนวภาพแต่ละรุ่น จึงไม่เปลี่ยนตามการแก้รูปแบบภายหลัง</p></fieldset>
                    <fieldset className="border border-black/15 bg-black/[.025] p-4 dark:border-white/15 dark:bg-white/[.03]"><legend className="px-1 text-xs font-black">โลโก้ / ลายน้ำเริ่มต้น</legend><label className="flex min-h-10 items-center gap-2 text-sm font-bold"><input type="checkbox" checked={draft.brandMark.enabled} onChange={(event) => setDraft((current) => ({ ...current, brandMark: { ...current.brandMark, enabled: event.target.checked } }))} className="h-4 w-4 accent-sky-500" /> เปิดลายน้ำในโปรเจกต์ใหม่</label><label className="mt-3 inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 border border-dashed border-black/30 px-3 text-xs font-black hover:border-sky-500 dark:border-white/25"><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy !== null} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadBrandMark(file); }} className="hidden" />{busy === "brand-mark" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} อัปโหลดโลโก้ใหม่</label><p className="mt-2 text-[11px] text-black/45 dark:text-white/45">JPG, PNG หรือ WebP ไม่เกิน 5 MB · ทุกแผนที่ใช้ระบบแนวภาพแก้ลายน้ำของแบรนด์ได้</p><div className="mt-3 grid gap-4 md:grid-cols-2"><label><Label>ไฟล์โลโก้</Label><select value={draft.brandMark.assetId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, brandMark: { ...current.brandMark, assetId: event.target.value || null } }))} className="mt-2 min-h-11 w-full border border-black/25 bg-white px-3 text-sm dark:border-white/20 dark:bg-[#222]"><option value="">ยังไม่เลือกไฟล์</option>{library.brandAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label><Label>ตำแหน่ง</Label><select value={draft.brandMark.position} onChange={(event) => setDraft((current) => ({ ...current, brandMark: { ...current.brandMark, position: event.target.value } }))} className="mt-2 min-h-11 w-full border border-black/25 bg-white px-3 text-sm dark:border-white/20 dark:bg-[#222]"><option value="top-left">บนซ้าย</option><option value="top-right">บนขวา</option><option value="bottom-left">ล่างซ้าย</option><option value="bottom-right">ล่างขวา</option></select></label></div><div className="mt-4 grid gap-4 md:grid-cols-2"><label><span className="flex justify-between text-[11px] font-black uppercase tracking-[.1em]"><span>ขนาด</span><span>{Math.round(draft.brandMark.sizePct)}%</span></span><input type="range" min="5" max="40" value={draft.brandMark.sizePct} onChange={(event) => setDraft((current) => ({ ...current, brandMark: { ...current.brandMark, sizePct: Number(event.target.value) } }))} className="mt-2 w-full accent-sky-500" /></label><label><span className="flex justify-between text-[11px] font-black uppercase tracking-[.1em]"><span>ความทึบ</span><span>{Math.round(draft.brandMark.opacity * 100)}%</span></span><input type="range" min="0" max="100" value={Math.round(draft.brandMark.opacity * 100)} onChange={(event) => setDraft((current) => ({ ...current, brandMark: { ...current.brandMark, opacity: Number(event.target.value) / 100 } }))} className="mt-2 w-full accent-sky-500" /></label></div></fieldset>
                  </div></details>
                </div>

                <aside className="space-y-4">
                  <div className="border-2 border-[#151515] bg-white p-4 dark:border-[#f4efe5] dark:bg-[#222]"><div className="flex items-center gap-2"><WandSparkles className="h-4 w-4 text-sky-500" /><p className="text-sm font-black">ผู้ช่วยออกแบบแนวภาพ</p></div><p className="mt-2 text-xs leading-5 text-black/55 dark:text-white/55">AI เสนอค่าให้ดูก่อนเท่านั้น ไม่สร้างภาพและไม่เปลี่ยนร่างจนกว่าคุณจะกดนำมาใช้</p><button onClick={askVisualHelper} disabled={busy !== null || !draft.niche || !draft.audience} className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 border border-black/25 text-xs font-black hover:border-sky-500 disabled:opacity-40 dark:border-white/20">{busy === "helper" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} ขอคำแนะนำ</button>
                    {proposal && <div className="mt-4 border-l-4 border-sky-400 bg-sky-400/10 p-3"><p className="text-xs font-black">AI แนะนำ: {library.visualFormats.find((format) => format.id === proposal.primaryVisualFormatId)?.label}</p><p className="mt-1 text-[11px] leading-5 text-black/55 dark:text-white/55">{proposal.rationale}</p><button onClick={() => { const { rationale: _rationale, ...visual } = proposal; setDraft((current) => ({ ...current, visual })); setProposal(null); }} className="mt-2 text-xs font-black text-sky-600 underline underline-offset-4 dark:text-sky-400">นำคำแนะนำมาใส่ในร่าง</button></div>}
                  </div>
                  <div className="border border-black/20 bg-[#151515] p-4 text-white dark:border-white/20"><div className="flex items-center gap-2"><Eye className="h-4 w-4 text-sky-400" /><p className="text-sm font-black">ทดลองฉากเปิด · ฉากอธิบาย · ฉากปิด</p></div><p className="mt-2 text-xs leading-5 text-white/60">{previewGenerationCount === null ? "กำลังตรวจภาพเดิมและคำนวณสิทธิ์ที่ต้องใช้…" : `${previewCost}${previewImagesToReuse > 0 ? ` · ใช้ภาพเดิม ${previewImagesToReuse} ภาพ` : ""}`}</p><button onClick={previewLook} disabled={busy !== null || !canPublish || previewGenerationCount === null || previewFundingInsufficient} className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 bg-[#38BDF8] px-3 text-xs font-black text-[#151515] disabled:opacity-40">{busy === "preview" || previewGenerationCount === null ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />} ทดลอง 3 ภาพ</button>{previewFundingInsufficient && <Link href="/pricing" className="mt-3 block text-center text-xs font-bold text-sky-300 underline underline-offset-4">สิทธิ์ไม่พอ — ดูแผนรายเดือน</Link>}</div>
                </aside>
              </div>

              {preview && <div className="mt-6 border-t-2 border-[#151515] pt-5 dark:border-[#f4efe5]"><div className="mb-3 flex items-center justify-between"><p className="text-sm font-black">ภาพทดลองแนวประจำแบรนด์</p><span className="text-[11px] font-bold tracking-[.08em] text-black/45 dark:text-white/45">{preview.status === "completed" ? "พร้อมแล้ว" : preview.status === "partial" ? "สำเร็จบางภาพ" : preview.status === "failed" ? "สร้างไม่สำเร็จ" : "กำลังสร้าง"}</span></div><div className="grid grid-cols-3 gap-2">{preview.items.map((item) => <figure key={item.id} className="relative aspect-[9/16] overflow-hidden bg-black/10 dark:bg-white/10">{item.outputUrl ? <img src={item.outputUrl} alt={`ภาพทดลอง ${item.phase}`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center px-2 text-center text-xs text-red-500">{item.errorCode || "สร้างไม่สำเร็จ"}</div>}<button type="button" onClick={() => rerollPreviewItem(item.id)} disabled={busy !== null} className="absolute right-2 top-2 inline-flex min-h-8 items-center gap-1 bg-white/90 px-2 text-[10px] font-black text-[#151515] shadow disabled:opacity-50">{busy === `reroll:${item.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} ลองภาพนี้ใหม่</button><figcaption className="absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1.5 text-[10px] font-bold tracking-[.08em] text-white">{item.phase === "hook" ? "ฉากเปิด" : item.phase === "explain" ? "ฉากอธิบาย" : "ฉากปิด"} · {item.sourceType === "reused" ? "ใช้ภาพเดิม" : "ภาพใหม่"}</figcaption></figure>)}</div><p className="mt-2 text-[10px] text-black/45 dark:text-white/45">ลองใหม่คิด 1 ภาพ ({allowance?.eligible ? "สิทธิ์ทดลอง 1 ภาพ" : "2 เครดิต"}) และหากล้มเหลวภาพเดิมจะไม่หาย</p></div>}

              {notice && <div role="status" className={`mt-5 border-l-4 p-3 text-sm ${notice.tone === "ok" ? "border-emerald-500 bg-emerald-500/10" : "border-red-500 bg-red-500/10"}`}>{notice.text}</div>}
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-black/15 pt-5 dark:border-white/15"><p className="max-w-xl text-[11px] leading-5 text-black/45 dark:text-white/45">การแก้ร่างหรือทดลองภาพยังไม่เปลี่ยนแนวภาพรุ่นที่โปรเจกต์ใช้อยู่ ภาพเดิมจะไม่ถูกสร้างใหม่อัตโนมัติ</p><div className="flex flex-wrap gap-2">{activeId && <button onClick={saveDraftOnly} disabled={busy !== null || !canPublish || activeProfile?.frozen} className="flex min-h-11 items-center gap-2 border border-black/30 px-4 text-sm font-black disabled:opacity-40 dark:border-white/25"><Save className="h-4 w-4" /> บันทึกร่าง</button>}<button onClick={publishOrCreate} disabled={busy !== null || !canPublish || activeProfile?.frozen} className="flex min-h-11 items-center gap-2 bg-[#151515] px-5 text-sm font-black text-white hover:bg-sky-500 hover:text-[#151515] disabled:opacity-40 dark:bg-[#f4efe5] dark:text-[#151515]">{busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{activeId ? "ใช้แนวภาพใหม่นี้" : "บันทึกเข้าคลังแบรนด์"}</button></div></div>
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
