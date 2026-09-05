"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Loader2, Save, SwatchBook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trackEvent } from "@/lib/client-telemetry";
import { fetchMe, type MeData } from "@/lib/use-me";
import { normalizeHexPalette } from "@/lib/hex-color";
import {
  brandPreviewSurfaceKey,
  clearPendingBrandPreviewOperation,
  markPendingBrandPreviewAutoResumeAttempt,
  pendingBrandPreviewCanAutoResume,
  readPendingBrandPreviewOperation,
  writePendingBrandPreviewOperation,
  type PendingBrandPreviewOperation,
  type PendingBrandPreviewSurface,
} from "@/lib/brand-preview-client-state";
import {
  createBlankBrandProfileSeed,
} from "@/lib/brand-profile-seed";
import { applyStylePackToPayload, clearStylePack } from "@/lib/style-pack-apply";
import { stylePack, type StylePackId } from "@/lib/style-pack-catalog";
import type { BrandProfilePayload } from "@/lib/brand-profile-library.server";
import { AdvancedSettings } from "./AdvancedSettings";
import { BrandBasicsForm } from "./BrandBasicsForm";
import { BrandLibraryOverview } from "./BrandLibraryOverview";
import { BrandStyleWorkspace } from "./BrandStyleWorkspace";
import { brandPreviewInputKey, createBrandSetupSeed, nextBrandName, type BrandSetupRequest, type BrandSetupResult } from "@/lib/brand-setup";
import { isBrandSetupResult, readBrandSetupReceipt, writeBrandSetupReceipt, clearBrandSetupReceipt, readBrandSetupDraft, writeBrandSetupDraft, clearBrandSetupDraft, readBrandSetupRequest, writeBrandSetupRequest, clearBrandSetupRequest, type BrandSetupDraft } from "@/lib/brand-setup-client-state";
import { BrandLookPreviewPanel } from "./BrandLookPreviewPanel";
import {
  brandPreviewGenerateRequest,
  brandPreviewQuoteBody,
  type BrandPreviewSource,
} from "./preview-request-body";
import {
  DefinitivePreviewRequestError,
  browserStorage,
  postPreviewWithRecovery,
  postRerollWithRecovery,
  recoverPreviewByRequestId,
  responseJson,
} from "./preview-recovery";
import type {
  BrandPayload,
  BrandProfile,
  LibraryResponse,
  Notice,
  PreviewBatch,
  ProjectVisualSeed,
  VisualProposal,
} from "./types";

/** `niche`, `audience`, `script.tone` and `visual.personality` are optional on
 * the surface; an empty value falls
 * back to the blank-seed default so a name-only brand still produces a
 * complete, publishable payload. Every payload consumer (draft-save, publish,
 * preview, preview-quote) reads the single `payload` memo built from this
 * function, so one fix here covers all of them. */
function withSeedFallbacks(draft: BrandPayload): BrandPayload {
  const blank = createBlankBrandProfileSeed();
  const niche = draft.niche.trim() ? draft.niche : blank.niche;
  const audience = draft.audience.trim() ? draft.audience : blank.audience;
  const tone = draft.script.tone.trim() ? draft.script.tone : blank.script.tone;
  const personality = draft.visual.personality.trim()
    ? draft.visual.personality
    : blank.visual.personality;
  const defaultTreatment = draft.visual.defaultTreatment?.trim()
    ? draft.visual.defaultTreatment
    : blank.visual.defaultTreatment;
  const treatmentPolicy = draft.visual.treatmentPolicy === "locked" ? "locked" : "adaptive";
  const lockedTreatmentPresetId = treatmentPolicy === "locked"
    ? (draft.visual.lockedTreatmentPresetId ?? blank.visual.lockedTreatmentPresetId)
    : null;
  if (
    niche === draft.niche
    && audience === draft.audience
    && tone === draft.script.tone
    && personality === draft.visual.personality
    && defaultTreatment === draft.visual.defaultTreatment
    && treatmentPolicy === draft.visual.treatmentPolicy
    && lockedTreatmentPresetId === draft.visual.lockedTreatmentPresetId
  ) {
    return draft;
  }
  return {
    ...draft,
    niche,
    audience,
    script: { ...draft.script, tone },
    visual: {
      ...draft.visual,
      personality,
      defaultTreatment,
      treatmentPolicy,
      lockedTreatmentPresetId,
    },
  };
}

/** `BrandPayload` (`BrandProfileSeed`) and `BrandProfilePayload` (the
 * persisted-read Zod-inferred type `applyStylePackToPayload`/`clearStylePack`
 * are written against) describe the same Brand Profile document — they only
 * diverge on three fields that `createBlankBrandProfileSeed()` always sets
 * concretely but the client type leaves optional (`languageMode`) or unset
 * (the two retired scene inputs, kept only so a pinned revision round-trips).
 * These two converters are the one place that gap is bridged, so the Style
 * Pack apply/clear functions stay pure and shared with the server. */
function toStylePackPayload(payload: BrandPayload): BrandProfilePayload {
  return {
    ...payload,
    visual: {
      ...payload.visual,
      languageMode: payload.visual.languageMode ?? "none",
      peopleAndSetting: payload.visual.peopleAndSetting ?? "",
      memorableCues: payload.visual.memorableCues ?? [],
    },
  };
}

