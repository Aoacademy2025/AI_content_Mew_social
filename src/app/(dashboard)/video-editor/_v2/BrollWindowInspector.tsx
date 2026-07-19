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
 * Entirely gated by NEXT_PUBLIC_BROLL_WINDOW_EDIT=1 at the mount points (PostPhase/
 * PostPhaseMobile) — this file only executes when a window is selected, which only
 * happens behind that flag.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary, Chip, GroupLabel, Segmented } from "./ui";
import { useIsMobile } from "./useIsMobile";
import { brollWindowSpans } from "@/lib/broll-spans";
import { buildKieImagePrompt } from "@/lib/kie-image-prompt";
import { creditCostFor, costKeyForKieModel } from "@/lib/credit-costs";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { PostPhaseEditor, WindowEditKind } from "./usePostPhaseEditor";

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

// Source badge for a live bgVideos entry: trust `provider` when present (kie-ai → AI, any other
// provider → stock), else fall back to filename inference for post-apply edited windows.
function entrySourceLabel(entry: Record<string, unknown> | null): string {
  const provider = entry?.provider;
  if (provider === "kie-ai") return "AI";
  if (typeof provider === "string" && provider) return "สต็อก";
  return sourceLabel(inferKindFromSrc(entry?.src));
}

const AI_MODELS: { id: string; label: string }[] = [
  { id: "flux-2/pro-text-to-image", label: "Flux" },
  { id: "gpt-image-2-text-to-image", label: "GPT" },
  { id: "nano-banana-2", label: "Nano" },
];

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

