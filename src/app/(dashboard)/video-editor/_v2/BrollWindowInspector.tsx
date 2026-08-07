"use client";

/**
 * BrollWindowInspector — Phase 2 (Task 11): per-window b-roll swap panel.
 * Opened by clicking a b-roll span on the desktop timeline (TimelinePanel,
 * `onSelectBrollWindow`) or a window chip on mobile (PostPhaseMobile). One
 * responsive component — desktop renders as a right-side panel (normal flex
 * column, no overlay), mobile renders as a bottom sheet (position:fixed, same
 * pattern as PostPhaseMobile's other sheets) — chosen internally via useIsMobile().
 *
 * Progressive disclosure (Mew's hard requirement): the AI tab defaults to a single
 * Thai textarea; the composed English prompt only appears behind "ขั้นสูง".
 *
 * Mounted for internal AI testers during beta, or for everyone after
 * NEXT_PUBLIC_BROLL_WINDOW_EDIT=1. AI Image has its own finer-grained access prop
 * and remains visible-but-disabled outside the managed image beta.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary, Chip, GroupLabel, Segmented, Toggle } from "./ui";
import { useIsMobile } from "./useIsMobile";
import { brollWindowSpans } from "@/lib/broll-spans";
import { buildBrollImagePrompt } from "@/lib/kie-image-prompt";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { PostPhaseEditor, WindowEditKind } from "./usePostPhaseEditor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function fmtMs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function rawBgVideoAt(config: Record<string, unknown> | null, index: number): Record<string, unknown> | null {
  if (!config) return null;
  const arr = (config as { bgVideos?: unknown }).bgVideos;
  if (!Array.isArray(arr)) return null;
  const raw = arr[index];
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function sourceLabel(kind: WindowEditKind | null): string {
  if (kind === "upload") return "อัปโหลด";
  if (kind === "ai") return "AI";
  return "สต็อก";
}

// Infer a window's source kind from its asset filename — used when `provider` metadata is
// absent (an edited window has its stale provider stripped by mergeWindowEdits after apply).
// broll-window routes stamp the kind into the basename: broll-ai-* / broll-upload-* / stock-*.
function inferKindFromSrc(src: unknown): WindowEditKind {
  const s = typeof src === "string" ? src : "";
  if (s.includes("/broll-ai-")) return "ai";
  if (s.includes("/broll-upload-")) return "upload";
  return "stock";
}

function entrySourceKind(entry: Record<string, unknown> | null): WindowEditKind {
  if (entry?.provider === "kie-ai" || entry?.provider === "runpod") return "ai";
  return inferKindFromSrc(entry?.src);
}

// Source badge for a live bgVideos entry: both the legacy Cloud path and Hero
// RunPod path are AI; otherwise fall back to filename inference after apply.
function entrySourceLabel(entry: Record<string, unknown> | null): string {
  const provider = entry?.provider;
  if (provider === "kie-ai" || provider === "runpod") return "AI";
  if (typeof provider === "string" && provider) return "สต็อก";
  return sourceLabel(entrySourceKind(entry));
}

function editableInternalSrc(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let src = raw.trim();
  if (/^https?:\/\//i.test(src)) {
    try { src = new URL(src).pathname; } catch { return null; }
  }
  const queryAt = src.search(/[?#]/);
  if (queryAt !== -1) src = src.slice(0, queryAt);
  if (src.startsWith("/renders/")) src = `/api/renders/${src.slice("/renders/".length)}`;
  return /^\/api\/(renders|stocks)\/[\w.-]+\.mp4$/.test(src) ? src : null;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

type Tab = "search" | "upload" | "ai";
type SearchCandidate = { id: string; provider: "pexels" | "pixabay"; thumb: string; videoUrl: string; duration: number; title: string };

// ── Bottom "อัปเดตวิดีโอ" bar — mounted at the PostPhase/PostPhaseMobile screen
// level (not inside the inspector) so it stays visible while the user keeps editing
// more windows with the inspector closed. ──────────────────────────────────────
export function WindowEditsBottomBar({ ed }: { ed: PostPhaseEditor }) {
  if (ed.windowEdits.size === 0) return null;
  const busy = !!ed.applyingWindows;
  return (
    <div
      className="flex shrink-0 items-center justify-end gap-3 px-4 py-2"
      style={{
        position: "sticky",
        bottom: "0",
        zIndex: 38,
        background: "rgba(18,18,29,.96)",
        borderTop: `1px solid ${color.cardBorder}`,
        boxShadow: "0 -14px 30px rgba(0,0,0,.24)",
        paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
      }}
    >
      <span className="mr-auto hidden sm:inline" style={{ fontSize: 11.5, color: color.textFaint }}>
        แก้บีโรลไว้ {ed.windowEdits.size} จุด
      </span>
      <button
        type="button"
        onClick={ed.undoWindowEdits}
        disabled={busy || !ed.canUndoWindowEdits}
        aria-label="เลิกทำการแก้ B-roll"
        title="เลิกทำ"
        className="flex min-h-11 min-w-11 items-center justify-center lg:min-h-9 lg:min-w-9"
        style={{
          border: "none",
          background: "none",
          color: ed.canUndoWindowEdits ? color.textSecondary : color.textFaintest,
          cursor: busy || !ed.canUndoWindowEdits ? "default" : "pointer",
        }}
      >
        <Undo2 size={15} />
      </button>
      <button
        type="button"
        onClick={ed.redoWindowEdits}
        disabled={busy || !ed.canRedoWindowEdits}
        aria-label="ทำซ้ำการแก้ B-roll"
        title="ทำซ้ำ"
        className="flex min-h-11 min-w-11 items-center justify-center lg:min-h-9 lg:min-w-9"
        style={{
          border: "none",
          background: "none",
          color: ed.canRedoWindowEdits ? color.textSecondary : color.textFaintest,
          cursor: busy || !ed.canRedoWindowEdits ? "default" : "pointer",
        }}
      >
        <Redo2 size={15} />
      </button>
      <BtnPrimary
        onClick={() => void ed.applyWindowEdits()}
        disabled={busy}
        style={{ padding: "7px 16px", fontSize: 12.5, ...(busy ? { opacity: 0.75, cursor: "wait" } : {}) }}
      >
        {busy ? `กำลังอัปเดต ${ed.applyingWindows!.progress}%` : `อัปเดตวิดีโอ (${ed.windowEdits.size} จุด) — ฟรี ไม่ใช้นาทีเพิ่ม`}
      </BtnPrimary>
    </div>
  );
}

/** Blocks destructive navigation and stale export while browser-only B-roll edits are pending. */
export function PendingBrollChangesDialog({ ed }: { ed: PostPhaseEditor }) {
  const intent = ed.pendingBrollIntent;
  const count = ed.windowEdits.size;
  const isExport = intent === "export";
  return (
    <AlertDialog
      open={intent !== null}
      onOpenChange={(open) => {
        if (!open) ed.cancelPendingBrollIntent();
      }}
    >
      <AlertDialogContent
        className="w-[calc(100%_-_28px)] max-w-md border"
        overlayClassName="z-[80]"
        style={{
          zIndex: 81,
          background: color.bg1,
          borderColor: color.cardBorder,
          color: color.text,
          borderRadius: radius.cardLg,
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle style={{ font: `600 17px ${font.heading}`, color: color.text }}>
            {isExport ? `มี B-roll ที่ยังไม่ได้อัปเดต ${count} จุด` : "กำลังจะสร้างโปรเจกต์ใหม่"}
          </AlertDialogTitle>
          <AlertDialogDescription style={{ color: color.textSecondary, lineHeight: 1.7 }}>
            {isExport
              ? "ระบบต้องอัปเดต B-roll ลงวิดีโอก่อน จึงจะส่งออกโดยไม่ทำให้รูปหรือคลิปที่เลือกหาย"
              : (
                <>
                  มี B-roll ที่ยังไม่ได้อัปเดต {count} จุด งานเดิมยังอยู่ในรายการโปรเจกต์
                  การอัปเดต B-roll ครั้งนี้ฟรีและไม่ใช้นาทีเพิ่ม เลือกบันทึก B-roll
                  ในงานเดิมก่อน หรือทิ้งเฉพาะการแก้ B-roll แล้วสร้างโปรเจกต์ใหม่
                </>
              )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-2 flex-col gap-2 sm:flex-row sm:space-x-0">
          <AlertDialogCancel
            style={{ minHeight: 44, borderColor: color.cardBorder, background: "transparent", color: color.textSecondary }}
          >
            กลับไปตรวจ
          </AlertDialogCancel>
          {!isExport && (
            <AlertDialogAction
              onClick={ed.discardPendingBrollAndContinue}
              style={{ minHeight: 44, background: "rgba(248,113,113,.12)", color: color.danger, border: `1px solid ${color.danger}` }}
            >
              ทิ้ง B-roll แล้วสร้างโปรเจกต์ใหม่
            </AlertDialogAction>
          )}
          <AlertDialogAction
            onClick={() => void ed.applyPendingBrollAndContinue()}
            style={{ minHeight: 44, background: color.gradientPrimary, color: color.text }}
          >
            {isExport ? "อัปเดต B-roll แล้วส่งออก" : "อัปเดต B-roll แล้วสร้างโปรเจกต์ใหม่"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BrollWindowInspector({ ed, videoJobId, brollRegionPreference, brollVisualStyle, aiImageEnabled }: {
  ed: PostPhaseEditor;
  videoJobId: string | null;
  brollRegionPreference: BrollRegionPreference;
  brollVisualStyle: BrollVisualStyle;
  aiImageEnabled: boolean;
}) {
  const isMobile = useIsMobile();
  const index = ed.selectedWindow;

  const durationMs = Math.max(
    ed.preview?.audioDurationMs ?? 0,
    ed.captions.length ? ed.captions[ed.captions.length - 1].endMs : 0,
    1,
  );
  const spans = useMemo(() => brollWindowSpans(ed.previewConfig, durationMs), [ed.previewConfig, durationMs]);
  const span = index != null ? spans.find((s) => s.index === index) ?? null : null;

  // ── per-window form state — reset whenever the selected window changes ──────
  const [tab, setTab] = useState<Tab>("search");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchCandidates, setSearchCandidates] = useState<SearchCandidate[] | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [aiSimpleText, setAiSimpleText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedOverride, setAdvancedOverride] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInsufficient, setAiInsufficient] = useState<{ need: number; balance: number } | null>(null);
  const aiRequestRef = useRef<{ key: string; id: string } | null>(null);

  const rawEntry = index != null ? rawBgVideoAt(ed.previewConfig, index) : null;

  useEffect(() => {
    setTab("search");
    setSearchLoading(false);
    setSearchError(null);
    setSearchCandidates(null);
    setSelectingId(null);
    setUploadBusy(false);
    setUploadError(null);
    setAiSimpleText("");
    setAdvancedOpen(false);
    setAdvancedOverride(null);
    setAiBusy(false);
    setAiError(null);
    setAiInsufficient(null);
    aiRequestRef.current = null;
    const kw = typeof rawEntry?.keyword === "string" ? rawEntry.keyword : "";
    setSearchKeyword(kw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (!aiImageEnabled && tab === "ai") setTab("search");
  }, [aiImageEnabled, tab]);

  // Edge case: a selection with no matching real window (fail-open single-block
  // fallback / stale index after an apply changed bgVideos length) — nothing to
  // edit here, close instead of showing a broken panel.
  useEffect(() => {
    if (index != null && !span) ed.setSelectedWindow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, span]);

  if (index == null || !span) return null;

  const existingEdit = ed.windowEdits.get(index) ?? null;
  const currentSourceLabel = existingEdit?.kind
    ? sourceLabel(existingEdit.kind)
    : entrySourceLabel(rawEntry);
  const positionLabel = (spans.findIndex((s) => s.index === index) + 1) || index + 1;
  const enabled = ed.isBrollWindowEnabled(index);
  const windowDurationSec = (span.endMs - span.startMs) / 1_000;
  const previousSpan = positionLabel > 1 ? spans[positionLabel - 2] : null;
  const nextSpan = positionLabel < spans.length ? spans[positionLabel] : null;

  const composedPrompt = buildBrollImagePrompt(aiSimpleText, {
    region: brollRegionPreference,
    style: brollVisualStyle,
    terms: null,
  });
  const finalPrompt = (advancedOverride ?? composedPrompt).trim();
  const genCost = HERO_AI_IMAGE_CREDITS;

  function close() { ed.setSelectedWindow(null); }

  function markEdited(kind: WindowEditKind, src: string, keyword?: string, label?: string, clipDuration?: number) {
    ed.setWindowEdit(index!, {
      src,
      kind,
      ...(keyword ? { keyword } : {}),
      ...(typeof clipDuration === "number" ? { clipDuration } : {}),
      label: label ?? sourceLabel(kind),
    });
    toast.success(kind === "ai" ? "สร้างภาพสำเร็จ — เลือกใช้แล้ว" : "เปลี่ยนคลิปแล้ว");
  }

  function effectiveAsset(windowIndex: number): {
    src: string;
    keyword?: string;
    kind: WindowEditKind;
    label: string;
  } | null {
    const raw = rawBgVideoAt(ed.previewConfig, windowIndex);
    const staged = ed.windowEdits.get(windowIndex);
    const src = editableInternalSrc(staged?.src ?? raw?.src);
    if (!src) return null;
    const rawKeyword = typeof raw?.keyword === "string" ? raw.keyword : undefined;
    return {
      src,
      keyword: staged?.keyword ?? rawKeyword,
      kind: staged?.kind ?? entrySourceKind(raw),
      label: staged?.label ?? entrySourceLabel(raw),
    };
  }

  function swapWith(target: typeof previousSpan) {
    if (!target) return;
    const currentAsset = effectiveAsset(index!);
    const targetAsset = effectiveAsset(target.index);
    if (!currentAsset || !targetAsset) {
      toast.error("ย้ายคลิปนี้ไม่ได้ — ลองเปลี่ยนคลิปก่อนแล้วสลับอีกครั้ง");
      return;
    }
    ed.setWindowEdits([
      {
        index: index!,
        edit: {
          src: targetAsset.src,
          keyword: targetAsset.keyword,
          kind: targetAsset.kind,
          label: targetAsset.label,
        },
      },
      {
        index: target.index,
        edit: {
          src: currentAsset.src,
          keyword: currentAsset.keyword,
          kind: currentAsset.kind,
          label: currentAsset.label,
        },
      },
    ]);
    ed.setSelectedWindow(target.index);
    toast.success("สลับตำแหน่ง B-roll แล้ว");
  }

  async function handleSearch() {
    const kw = searchKeyword.trim();
    if (!kw) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchCandidates(null);
    try {
      const res = await fetch("/api/videos/broll-window/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: kw }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setSearchError(d?.message ?? `ค้นหาไม่สำเร็จ (${res.status})`); return; }
      setSearchCandidates(Array.isArray(d?.candidates) ? d.candidates : []);
    } catch {
      setSearchError("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleSelectCandidate(c: SearchCandidate) {
    setSelectingId(c.id);
    try {
      const res = await fetch("/api/videos/broll-window/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: c.videoUrl, provider: c.provider, keyword: searchKeyword.trim() }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.src) { toast.error(d?.message ?? `เปลี่ยนคลิปไม่สำเร็จ (${res.status})`); return; }
      markEdited("stock", d.src, searchKeyword.trim() || undefined, c.title || "สต็อก", d.clipDuration);
    } catch {
      toast.error("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setSelectingId(null);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError(null);
    const ext = fileExt(file.name);
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    if (!isImage && !isVideo) {
      setUploadError("รองรับเฉพาะรูป (jpg/png/webp) หรือวิดีโอ (mp4/mov/webm)");
      return;
    }
    const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (file.size > maxBytes) {
      setUploadError(isImage ? "รูปใหญ่เกิน 20 MB" : "วิดีโอใหญ่เกิน 200 MB");
      return;
    }
    setUploadBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/videos/broll-window/upload", { method: "POST", body: form });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.src) { setUploadError(d?.message ?? `อัปโหลดไม่สำเร็จ (${res.status})`); return; }
      markEdited("upload", d.src, undefined, "อัปโหลด", d.clipDuration);
    } catch {
      setUploadError("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setUploadBusy(false);
    }
  }

  function enableThisWindow() {
    ed.setWindowEdit(index!, { enabled: true });
    toast.success("เปิด B-roll ช่วงนี้แล้ว");
  }

  async function handleGenerate() {
    if (!aiImageEnabled) { setAiError("Hero AI Image กำลังเตรียมเปิดให้ใช้งานเร็ว ๆ นี้"); return; }
    // Money guard: /api/videos/broll-window/generate spends credits BEFORE anything is shown,
    // and a disabled window never renders its asset — the user would pay for nothing.
    if (!enabled) { setAiError("ช่วงนี้ปิด B-roll อยู่ — เปิดก่อนจึงจะสร้างภาพได้ (กันเครดิตหายฟรี)"); return; }
    if (!finalPrompt) { setAiError("กรุณาระบุคำอธิบายรูปภาพที่ต้องการ"); return; }
    if (!videoJobId) { setAiError("ไม่พบวิดีโอต้นฉบับ กรุณาโหลดโปรเจกต์ใหม่"); return; }
    setAiBusy(true);
    setAiError(null);
    setAiInsufficient(null);
    const requestKey = `${videoJobId}:${index}:${finalPrompt}`;
    const requestId = aiRequestRef.current?.key === requestKey
      ? aiRequestRef.current.id
      : crypto.randomUUID();
    aiRequestRef.current = { key: requestKey, id: requestId };
    try {
      const res = await fetch("/api/videos/broll-window/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: finalPrompt,
          requestId,
          videoJobId,
          sceneIndex: index,
          durationSec: windowDurationSec,
          visualStyle: brollVisualStyle,
        }),
      });
      const d = await res.json().catch(() => null);
      // A definite HTTP response closes this attempt. Only an ambiguous network
      // failure or an unconfirmed refund keeps the same id so retry cannot
      // reserve credits twice.
      if (d?.retrySameRequest !== true) aiRequestRef.current = null;
      if (res.status === 402) {
        setAiInsufficient({ need: d?.need ?? genCost, balance: d?.balance ?? 0 });
        return;
      }
      if (!res.ok || !d?.src) { setAiError(d?.message ?? `สร้างรูปไม่สำเร็จ (${res.status})`); return; }
      markEdited("ai", d.src, undefined, "AI", d.clipDuration);
    } catch {
      setAiError("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setAiBusy(false);
    }
  }

  const currentAssetPreview = effectiveAsset(index);

  const header = (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span style={{ font: `600 13.5px ${font.heading}`, color: color.text }}>ฉากที่ {positionLabel}</span>
          <span style={{ fontSize: 11, color: color.textFaint }}>{fmtMs(span.startMs)} – {fmtMs(span.endMs)} · {currentSourceLabel}</span>
        </div>
        <button
          onClick={close}
          aria-label="ปิดแผงแก้ B-roll"
          className="flex min-h-11 min-w-11 items-center justify-center lg:min-h-9 lg:min-w-9"
          style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer", padding: 0 }}
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span style={{ fontSize: 10.5, color: color.textFaintest }}>
          ภาพที่กำลังแก้ · {currentAssetPreview?.label ?? currentSourceLabel}
        </span>
        <div
          className="flex w-full items-center justify-center overflow-hidden"
          style={{
            aspectRatio: "16/9",
            borderRadius: radius.card,
            border: `1px solid ${color.cardBorder}`,
            background: "#050507",
          }}
        >
          {currentAssetPreview ? (
            <video
              key={currentAssetPreview.src}
              src={currentAssetPreview.src}
              aria-label={`ตัวอย่าง B-roll ฉากที่ ${positionLabel}`}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
              className="h-full w-full object-contain"
            />
          ) : (
            <span style={{ fontSize: 11.5, color: color.textFaint }}>ไม่พบไฟล์ตัวอย่างของฉากนี้</span>
          )}
        </div>
      </div>
      <div
        className="flex items-center gap-3"
        style={{
          minHeight: 52,
          padding: "8px 10px",
          borderRadius: radius.card,
          background: enabled ? "rgba(52,211,153,.07)" : "rgba(255,255,255,.035)",
          border: `1px solid ${enabled ? "rgba(52,211,153,.20)" : color.cardBorder}`,
        }}
      >
        {enabled ? <Eye size={17} color={color.success} /> : <EyeOff size={17} color={color.textFaint} />}
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: 12.5, color: color.text }}>แสดง B-roll ช่วงนี้</div>
          <div style={{ fontSize: 10.5, color: color.textFaint }}>
            {ed.preview?.avatarModel === "upload-cutaway"
              ? enabled
                ? "ช่วงนี้แสดงภาพ B-roll"
                : "ช่วงนี้แสดงคลิป Avatar ต้นฉบับ"
              : enabled
                ? "ช่วงนี้แสดงภาพ B-roll"
                : "ช่วงนี้ใช้พื้นหลังเรียบ"}
          </div>
        </div>
        <Toggle
          on={enabled}
          onChange={(next) => {
            ed.setWindowEdit(index!, { enabled: next });
            toast.success(next ? "เปิด B-roll ช่วงนี้แล้ว" : "ปิด B-roll ช่วงนี้แล้ว");
          }}
          ariaLabel={enabled ? "ปิด B-roll ช่วงนี้" : "เปิด B-roll ช่วงนี้"}
        />
      </div>
      {!enabled && (
        <div
          role="status"
          className="flex flex-col gap-2"
          style={{
            padding: "10px 12px",
            borderRadius: radius.card,
            background: "rgba(251,191,36,.08)",
            border: "1px solid rgba(251,191,36,.28)",
          }}
        >
          <div className="flex items-start gap-2">
            <EyeOff size={15} color={color.warning} style={{ flex: "none", marginTop: 1 }} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span style={{ fontSize: 12, color: color.warning }}>ปิด B-roll ช่วงนี้อยู่</span>
              <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.5 }}>
                {ed.preview?.avatarModel === "upload-cutaway"
                  ? "ช่วงนี้จะแสดงคลิป Avatar ต้นฉบับแทน"
                  : "ช่วงนี้จะใช้พื้นหลังเรียบแทน"}
                {" — เปลี่ยนหรืออัปโหลดคลิปได้ แต่จะยังไม่แสดงจนกว่าจะเปิด B-roll ช่วงนี้"}
              </span>
            </div>
          </div>
          <BtnSecondary
            onClick={enableThisWindow}
            style={{ alignSelf: "flex-start", minHeight: 40, padding: "8px 14px", fontSize: 11.5 }}
          >
            <span className="flex items-center justify-center gap-1.5">
              <Eye size={13} /> เปิด B-roll ช่วงนี้
            </span>
          </BtnSecondary>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <BtnSecondary
          onClick={() => swapWith(previousSpan)}
          disabled={!previousSpan}
          style={{
            minHeight: 44,
            padding: "8px 10px",
            fontSize: 11.5,
            opacity: previousSpan ? 1 : 0.45,
            cursor: previousSpan ? "pointer" : "default",
          }}
        >
          <span className="flex items-center justify-center gap-1.5">
            <ArrowLeft size={13} /> สลับกับฉากก่อนหน้า
          </span>
        </BtnSecondary>
        <BtnSecondary
          onClick={() => swapWith(nextSpan)}
          disabled={!nextSpan}
          style={{
            minHeight: 44,
            padding: "8px 10px",
            fontSize: 11.5,
            opacity: nextSpan ? 1 : 0.45,
            cursor: nextSpan ? "pointer" : "default",
          }}
        >
          <span className="flex items-center justify-center gap-1.5">
            สลับกับฉากถัดไป <ArrowRight size={13} />
          </span>
        </BtnSecondary>
      </div>
      <Segmented
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        options={[
          { value: "search", label: "เปลี่ยนสต็อก" },
          { value: "upload", label: "อัปโหลด" },
          {
            value: "ai",
            label: "AI Image",
            badge: aiImageEnabled ? undefined : "เร็ว ๆ นี้",
            disabled: !aiImageEnabled,
            title: aiImageEnabled ? "สร้างภาพใหม่สำหรับฉากนี้" : "AI Image เร็ว ๆ นี้",
          },
        ]}
        style={{ display: "flex" }}
      />
    </div>
  );

  const tabContent = (
    <div className="flex flex-col gap-3">
      {tab === "search" && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
              placeholder="คำค้นหา (อังกฤษ)"
              className="min-w-0 flex-1"
              style={{ padding: "9px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontSize: 13, fontFamily: font.body, outline: "none" }}
            />
            <BtnSecondary onClick={() => void handleSearch()} disabled={searchLoading || !searchKeyword.trim()} style={{ padding: "9px 16px", flex: "none", ...(searchLoading ? { opacity: 0.7, cursor: "wait" } : {}) }}>
              {searchLoading ? <Loader2 size={14} className="animate-spin" /> : "ค้นหา"}
            </BtnSecondary>
          </div>
          {searchError && <span style={{ fontSize: 11.5, color: color.danger }}>{searchError}</span>}
          {searchCandidates && searchCandidates.length === 0 && !searchError && (
            <span style={{ fontSize: 12, color: color.textFaint }}>
              {aiImageEnabled ? "ไม่พบคลิปที่ตรง ลองเปลี่ยนคำค้น หรือใช้ AI Image" : "ไม่พบคลิปที่ตรง ลองเปลี่ยนคำค้นอีกครั้ง"}
            </span>
          )}
          {searchCandidates && searchCandidates.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {searchCandidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void handleSelectCandidate(c)}
                  disabled={selectingId !== null}
                  className="relative overflow-hidden text-left"
                  style={{ borderRadius: radius.card, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16", background: "#000", cursor: selectingId ? "wait" : "pointer", padding: 0 }}
                >
                  {c.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumb} alt={c.title} className="absolute inset-0 h-full w-full object-cover" />
                  ) : null}
                  <span className="absolute left-1.5 top-1.5" style={{ fontSize: 9, padding: "2px 6px", borderRadius: 999, background: "rgba(10,10,16,.7)", color: color.textSecondary }}>
                    {c.provider === "pexels" ? "Pexels" : "Pixabay"}
                  </span>
                  {selectingId === c.id && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5" style={{ background: "rgba(10,10,16,.6)" }}>
                      <Loader2 size={16} className="animate-spin" color={color.primary300} />
                      <span style={{ fontSize: 10, color: color.textSecondary }}>กำลังเตรียมคลิป…</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "upload" && (
        <div className="flex flex-col gap-2">
          <label
            className="flex flex-col items-center justify-center gap-2 text-center"
            style={{ padding: "28px 16px", borderRadius: radius.card, border: `1px dashed ${color.cardBorder}`, cursor: uploadBusy ? "wait" : "pointer" }}
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              onChange={(e) => void handleFileChange(e)}
              disabled={uploadBusy}
              className="hidden"
            />
            {uploadBusy ? (
              <>
                <Loader2 size={18} className="animate-spin" color={color.primary300} />
                <span style={{ fontSize: 12, color: color.textSecondary }}>กำลังอัปโหลด…</span>
              </>
            ) : (
              <span style={{ fontSize: 13, color: color.text }}>แตะเพื่อเลือกไฟล์ (รูปภาพหรือวิดีโอ)</span>
            )}
          </label>
          <span style={{ fontSize: 10.5, color: color.textFaintest }}>รูปภาพจะถูกทำเป็นคลิปเคลื่อนไหวอัตโนมัติ</span>
          {uploadError && <span style={{ fontSize: 11.5, color: color.danger }}>{uploadError}</span>}
        </div>
      )}

      {tab === "ai" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <GroupLabel>บรรยายภาพที่อยากได้</GroupLabel>
            <textarea
              value={aiSimpleText}
              onChange={(e) => setAiSimpleText(e.target.value)}
              placeholder="เช่น ร้านกาแฟไทยตอนเช้า มีคนกำลังชงกาแฟ"
              rows={3}
              className="w-full resize-none"
              style={{ padding: "10px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontSize: 13, lineHeight: 1.6, fontFamily: font.body, outline: "none" }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip selected>Hero · Z-Image Turbo · RunPod · {genCost} เครดิต</Chip>
          </div>
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            style={{ alignSelf: "flex-start", background: "none", border: "none", color: color.link, fontSize: 11.5, cursor: "pointer", padding: 0 }}
          >
            {advancedOpen ? "▲ ขั้นสูง" : "▼ ขั้นสูง"}
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-1.5">
              <GroupLabel>พรอมต์เต็ม (แก้ไขได้)</GroupLabel>
              <textarea
                value={advancedOverride ?? composedPrompt}
                onChange={(e) => setAdvancedOverride(e.target.value)}
                rows={5}
                className="w-full resize-none"
                style={{ padding: "10px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.textSecondary, fontSize: 12, lineHeight: 1.6, fontFamily: font.body, outline: "none" }}
              />
            </div>
          )}
          {aiError && <span style={{ fontSize: 11.5, color: color.danger }}>{aiError}</span>}
          {aiInsufficient && (
            <span style={{ fontSize: 11.5, color: color.danger }}>
              เครดิตไม่พอ — ต้องใช้ {aiInsufficient.need} เครดิต (มี {aiInsufficient.balance}) — <a href="/pricing" style={{ color: color.link }}>ดูแพ็กเกจ</a>
            </span>
          )}
          {!enabled && (
            <div className="flex flex-col gap-2">
              <span style={{ fontSize: 11.5, color: color.warning, lineHeight: 1.5 }}>
                ช่วงนี้ปิด B-roll อยู่ — สร้างภาพ AI ไม่ได้ เพราะจะหักเครดิตแต่ภาพไม่ถูกใช้
              </span>
              <BtnSecondary
                onClick={enableThisWindow}
                style={{ alignSelf: "flex-start", minHeight: 40, padding: "8px 14px", fontSize: 11.5 }}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <Eye size={13} /> เปิด B-roll ช่วงนี้ก่อน
                </span>
              </BtnSecondary>
            </div>
          )}
          <BtnPrimary
            onClick={() => void handleGenerate()}
            disabled={aiBusy || !finalPrompt || !enabled}
            title={enabled ? undefined : "เปิด B-roll ช่วงนี้ก่อนจึงจะสร้างภาพได้"}
            style={aiBusy || !finalPrompt || !enabled ? { opacity: 0.7, cursor: aiBusy ? "wait" : "default" } : undefined}
          >
            {aiBusy ? "กำลังสร้าง Hero AI Image…" : `สร้าง Hero AI Image (ใช้ ${genCost} เครดิต)`}
          </BtnPrimary>
        </div>
      )}
    </div>
  );

  const footerSummary = ed.windowEdits.size > 0 && (
    <div className="flex flex-col gap-1.5 pt-3" style={{ borderTop: `1px solid ${color.cardBorder}` }}>
      <GroupLabel>แก้ไขแล้ว ({ed.windowEdits.size})</GroupLabel>
      {Array.from(ed.windowEdits.entries()).map(([idx, e]) => {
        const pos = (spans.findIndex((s) => s.index === idx) + 1) || idx + 1;
        return (
          <div key={idx} className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 11.5, color: color.textSecondary }}>
              ช่วงที่ {pos}
              {e.src ? ` · ${sourceLabel(e.kind ?? null)}` : ""}
              {typeof e.enabled === "boolean" ? ` · ${e.enabled ? "เปิด" : "ปิด"}` : ""}
            </span>
            <button
              onClick={() => ed.clearWindowEdit(idx)}
              style={{ color: color.link, background: "none", border: "none", cursor: "pointer", fontSize: 11 }}
            >
              เลิกแก้
            </button>
          </div>
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <>
        <div
          onClick={close}
          aria-hidden
          style={{ position: "fixed", inset: 0, zIndex: 44, background: "rgba(0,0,0,.55)" }}
        />
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 45,
            maxHeight: "88%", display: "flex", flexDirection: "column",
            background: "rgba(20,20,32,.95)",
            backdropFilter: "blur(28px) saturate(150%)",
            WebkitBackdropFilter: "blur(28px) saturate(150%)",
            borderTop: "1px solid rgba(255,255,255,.12)",
            borderRadius: "22px 22px 0 0",
            boxShadow: "0 -20px 60px rgba(0,0,0,.5)",
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 999, background: "rgba(255,255,255,.22)", margin: "10px auto 4px", flex: "none" }} />
          <div className="min-h-0 flex-1 overflow-y-auto px-4" style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))", WebkitOverflowScrolling: "touch" }}>
            <div className="flex flex-col gap-3 pt-1">
              {header}
              {tabContent}
              {footerSummary}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <aside
      className="flex w-[340px] shrink-0 flex-col"
      style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {header}
          {tabContent}
          {footerSummary}
        </div>
      </div>
    </aside>
  );
}