function fromStylePackPayload(payload: BrandProfilePayload): BrandPayload {
  return {
    ...payload,
    visual: { ...payload.visual, languageMode: payload.visual.languageMode ?? "none" },
  };
}

export function BrandLibraryClient() {
  const router = useRouter();
  const [editorOpen, setEditorOpen] = useState(false);
  const [returnProjectId, setReturnProjectId] = useState<string | null>(null);
  const [cleanDraftJson, setCleanDraftJson] = useState("");
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<BrandSetupDraft | null>(null);
  const [localSavedJson, setLocalSavedJson] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [completedSetup, setCompletedSetup] = useState<BrandSetupResult | null>(null);
  const [pendingSetup, setPendingSetup] = useState<BrandSetupRequest | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const allowNavigation = useRef(false);
  const setupRunning = useRef(false);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrandPayload>(() => createBlankBrandProfileSeed());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [proposal, setProposal] = useState<VisualProposal | null>(null);
  const [preview, setPreview] = useState<PreviewBatch | null>(null);
  const [availabilityChoice, setAvailabilityChoice] = useState<string[]>([]);
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null);
  const [sourcePreflightId, setSourcePreflightId] = useState<string | null>(null);
  const [sourceVideoJobId, setSourceVideoJobId] = useState<string | null>(null);
  const [previewGenerationCount, setPreviewGenerationCount] = useState<number | null>(null);
  const [pendingRecoveryOperation, setPendingRecoveryOperation] = useState<PendingBrandPreviewOperation | null>(null);
  const resumedOperationForUserRef = useRef<string | null>(null);
  const measuredEntry = useRef(false);
  useEffect(() => {
    if (!library || loading || measuredEntry.current) return;
    measuredEntry.current = true;
    trackEvent("brand_setup_started", { path: "/brands", properties: { returning: library.profiles.length > 0, cohort: library.cohort ?? null } });
  }, [library, loading]);

  const activeProfile = useMemo(
    () => library?.profiles.find((profile) => profile.id === activeId) ?? null,
    [activeId, library],
  );
  const allowance = me?.starterAiImageAllowance;
  const payload = useMemo(() => withSeedFallbacks({ ...draft, name: draft.name.trim() || nextBrandName(library?.profiles.filter((p) => p.id !== activeId).map((p) => p.name) ?? []) }), [draft, library, activeId]);
  const localSaved = localSavedJson === JSON.stringify(draft);
  const dirty = editorOpen && JSON.stringify(draft) !== cleanDraftJson;

  function clearLocalDraft() {
    const storage = browserStorage();
    if (storage && me?.id) clearBrandSetupDraft(storage, me.id, activeId, sourceProjectId);
    setCleanDraftJson(JSON.stringify(draft));
    setRecoverableDraft(null);
  }

  function navigateFromDraft(action: () => void) {
    if (pendingSetup || busy) return;
    if (dirty) setPendingNavigation(() => action);
    else action();
  }

  function keepDraftAndContinue() {
    const storage = browserStorage();
    if (!storage || !me?.id || !writeBrandSetupDraft(storage, { userId: me.id, profileId: activeId, projectId: sourceProjectId, expectedRevision, payload: draft, savedAt: Date.now() })) {
      setNotice({ tone: "error", text: "เก็บร่างในเครื่องไม่สำเร็จ กรุณาบันทึกก่อนออกจากหน้านี้" });
      return;
    }
    setPendingNavigation(null);
    pendingNavigation?.();
  }

  useEffect(() => {
    if (loading || !me?.id || !dirty || recoverableDraft || pendingSetup) return;
    const timer = window.setTimeout(() => {
      const storage = browserStorage();
      setLocalSavedJson(storage && writeBrandSetupDraft(storage, { userId: me.id!, profileId: activeId, projectId: sourceProjectId, expectedRevision, payload: draft, savedAt: Date.now() }) ? JSON.stringify(draft) : "");
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loading, me?.id, dirty, draft, activeId, sourceProjectId, expectedRevision, recoverableDraft, pendingSetup]);

  useEffect(() => {
    if (!dirty && !pendingSetup) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNavigation.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onLink = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || allowNavigation.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || link.getAttribute("target") === "_blank" || !link.getAttribute("href")?.startsWith("/")) return;
      event.preventDefault(); event.stopPropagation();
      if (!pendingSetup) {
        const href = link.getAttribute("href");
        if (href?.startsWith("/")) setPendingNavigation(() => () => { allowNavigation.current = true; router.push(href); });
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onLink, true); };
  }, [dirty, pendingSetup, router]);

  async function submitSetup(request: BrandSetupRequest) {
    if (!me?.id || setupRunning.current) return;
    const operation = pendingSetup ?? request;
    const storage = browserStorage();
    if (!storage || !writeBrandSetupRequest(storage, me.id, operation)) {
      setNotice({ tone: "error", text: "บันทึกคำขอในเบราว์เซอร์ไม่ได้ กรุณาเปิดการจัดเก็บข้อมูลก่อนลองอีกครั้ง เพื่อให้ติดตามผลได้หากการเชื่อมต่อขาด" });
      return;
    }
    setupRunning.current = true;
    setPendingSetup(operation);
    setBusy("setup"); setNotice(null);
    try {
      const response = await fetch("/api/brand-library/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation), signal: AbortSignal.timeout(45_000) });
      if (!response.ok) {
        if ([400, 401, 403, 404, 409, 422].includes(response.status)) { clearBrandSetupRequest(storage, me.id); setPendingSetup(null); }
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || "ยังยืนยันผลบันทึกไม่ได้ กดติดตามคำขอเดิมได้โดยไม่สร้างซ้ำ");
      }
      const result: unknown = await response.json();
      if (!isBrandSetupResult(result) || (operation.action !== "save" && !result.projectId)) throw new Error("ยังยืนยันข้อมูลคลิปไม่ได้ กรุณาติดตามคำขอเดิม");
      if (!writeBrandSetupReceipt(storage, me.id, result)) throw new Error("บันทึกสำเร็จแล้ว แต่เก็บทางไปต่อไม่ได้ กรุณาติดตามคำขอเดิม");
      setCompletedSetup(result);
      clearBrandSetupRequest(storage, me.id); setPendingSetup(null);
      clearLocalDraft();
      trackEvent("brand_setup_completed", { properties: { profileId: result.profileId, revisionId: result.revisionId, projectId: result.projectId } });
      if (result.projectId) {
        allowNavigation.current = true;
        router.push(`/video-editor?projectId=${encodeURIComponent(result.projectId)}`);
      } else {
        try { await load(result.profileId); }
        catch { setNotice({ tone: "error", text: "บันทึกแบรนด์แล้ว แต่โหลดคลังไม่สำเร็จ กรุณาลองโหลดคลังอีกครั้ง" }); return; }
        setEditorOpen(false);
        clearBrandSetupReceipt(storage, me.id); setCompletedSetup(null);
        setNotice({ tone: "ok", text: "บันทึกแบรนด์แล้ว เลือกสร้างคลิปได้เลย" });
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ ร่างของคุณยังอยู่" });
    } finally { setupRunning.current = false; setBusy(null); }
  }

  function useSavedBrand(profile: BrandProfile) {
    const revision = profile.revisions.find((item) => item.version === profile.activeRevisionNumber);
    if (!revision) return;
    void submitSetup({ requestId: crypto.randomUUID(), action: "use-brand", profileId: profile.id, revisionId: revision.id });
  }
  const previewSource = useMemo<BrandPreviewSource>(() => ({
    profileId: activeId,
    projectId: sourceProjectId,
    preflightId: sourcePreflightId,
  }), [activeId, sourceProjectId, sourcePreflightId]);
  const previewQuoteInput = useMemo(
    () => JSON.stringify(brandPreviewQuoteBody(previewSource, payload)),
    [payload, previewSource],
  );

  // ADR 0059: only an account the image gate admits can spend a preview, and
  // preview-quote is an image action behind that same gate. Quoting for a
  // rejected account would answer 403 on every debounced keystroke; the count
  // stays null and the button discloses the gate reason instead.
  const canQuotePreview = editorOpen && previewExpanded && library?.imageAccess.canUse === true;

  // Every look is quoted by the server with the lineage its generate call will
  // use. A saved profile promoted from a clip can reuse that clip's images, so
  // guessing three here overstated the cost and could block a free preview.
  useEffect(() => {
    if (!canQuotePreview) return;
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
        // An unusable answer falls back to the worst case, never to a cheaper
        // number than the creator could actually be charged.
        setPreviewGenerationCount(Number.isInteger(count) && count >= 0 && count <= 3 ? count : 3);
      }).catch((error) => {
        if ((error as Error).name !== "AbortError") setPreviewGenerationCount(3);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canQuotePreview, previewQuoteInput]);

  async function load(preferredId?: string) {
    const [libraryData, meData] = await Promise.all([
      fetch("/api/brand-library", { cache: "no-store" }).then(responseJson) as Promise<LibraryResponse>,
      fetchMe(true),
    ]);
    setLibrary(libraryData);
    setMe(meData);
    const storage = browserStorage();
    if (storage && meData?.id) {
      setPendingSetup(readBrandSetupRequest(storage, meData.id));
      setCompletedSetup(readBrandSetupReceipt(storage, meData.id));
    }
    setAvailabilityChoice((current) => libraryData.availabilitySelectionRequired
      ? current.filter((id) => libraryData.profiles.some((profile) => profile.id === id))
      : []);
    const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const requestedProjectId = params?.get("projectId")?.trim() || null;
    setReturnProjectId(params?.get("returnProjectId")?.trim() || null);
    const requestedPreflightId = params?.get("preflightId")?.trim() || null;
    const requestedVideoJobId = params?.get("videoJobId")?.trim() || null;
    let resolvedSourcePreflightId = requestedPreflightId;
    let resolvedSourceVisualContext: ProjectVisualSeed["context"] | null = null;
    if (!preferredId && params?.get("new") === "1") {
      let seeded = createBrandSetupSeed(libraryData.defaults, libraryData.profiles.map((item) => item.name));
      if (requestedProjectId) {
        seeded = { ...seeded, visual: createBlankBrandProfileSeed().visual };
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
            // Carried through unedited so promoting a completed clip still
            // resolves to the exact look that clip rendered with. Neither field
            // is authored on this surface any more (ADR 0006).
            peopleAndSetting: typeof language?.peopleAndSetting === "string" ? language.peopleAndSetting : undefined,
            memorableCues: Array.isArray(language?.memorableCues) ? language.memorableCues : undefined,
            visualNotes: typeof language?.visualNotes === "string" ? language.visualNotes : seeded.visual.visualNotes,
          },
        };
        // A clip whose look came from a ready-made style keeps that link, and
        // keeps it WHOLE: re-applying the style is what fills in the narrative
        // policy, subtitle and tone the clip's own snapshot never carried, so
        // the draft is never a half-linked look (ADR 0058). The style is
        // re-applied only if it is still offered — a retired one promotes as
        // the custom look it already is.
        const seededPackId = libraryData.stylePacks
          .find((pack) => pack.id === exactContext?.stylePack?.id)?.id ?? null;
        if (seededPackId) {
          seeded = fromStylePackPayload(
            applyStylePackToPayload(toStylePackPayload(seeded), stylePack(seededPackId)),
          );
        }
      }
      setActiveId(null);
      setSourceProjectId(requestedProjectId);
      setSourcePreflightId(resolvedSourcePreflightId);
      setSourceVideoJobId(requestedVideoJobId);
      setDraft(seeded);
      setCleanDraftJson(JSON.stringify(seeded));
      setExpectedRevision(null);
      setEditorOpen(true);
      if (storage && meData?.id) setRecoverableDraft(readBrandSetupDraft(storage, meData.id, null, requestedProjectId));
      setAdvancedOpen(false);
      setProposal(null);
      setPreview(null);
      setLoading(false);
      return;
    }
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    const requestedNextId = preferredId ?? activeId;
    const nextProfile = libraryData.profiles.find((profile) => profile.id === requestedNextId)
      ?? libraryData.profiles[0]
      ?? null;
    if (nextProfile) {
      openProfile(nextProfile, true, meData?.id);
      setEditorOpen(Boolean(preferredId));
    }
    else {
      setActiveId(null);
      const seed = createBrandSetupSeed(libraryData.defaults, []);
      setDraft(seed);
      setCleanDraftJson(JSON.stringify(seed));
      setExpectedRevision(null);
      setEditorOpen(true);
      if (storage && meData?.id) setRecoverableDraft(readBrandSetupDraft(storage, meData.id, null, null));
    }
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

  useEffect(() => { load().catch((error) => { setNotice({ tone: "error", text: error.message }); setLoading(false); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- `load()` is async and only sets state after its awaited fetch resolves/rejects; this is the standard fetch-on-mount pattern, not a synchronous cascading render

  const resumePendingBrandPreviewOperation = useCallback(async (
    operation: PendingBrandPreviewOperation,
  ) => {
    const userId = me?.id;
    const storage = browserStorage();
    if (!userId || operation.userId !== userId || !storage) return;
    setPendingRecoveryOperation(operation);
    setBusy(operation.kind === "preview" ? "preview" : `reroll:${operation.itemId}`);
    try {
      const value = operation.kind === "preview"
        ? await recoverPreviewByRequestId(operation.requestId, setPreview)
        : await postRerollWithRecovery(operation.itemId, operation.batchId, operation.requestId, setPreview);
      setPreview(value.batch);
      setEditorOpen(true);
      setPreviewExpanded(true);
      setPreviewKey(operation.kind === "preview" ? brandPreviewInputKey(JSON.parse(operation.surface.payloadJson)) : null);
      clearPendingBrandPreviewOperation(storage, userId, operation.requestId);
      setPendingRecoveryOperation(null);
      await fetchMe(true).then(setMe);
    } catch (error) {
      if (error instanceof DefinitivePreviewRequestError) {
        clearPendingBrandPreviewOperation(storage, userId, operation.requestId);
        setPendingRecoveryOperation(null);
      }
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "กู้คืนคำขอทดลองภาพไม่สำเร็จ",
      });
    } finally {
      setBusy(null);
    }
  }, [me?.id]);

  useEffect(() => {
    const userId = me?.id;
    const storage = browserStorage();
    if (loading || !userId || !storage || resumedOperationForUserRef.current === userId) return;
    resumedOperationForUserRef.current = userId;
    const operation = readPendingBrandPreviewOperation(storage, userId);
    if (!operation) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrates React state from a browser-only external system (localStorage) to resume an interrupted preview/reroll after mount; the read cannot happen during render (guarded by loading/ref), so this is the effect's whole purpose
    setPendingRecoveryOperation(operation);
    // Recovery owns its original request snapshot. Do not replace a newer
    // brand draft with an old paid-preview snapshot on page load.
    if (!pendingBrandPreviewCanAutoResume(operation)) {
      setNotice({
        tone: "error",
        text: "พบคำขอทดลองภาพเดิมที่ยังยืนยันผลไม่ได้ ระบบจะไม่เริ่มซ้ำอัตโนมัติ กดติดตามคำขอเดิมเมื่อต้องการตรวจอีกครั้ง",
      });
      return;
    }
    // Persist before the network call: a crash or reload during an ambiguous
    // response must not auto-start the same paid request on every mount.
    const attempted = markPendingBrandPreviewAutoResumeAttempt(operation);
    writePendingBrandPreviewOperation(storage, attempted);
    setPendingRecoveryOperation(attempted);
    void resumePendingBrandPreviewOperation(attempted);
  }, [loading, me?.id, resumePendingBrandPreviewOperation]);

  function openProfile(profile: BrandProfile, force = false, userId = me?.id) {
    if (!force && dirty) { navigateFromDraft(() => openProfile(profile, true, userId)); return; }
    setEditorOpen(true);
    setExpectedRevision(profile.draft?.baseRevisionNumber ?? profile.activeRevisionNumber);
    setPreviewKey(null);
    const storage = browserStorage();
    setRecoverableDraft(storage && userId ? readBrandSetupDraft(storage, userId, profile.id, null) : null);
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setActiveId(profile.id);
    const stored = profile.draft?.payload ?? profile.revisions[0]?.payload;
    const base = createBlankBrandProfileSeed();
    const next = stored ?? {
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
    };
    setDraft(next);
    setCleanDraftJson(JSON.stringify(next));
    setAdvancedOpen(false);
    setProposal(null);
    setPreview(null);
    setNotice(null);
  }

  function startNew(force = false) {
    if (!library || !library.canCreate) return;
    if (!force && dirty) { navigateFromDraft(() => startNew(true)); return; }
    setEditorOpen(true);
    setExpectedRevision(null);
    const seed = createBrandSetupSeed(library.defaults, library.profiles.map((item) => item.name));
    setCleanDraftJson(JSON.stringify(seed));
    const storage = browserStorage();
    setRecoverableDraft(storage && me?.id ? readBrandSetupDraft(storage, me.id, null, null) : null);
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setActiveId(null);
    setDraft(seed);
    setAdvancedOpen(false);
    setProposal(null);
    setPreview(null);
    setNotice(null);
    trackEvent("brand_profile_create_started", { path: "/brands" });
  }

  /** ADR 0058: the shared unlink point every custom edit routes through — a
   * pack-owned field written directly (bypassing `updateVisual`/`applyProposal`)
   * is exactly how a half-pack would happen, so this stays the one place that
   * decides whether an edit needs to unlink first. */
  function clearStylePackIfLinked(payload: BrandPayload): BrandPayload {
    return payload.visual.stylePackId
      ? fromStylePackPayload(clearStylePack(toStylePackPayload(payload)))
      : payload;
  }

  /** ADR 0058: format, narrative-treatment policy/preset, palette and
   * personality are the axes a Style Pack resolves — editing any of them
   * while a pack is selected unlinks it first (`clearStylePackIfLinked`) so
   * the draft never shows a pack tag next to a look the pack no longer fully
   * describes. */
  function updateVisual<K extends keyof BrandPayload["visual"]>(key: K, value: BrandPayload["visual"][K]) {
    const definesBrandLanguage = key === "palette"
      || key === "personality"
      || key === "visualNotes";
    const unlinksPack = key === "primaryVisualFormatId"
      || key === "treatmentPolicy"
      || key === "lockedTreatmentPresetId"
      || key === "palette"
      || key === "personality";
    setDraft((current) => {
      const base = unlinksPack ? clearStylePackIfLinked(current) : current;
      return {
        ...base,
        visual: {
          ...base.visual,
          [key]: value,
          ...(definesBrandLanguage ? { languageMode: "defined" as const } : {}),
        },
      };
    });
  }

  function selectStylePack(id: StylePackId | null) {
    setDraft((current) => fromStylePackPayload(
      id
        ? applyStylePackToPayload(toStylePackPayload(current), stylePack(id))
        : clearStylePack(toStylePackPayload(current)),
    ));
    if (!id) setAdvancedOpen(true);
    trackEvent("brand_setup_style_changed", { properties: { packId: id } });
  }

  /** Applying the AI visual helper's proposal writes the same pack-owned axes
   * `updateVisual` guards (format, palette, personality) — a selected pack
   * must unlink here too, in the SAME `setDraft` as the proposal's fields, or
   * a creator could tap a pack then "นำคำแนะนำมาใส่ในร่าง" and be left with a
   * pack tag next to an AI-authored look the pack no longer describes. */
  function applyProposal(next: VisualProposal) {
    const palette = normalizeHexPalette(next.palette);
    if (!palette) {
      setNotice({ tone: "error", text: "AI ส่งสีมาไม่ใช่รูปแบบ HEX กรุณาขอคำแนะนำใหม่อีกครั้ง" });
      return;
    }
    setDraft((current) => {
      const base = clearStylePackIfLinked(current);
      return {
        ...base,
        visual: {
          ...base.visual,
          primaryVisualFormatId: next.primaryVisualFormatId,
          palette,
          personality: next.personality,
          visualNotes: next.visualNotes,
          languageMode: "defined",
        },
      };
    });
    setProposal(null);
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
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }),
      }));
      clearLocalDraft();
      await load(activeId);
      setNotice({ tone: "ok", text: "บันทึกร่างแล้ว งานเดิมและแนวภาพรุ่นที่ใช้อยู่ยังไม่เปลี่ยน" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }); }
    finally { setBusy(null); }
  }

  async function publishOrCreate(goToEditor = false) {
    if (!sourceProjectId || activeId) {
      await submitSetup({ requestId: crypto.randomUUID(), action: goToEditor ? "create-clip" : "save", ...(activeId ? { profileId: activeId, expectedRevision: expectedRevision ?? undefined } : {}), payload });
      return;
    }
    setBusy("publish"); setNotice(null);
    const originId = sourceProjectId;
    try {
      const created = await responseJson(await fetch("/api/brand-library/from-project-look", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, projectId: originId, preflightId: sourcePreflightId, videoJobId: sourceVideoJobId }),
      }));
      const result = { ...created, projectId: originId };
      if (isBrandSetupResult(result)) {
        const storage = browserStorage();
        if (storage && me?.id) writeBrandSetupReceipt(storage, me.id, result);
        setCompletedSetup(result);
      }
      clearLocalDraft();
      if (goToEditor) {
        allowNavigation.current = true;
        router.push(`/video-editor?projectId=${encodeURIComponent(originId)}`);
        return;
      }
      window.history.replaceState({}, "", "/brands");
      await load(created.profileId);
      setNotice({ tone: "ok", text: "บันทึกแบรนด์และใช้กับคลิปนี้แล้ว ภาพเดิมไม่ถูกสร้างซ้ำ" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ ร่างของคุณยังอยู่" }); }
    finally { setBusy(null); }
  }

  async function archiveProfile(profile: BrandProfile) {
    if (busy !== null) return;
    setBusy(`archive:${profile.id}`);
    setNotice(null);
    try {
      await responseJson(await fetch(`/api/brand-library/${encodeURIComponent(profile.id)}`, {
        method: "DELETE",
      }));
      const nextId = library?.profiles.find((item) => item.id !== profile.id)?.id;
      await load(nextId);
      setEditorOpen(false);
      setNotice({
        tone: "ok",
        text: `ลบ ${profile.name} ออกจากคลังแล้ว คลิปเดิมยังใช้แนวภาพรุ่นเดิมได้`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "ลบแนวภาพไม่สำเร็จ" });
    } finally {
      setBusy(null);
    }
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
    setBusy("preview"); setPreview(null); setPreviewKey(brandPreviewInputKey(payload)); setNotice(null);
    const userId = me?.id;
    const storage = browserStorage();
    const surface: PendingBrandPreviewSurface = {
      profileId: activeId,
      payloadJson: JSON.stringify(payload),
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
      if (activeId) {
        await responseJson(await fetch(`/api/brand-library/${activeId}/draft`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }),
        }));
      }
      // Built from the same lineage the quote priced, so the disclosed cost and
      // the charge can never come from different inputs.
      const { endpoint, body } = brandPreviewGenerateRequest(previewSource, payload);
      const value = await postPreviewWithRecovery(endpoint, body, requestId, setPreview);
      setPreview(value.batch);
      if (userId && storage) clearPendingBrandPreviewOperation(storage, userId, requestId);
      setPendingRecoveryOperation(null);
      await fetchMe(true).then(setMe);
      trackEvent("brand_look_preview_viewed", { path: "/brands", properties: { status: value.batch.status } });
    } catch (error) {
      if (error instanceof DefinitivePreviewRequestError && userId && storage) {
        clearPendingBrandPreviewOperation(storage, userId, requestId);
        setPendingRecoveryOperation(null);
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
      setPendingRecoveryOperation(null);
      await fetchMe(true).then(setMe);
    } catch (error) {
      if (error instanceof DefinitivePreviewRequestError && userId && storage) {
        clearPendingBrandPreviewOperation(storage, userId, requestId);
        setPendingRecoveryOperation(null);
      }
      setNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "ลองภาพใหม่ไม่สำเร็จ"} — ภาพเดิมยังอยู่`,
      });
    } finally { setBusy(null); }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-violet-500" />
      </div>
    );
  }
  if (!library) return <div className="space-y-4 p-8 text-sm"><p role="alert">{notice?.text ?? "โหลดคลังแบรนด์ไม่สำเร็จ"}</p><Button onClick={() => { setLoading(true); void load().catch(() => setLoading(false)); }}>ลองโหลดอีกครั้ง</Button></div>;

  const canPublish = payload.name.trim().length > 0;
  const frozen = activeProfile?.frozen === true;
  const locked = frozen || busy !== null || pendingSetup !== null;
  const disabled = locked || recoverableDraft !== null;

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-5 md:px-7 md:pt-8">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-500"><SwatchBook className="h-4 w-4" />แบรนด์ของฉัน</p>
            <h1 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl">{!editorOpen ? "เลือกแบรนด์ แล้วสร้างคลิปต่อ" : activeId ? "ปรับแบรนด์สำหรับคลิปใหม่" : "เลือกสไตล์ แล้วเริ่มคลิปแรก"}</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{editorOpen ? "เราเติมค่าเริ่มต้นให้แล้ว เลือกสไตล์แล้วไปต่อได้ เปลี่ยนรายละเอียดทีหลังได้" : "ภาพ เสียง และซับที่บันทึกไว้ พร้อมใช้กับคลิปถัดไป"}</p>
          </div>
          {editorOpen && library.profiles.length > 0 && <Button variant="ghost" disabled={busy !== null || !!pendingSetup} onClick={() => navigateFromDraft(() => setEditorOpen(false))} className="min-h-11"><ArrowLeft className="h-4 w-4" />กลับคลังแบรนด์</Button>}
        </header>

        {returnProjectId && <Link href={`/video-editor?projectId=${encodeURIComponent(returnProjectId)}`} className="mb-5 inline-block py-2 text-sm underline underline-offset-4">กลับคลิปเดิม · คลิปนี้ยังใช้เวอร์ชันเดิม</Link>}
        {library.availabilitySelectionRequired && library.cap !== null && <Card className="mb-6 p-5">
          <h2 className="font-semibold">เลือก {library.cap} แบรนด์สำหรับงานใหม่</h2><p className="mt-2 text-sm text-muted-foreground">แผนปัจจุบันรองรับน้อยกว่าจำนวนที่มี คลิปเดิมยังใช้เวอร์ชันเดิมได้</p>
          <div className="my-4 flex flex-wrap gap-2">{library.profiles.map((profile) => <Button key={profile.id} disabled={busy !== null} variant={availabilityChoice.includes(profile.id) ? "default" : "outline"} onClick={() => toggleAvailability(profile.id)}>{availabilityChoice.includes(profile.id) && <Check className="h-4 w-4" />}{profile.name}</Button>)}</div>
          <Button disabled={busy !== null || availabilityChoice.length !== library.cap} onClick={confirmAvailability}>ยืนยันแบรนด์ที่ใช้ต่อ</Button>
        </Card>}

        {pendingNavigation && <div role="alert" className="mb-5 rounded-lg border border-violet-500/40 bg-card p-4 text-sm"><p>ยังมีร่างที่ไม่ได้เผยแพร่ เก็บไว้ในเครื่องแล้วไปต่อได้</p><div className="mt-3 flex flex-wrap gap-2"><Button onClick={keepDraftAndContinue} className="min-h-11">เก็บร่างแล้วไปต่อ</Button><Button variant="outline" onClick={() => setPendingNavigation(null)} className="min-h-11">แก้ไขต่อ</Button></div></div>}
        {notice && <div role="status" className={`mb-5 rounded-lg border p-4 text-sm leading-6 ${notice.tone === "error" ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"}`}>{notice.text}</div>}
        {completedSetup && !pendingSetup && <div role="status" className="mb-5 rounded-lg border border-border p-4 text-sm"><p>บันทึกแบรนด์สำเร็จแล้ว{completedSetup.projectId ? " และมีคลิปที่สร้างไว้" : ""}</p><div className="mt-3 flex flex-wrap gap-3">{completedSetup.projectId ? <Link className="py-2 underline" href={`/video-editor?projectId=${encodeURIComponent(completedSetup.projectId)}`}>ไปคลิปที่สร้างไว้</Link> : <Button variant="outline" onClick={() => void load(completedSetup.profileId).catch(() => setNotice({ tone: "error", text: "โหลดคลังไม่สำเร็จ กรุณาลองอีกครั้ง" }))}>โหลดคลังอีกครั้ง</Button>}<Button variant="ghost" onClick={() => { const storage = browserStorage(); if (storage && me?.id) clearBrandSetupReceipt(storage, me.id); setCompletedSetup(null); }}>ปิดข้อความ</Button></div></div>}
        {pendingSetup && <div className="mb-5 rounded-lg border border-amber-500/40 p-4 text-sm"><p>มีคำขอบันทึก{pendingSetup.payload?.name ? ` “${pendingSetup.payload.name}”` : ""}ที่ยังไม่ได้ยืนยันผล ติดตามคำขอเดิมได้โดยไม่สร้างแบรนด์หรือคลิปซ้ำ</p><Button variant="outline" className="mt-3 min-h-11" disabled={busy !== null} onClick={() => void submitSetup(pendingSetup)}>{busy === "setup" && <Loader2 className="h-4 w-4 animate-spin" />}ติดตามคำขอบันทึกเดิม</Button></div>}
        {pendingRecoveryOperation && <Button variant="outline" className="mb-5 min-h-11" disabled={busy !== null} onClick={() => void resumePendingBrandPreviewOperation(pendingRecoveryOperation)}>ติดตามคำขอทดลองภาพเดิม</Button>}

        {!editorOpen ? <BrandLibraryOverview library={library} busy={busy !== null || !!pendingSetup} onNew={() => startNew()} onOpen={openProfile} onUse={useSavedBrand} onArchive={archiveProfile} /> : <div className="space-y-6">
          {recoverableDraft && <div className="rounded-lg border border-amber-500/40 p-4 text-sm"><p>พบร่างที่ยังไม่ได้เผยแพร่จากอุปกรณ์นี้</p><div className="mt-3 flex flex-wrap gap-2"><Button disabled={locked} variant="outline" onClick={() => { setDraft(recoverableDraft.payload); setExpectedRevision(recoverableDraft.expectedRevision); setRecoverableDraft(null); }}>กู้คืนร่าง</Button><Button disabled={locked} variant="ghost" onClick={() => { clearLocalDraft(); }}>ใช้ข้อมูลที่บันทึกไว้</Button></div></div>}
          {sourceProjectId && <div className="rounded-lg border border-border p-4 text-sm">กำลังบันทึกสไตล์จากคลิปนี้ ภาพเดิมจะไม่ถูกสร้างซ้ำ <Link href={`/video-editor?projectId=${encodeURIComponent(sourceProjectId)}`} className="ml-2 underline underline-offset-4">กลับคลิปต้นทาง</Link></div>}
          {frozen && <p className="text-sm text-muted-foreground">แบรนด์นี้เป็นแบบอ่านอย่างเดียวตามแผนปัจจุบัน</p>}
          <BrandStyleWorkspace draft={payload} library={library} disabled={disabled} onSelect={selectStylePack} onCustomize={() => setAdvancedOpen(true)} />
          <details className="border-t border-border pt-3"><summary className="cursor-pointer py-3 text-sm font-semibold">ชื่อแบรนด์ · {payload.name}</summary><div className="pb-4"><BrandBasicsForm name={draft.name} onNameChange={(value) => setDraft((current) => ({ ...current, name: value }))} disabled={disabled} /><p className="mt-2 text-xs text-muted-foreground">ไม่ต้องเปลี่ยนชื่อก็เริ่มสร้างคลิปได้</p></div></details>
          <AdvancedSettings open={advancedOpen} onOpenChange={setAdvancedOpen} draft={draft} setDraft={setDraft} updateVisual={updateVisual} library={library} busy={busy} disabled={disabled} proposal={proposal} onAskHelper={askVisualHelper} onApplyProposal={applyProposal} onUploadBrandMark={(file) => void uploadBrandMark(file)} />
          <details open={previewExpanded} onToggle={(event) => setPreviewExpanded(event.currentTarget.open)} className="border-t border-border pt-3"><summary className="cursor-pointer py-3 text-sm font-semibold">{sourceProjectId ? "ทดลองภาพกับคลิปนี้" : "ทดสอบสไตล์กับ 3 แบบฉาก"} · ไม่จำเป็นต้องทดลองก่อนบันทึก</summary>
            <p className="mb-3 text-xs leading-5 text-muted-foreground">{sourceProjectId ? "ใช้บริบทจากคลิปที่เลือก ตรวจสิทธิ์และราคาก่อนสร้างภาพ" : "ใช้ฉากทดสอบมาตรฐาน: ภาพกว้าง มือกับวัตถุ และภาพคน ไม่ใช่บทของคุณ หากต้องการทดลองกับเรื่องของคุณ ให้สร้างคลิปก่อน"}</p>
            <BrandLookPreviewPanel preview={preview} stale={!!preview && previewKey !== brandPreviewInputKey(payload)} previewGenerationCount={previewGenerationCount} allowance={allowance} imageAccess={library.imageAccess} canPublish={canPublish} busy={busy} disabled={disabled} onPreview={previewLook} onReroll={rerollPreviewItem} />
          </details>
          <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-4 border-t border-border bg-background px-4 py-4 lg:mx-0 lg:px-0">
            <div><p className="break-words text-sm font-semibold">{payload.name}</p><p className="mt-1 text-xs text-muted-foreground">ตั้งค่าแบรนด์ไม่ใช้เครดิต · {dirty ? localSaved ? "เก็บร่างในเครื่องแล้ว ยังไม่เผยแพร่" : "ยังไม่บันทึก" : "พร้อมใช้งาน"}</p></div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {activeId && <Button variant="ghost" disabled={disabled} onClick={saveDraftOnly} className="min-h-11"><Save className="h-4 w-4" />เก็บร่าง</Button>}
              {!sourceProjectId && <Button variant="outline" disabled={disabled || !canPublish} onClick={() => void publishOrCreate(false)} className="min-h-11">{activeId ? "บันทึกสำหรับคลิปใหม่" : "บันทึกไว้ก่อน"}</Button>}
              <Button disabled={disabled || !canPublish} onClick={() => void publishOrCreate(true)} className="min-h-11 flex-1 whitespace-normal bg-violet-600 text-white hover:bg-violet-600/90 sm:flex-initial">{busy === "setup" || busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{sourceProjectId ? "บันทึกและใช้กับคลิปนี้" : "ใช้แบรนด์นี้สร้างคลิป"}</Button>
            </div>
          </div>
          {!sourceProjectId && <Link href="/video-editor?empty=1" className="inline-block py-3 text-sm text-muted-foreground underline underline-offset-4">ไปสร้างคลิปก่อน โดยยังไม่ใช้แบรนด์</Link>}
        </div>}
      </div>
    </div>
  );
}