export function BrollWindowInspector({ ed, brollRegionPreference, brollVisualStyle }: {
  ed: PostPhaseEditor;
  brollRegionPreference: BrollRegionPreference;
  brollVisualStyle: BrollVisualStyle;
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
  const [aiModel, setAiModel] = useState<string>("gpt-image-2-text-to-image");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInsufficient, setAiInsufficient] = useState<{ need: number; balance: number } | null>(null);

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
    setAiModel("gpt-image-2-text-to-image");
    setAiBusy(false);
    setAiError(null);
    setAiInsufficient(null);
    const kw = typeof rawEntry?.keyword === "string" ? rawEntry.keyword : "";
    setSearchKeyword(kw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Edge case: a selection with no matching real window (fail-open single-block
  // fallback / stale index after an apply changed bgVideos length) — nothing to
  // edit here, close instead of showing a broken panel.
  useEffect(() => {
    if (index != null && !span) ed.setSelectedWindow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, span]);

  if (index == null || !span) return null;

  const existingEdit = ed.windowEdits.get(index) ?? null;
  const currentSourceLabel = existingEdit
    ? sourceLabel(existingEdit.kind)
    : entrySourceLabel(rawEntry);
  const positionLabel = (spans.findIndex((s) => s.index === index) + 1) || index + 1;

  const composedPrompt = buildKieImagePrompt(aiSimpleText, {
    region: brollRegionPreference,
    style: brollVisualStyle,
    terms: null,
  });
  const finalPrompt = (advancedOverride ?? composedPrompt).trim();
  const genCost = creditCostFor(costKeyForKieModel(aiModel) ?? "image-gpt-1k");

  function close() { ed.setSelectedWindow(null); }

  function markEdited(kind: WindowEditKind, src: string, keyword?: string, label?: string) {
    ed.setWindowEdit(index!, { src, kind, ...(keyword ? { keyword } : {}), label: label ?? sourceLabel(kind) });
    toast.success(kind === "ai" ? "สร้างภาพสำเร็จ — เลือกใช้แล้ว" : "เปลี่ยนคลิปแล้ว");
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
      markEdited("stock", d.src, searchKeyword.trim() || undefined, c.title || "สต็อก");
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
      markEdited("upload", d.src, undefined, "อัปโหลด");
    } catch {
      setUploadError("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleGenerate() {
    if (!finalPrompt) { setAiError("กรุณาระบุคำอธิบายรูปภาพที่ต้องการ"); return; }
    setAiBusy(true);
    setAiError(null);
    setAiInsufficient(null);
    try {
      const res = await fetch("/api/videos/broll-window/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: finalPrompt, model: aiModel }),
      });
      const d = await res.json().catch(() => null);
      if (res.status === 402) {
        setAiInsufficient({ need: d?.need ?? genCost, balance: d?.balance ?? 0 });
        return;
      }
      if (!res.ok || !d?.src) { setAiError(d?.message ?? `สร้างรูปไม่สำเร็จ (${res.status})`); return; }
      markEdited("ai", d.src, undefined, "AI");
    } catch {
      setAiError("เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง");
    } finally {
      setAiBusy(false);
    }
  }

  const header = (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span style={{ font: `600 13.5px ${font.heading}`, color: color.text }}>บีโรลช่วงที่ {positionLabel}</span>
          <span style={{ fontSize: 11, color: color.textFaint }}>{fmtMs(span.startMs)} – {fmtMs(span.endMs)} · {currentSourceLabel}</span>
        </div>
        <button onClick={close} aria-label="ปิด" style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer", padding: 4 }}>
          <X size={18} />
        </button>
      </div>
      <Segmented
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        options={[
          { value: "search", label: "เปลี่ยนรูป" },
          { value: "upload", label: "อัปโหลด" },
          { value: "ai", label: "AI Gen" },
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
            <span style={{ fontSize: 12, color: color.textFaint }}>ไม่พบคลิปที่ตรง ลองเปลี่ยนคำค้น หรือใช้แท็บ AI</span>
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
            {AI_MODELS.map((m) => {
              const cost = creditCostFor(costKeyForKieModel(m.id) ?? "");
              return (
                <Chip key={m.id} selected={aiModel === m.id} onClick={() => setAiModel(m.id)}>
                  {m.label} · {cost} เครดิต
                </Chip>
              );
            })}
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
          <BtnPrimary
            onClick={() => void handleGenerate()}
            disabled={aiBusy || !finalPrompt}
            style={aiBusy || !finalPrompt ? { opacity: 0.7, cursor: aiBusy ? "wait" : "default" } : undefined}
          >
            {aiBusy ? "กำลังสร้างภาพ…" : `สร้างภาพ (ใช้ ${genCost} เครดิต)`}
          </BtnPrimary>
        </div>
      )}
    </div>
  );

  // Single source of truth for the "here's the chosen clip" preview: derives from the
  // window's actual staged edit (not per-tab local state) so it can never go stale when
  // switching tabs — it always reflects what will actually be used on apply.
  const stagedPreview = existingEdit?.src && (
    <div className="flex flex-col gap-1.5">
      <span style={{ fontSize: 10.5, color: color.textFaintest }}>ตัวอย่างคลิปที่จะใช้</span>
      <video
        src={existingEdit.src}
        muted
        loop
        autoPlay
        playsInline
        style={{ borderRadius: radius.card, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16", maxHeight: 200, objectFit: "cover" }}
      />
    </div>
  );

  const footerSummary = ed.windowEdits.size > 0 && (
    <div className="flex flex-col gap-1.5 pt-3" style={{ borderTop: `1px solid ${color.cardBorder}` }}>
      <GroupLabel>แก้ไขแล้ว ({ed.windowEdits.size})</GroupLabel>
      {Array.from(ed.windowEdits.entries()).map(([idx, e]) => {
        const pos = (spans.findIndex((s) => s.index === idx) + 1) || idx + 1;
        return (
          <div key={idx} className="flex items-center justify-between gap-2">
            <span style={{ fontSize: 11.5, color: color.textSecondary }}>ช่วงที่ {pos} · {sourceLabel(e.kind)}</span>
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
              {stagedPreview}
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
          {stagedPreview}
          {footerSummary}
        </div>
      </div>
    </aside>
  );
}
