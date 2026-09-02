"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Save, SwatchBook } from "lucide-react";
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
  createBrandProfileSeedFromCurrentDefaults,
} from "@/lib/brand-profile-seed";
import { AdvancedSettings } from "./AdvancedSettings";
import { BrandBasicsForm } from "./BrandBasicsForm";
import { BrandList } from "./BrandList";
import { BrandLookPreviewPanel } from "./BrandLookPreviewPanel";
import { VisualFormatPicker } from "./VisualFormatPicker";
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

export function BrandLibraryClient() {
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
  const [, setSourceVisualContext] = useState<ProjectVisualSeed["context"] | null>(null);
  const [previewGenerationCount, setPreviewGenerationCount] = useState<number | null>(null);
  const [pendingRecoveryOperation, setPendingRecoveryOperation] = useState<PendingBrandPreviewOperation | null>(null);
  const resumedOperationForUserRef = useRef<string | null>(null);

  const activeProfile = useMemo(
    () => library?.profiles.find((profile) => profile.id === activeId) ?? null,
    [activeId, library],
  );
  const allowance = me?.starterAiImageAllowance;
  const payload = useMemo(() => withSeedFallbacks(draft), [draft]);
  const previewSource = useMemo<BrandPreviewSource>(() => ({
    profileId: activeId,
    projectId: sourceProjectId,
    preflightId: sourcePreflightId,
  }), [activeId, sourceProjectId, sourcePreflightId]);
  const previewQuoteInput = useMemo(
    () => JSON.stringify(brandPreviewQuoteBody(previewSource, payload)),
    [payload, previewSource],
  );

  // Every look is quoted by the server with the lineage its generate call will
  // use. A saved profile promoted from a clip can reuse that clip's images, so
  // guessing three here overstated the cost and could block a free preview.
  useEffect(() => {
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
  }, [previewQuoteInput]);

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
            // Carried through unedited so promoting a completed clip still
            // resolves to the exact look that clip rendered with. Neither field
            // is authored on this surface any more (ADR 0006).
            peopleAndSetting: typeof language?.peopleAndSetting === "string" ? language.peopleAndSetting : undefined,
            memorableCues: Array.isArray(language?.memorableCues) ? language.memorableCues : undefined,
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
      setAdvancedOpen(false);
      setProposal(null);
      setPreview(null);
      setLoading(false);
      return;
    }
    setSourceProjectId(null);
    setSourcePreflightId(null);
    setSourceVideoJobId(null);
    setSourceVisualContext(null);
    const requestedNextId = preferredId ?? activeId;
    const nextProfile = libraryData.profiles.find((profile) => profile.id === requestedNextId)
      ?? libraryData.profiles[0]
      ?? null;
    if (nextProfile) openProfile(nextProfile);
    else {
      setActiveId(null);
      setDraft(createBlankBrandProfileSeed());
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

  useEffect(() => { load().catch((error) => { setNotice({ tone: "error", text: error.message }); setLoading(false); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    setPendingRecoveryOperation(operation);
    if (operation.kind === "preview") {
      try {
        const restoredDraft = JSON.parse(operation.surface.payloadJson) as BrandPayload;
        setActiveId(operation.surface.profileId);
        setDraft(restoredDraft);
        setSourceProjectId(operation.surface.projectId);
        setSourcePreflightId(operation.surface.preflightId);
        setSourceVideoJobId(operation.surface.videoJobId);
        setSourceVisualContext(null);
        setProposal(null);
        setPreview(null);
      } catch {
        clearPendingBrandPreviewOperation(storage, userId, operation.requestId);
        return;
      }
    }
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
    setAdvancedOpen(false);
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
    setAdvancedOpen(false);
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
    setAdvancedOpen(false);
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

  function applyProposal(next: VisualProposal) {
    const palette = normalizeHexPalette(next.palette);
    if (!palette) {
      setNotice({ tone: "error", text: "AI ส่งสีมาไม่ใช่รูปแบบ HEX กรุณาขอคำแนะนำใหม่อีกครั้ง" });
      return;
    }
    setDraft((current) => ({
      ...current,
      visual: {
        ...current.visual,
        primaryVisualFormatId: next.primaryVisualFormatId,
        palette,
        personality: next.personality,
        visualNotes: next.visualNotes,
        languageMode: "defined",
      },
    }));
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
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }),
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
              payload,
              projectId: sourceProjectId,
              preflightId: sourcePreflightId,
              videoJobId: sourceVideoJobId,
            }),
          }))
          : await responseJson(await fetch("/api/brand-library", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ payload }),
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
    setBusy("preview"); setPreview(null); setNotice(null);
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
  if (!library) return <div className="p-8 text-sm text-destructive">โหลดคลังแบรนด์ไม่สำเร็จ</div>;

  const canPublish = draft.name.trim().length > 0;
  const frozen = activeProfile?.frozen === true;

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-5 md:px-7 md:pt-8">
        <header className="ve-rise mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-500">
              <SwatchBook className="h-3.5 w-3.5" />
              คลังแบรนด์
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-foreground md:text-[38px]">
              แบรนด์ของฉัน
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              ตั้งชื่อแบรนด์ แล้วเลือกแนวภาพที่อยากให้คลิปของคุณเป็น ที่เหลือปรับทีหลังได้
            </p>
          </div>
          <Card className="px-4 py-3">
            {allowance?.eligible ? (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  สิทธิ์ทดลองสร้างภาพ
                </p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">
                  {allowance.remainingImages}
                  <span className="text-sm font-medium text-muted-foreground"> / {allowance.limitImages}</span>
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  คงเหลือในรอบนี้ · การวิเคราะห์และเลือกแนวภาพไม่ใช้สิทธิ์
                </p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  เครดิตสำหรับสร้างภาพ
                </p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">ใช้ยอดเครดิตเดียวกับบัญชี</p>
                <p className="mt-1 text-[11px] text-muted-foreground">ภาพ AI ราคา 2 เครดิตต่อภาพ</p>
              </>
            )}
          </Card>
        </header>

        {library.availabilitySelectionRequired && library.cap !== null && (
          <Card className="mb-5 border-amber-500/45 bg-amber-500/10 p-4">
            <p className="text-sm font-semibold text-foreground">เลือก {library.cap} แบรนด์สำหรับงานใหม่</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              แผนปัจจุบันรองรับน้อยกว่าจำนวนที่มี ระบบไม่ลบข้อมูลใด และคลิปเดิมยังสร้างซ้ำด้วยแนวภาพรุ่นที่เลือกไว้ได้
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {library.profiles.map((profile) => {
                const selected = availabilityChoice.includes(profile.id);
                return (
                  <Button
                    key={profile.id}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    onClick={() => toggleAvailability(profile.id)}
                    className={selected ? "bg-violet-600 text-white hover:bg-violet-600/90" : undefined}
                  >
                    {selected && <Check className="h-3.5 w-3.5" />}
                    {profile.name}
                  </Button>
                );
              })}
            </div>
            <Button
              type="button"
              onClick={confirmAvailability}
              disabled={busy !== null || availabilityChoice.length !== library.cap}
              className="mt-3 h-10 bg-violet-600 text-white hover:bg-violet-600/90"
            >
              {busy === "availability" && <Loader2 className="h-4 w-4 animate-spin" />}
              ยืนยันแบรนด์ที่ใช้ต่อ
            </Button>
          </Card>
        )}

        <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
          <BrandList
            profiles={library.profiles}
            cap={library.cap}
            canCreate={library.canCreate}
            activeId={activeId}
            busy={busy !== null}
            onOpen={openProfile}
            onArchive={(profile) => void archiveProfile(profile)}
            onStartNew={startNew}
            onStartFromCurrentDefaults={startFromCurrentDefaults}
          />

          <div className="min-w-0 space-y-4">
            {sourceProjectId && (
              <Card className="border-violet-500/40 bg-violet-500/10 p-4 text-xs leading-5 text-muted-foreground">
                <span className="font-semibold text-foreground">เริ่มจากคลิปที่คุณเพิ่งสร้าง</span>
                {" "}— ระบบเติมแนวภาพและบริบทของเนื้อหาให้ตรวจแล้ว การบันทึกจะสร้างโปรไฟล์แบรนด์และเลือกแนวภาพรุ่นนี้ให้คลิปโดยตรง
              </Card>
            )}

            {frozen && (
              <Card className="border-amber-500/45 bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-foreground">แบรนด์นี้อยู่ในโหมดอ่านอย่างเดียว</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  คลิปเดิมยังสร้างซ้ำด้วยแนวภาพรุ่นที่เลือกไว้ได้ อัปเกรดเพื่อแก้หรือใช้กับคลิปใหม่
                </p>
              </Card>
            )}

            <Card className="p-5 md:p-6">
              <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold text-foreground">
                  {activeProfile?.name || "ออกแบบแนวภาพใหม่"}
                </h2>
                {activeProfile && (
                  <span className="text-xs text-muted-foreground">
                    แนวภาพรุ่น {activeProfile.activeRevisionNumber}
                  </span>
                )}
              </div>

              {!library.profiles.length && (
                <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
                  สร้างแบรนด์แรกของคุณ — ตั้งชื่อ แล้วเลือกแนวภาพที่อยากให้คลิปของคุณเป็น
                </p>
              )}

              <div className="space-y-6">
                <BrandBasicsForm
                  name={draft.name}
                  onNameChange={(value) => setDraft((current) => ({ ...current, name: value }))}
                  disabled={frozen}
                />
                <VisualFormatPicker
                  formats={library.visualFormats}
                  value={draft.visual.primaryVisualFormatId}
                  onChange={(id) => updateVisual("primaryVisualFormatId", id)}
                  disabled={frozen}
                />
              </div>
            </Card>

            <AdvancedSettings
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              draft={draft}
              setDraft={setDraft}
              updateVisual={updateVisual}
              library={library}
              busy={busy}
              disabled={frozen}
              proposal={proposal}
              onAskHelper={askVisualHelper}
              onApplyProposal={applyProposal}
              onUploadBrandMark={(file) => void uploadBrandMark(file)}
            />

            <BrandLookPreviewPanel
              preview={preview}
              previewGenerationCount={previewGenerationCount}
              allowance={allowance}
              imageAccess={library.imageAccess}
              canPublish={canPublish}
              busy={busy}
              disabled={frozen}
              onPreview={previewLook}
              onReroll={rerollPreviewItem}
            />

            {notice && (
              <div
                role="status"
                className={`rounded-lg border-l-4 p-3 text-sm ${
                  notice.tone === "ok"
                    ? "border-emerald-500 bg-emerald-500/10 text-foreground"
                    : "border-destructive bg-destructive/10 text-foreground"
                }`}
              >
                <div>{notice.text}</div>
                {pendingRecoveryOperation && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void resumePendingBrandPreviewOperation(pendingRecoveryOperation)}
                    className="mt-3"
                  >
                    {busy !== null && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    ติดตามคำขอเดิม
                  </Button>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="max-w-xl text-[11px] leading-5 text-muted-foreground">
                การแก้ร่างหรือทดลองภาพยังไม่เปลี่ยนแนวภาพรุ่นที่โปรเจกต์ใช้อยู่ ภาพเดิมจะไม่ถูกสร้างใหม่อัตโนมัติ
              </p>
              <div className="flex flex-wrap gap-2">
                {activeId && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={saveDraftOnly}
                    disabled={busy !== null || !canPublish || frozen}
                    className="h-10"
                  >
                    {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    บันทึกร่าง
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={publishOrCreate}
                  disabled={busy !== null || !canPublish || frozen}
                  className="h-10 bg-violet-600 text-white hover:bg-violet-600/90"
                >
                  {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {activeId ? "ใช้แนวภาพใหม่นี้" : "บันทึกเข้าคลังแบรนด์"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
