"use client";

import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  FileText,
  Plus,
  Sparkles,
  Trash2,
  Eye,
  Hash,
  Globe,
  Copy,
  CheckCircle2,
  Key,
  Loader2,
  Film,
  ChevronRight,
  RotateCcw,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface Style {
  id: string;
  name: string;
}

interface Content {
  id: string;
  sourceText: string | null;
  sourceUrl: string | null;
  language: string;
  imageModel: string | null;
  videoDuration: number | null;
  headline: string | null;
  subheadline: string | null;
  body: string | null;
  hashtags: string | null;
  imagePrompt: string | null;
  visualNotes: string | null;
  createdAt: string;
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

const FIELD_STYLE = "border-0 resize-none focus-visible:ring-1 focus-visible:ring-cyan-500/50";

export default function ContentPage() {
  const [contents, setContents] = useState<Content[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"create" | "library">("create");
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [viewingContent, setViewingContent] = useState<Content | null>(null);
  const [deletingContentId, setDeletingContentId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    sourceText: "",
    sourceUrl: "",
    styleId: "",
    language: "TH",
    imageModel: "nanobanana",
    videoDuration: "60",
  });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showOpenAIDialog, setShowOpenAIDialog] = useState(false);
  const [openAIKeyInput, setOpenAIKeyInput] = useState("");
  const [savingOpenAIKey, setSavingOpenAIKey] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<Content | null>(null);
  const [editableContent, setEditableContent] = useState({
    headline: "",
    subheadline: "",
    body: "",
    hashtags: "",
    imagePrompt: "",
  });

  useEffect(() => {
    fetchContents();
    fetchStyles();
  }, []);

  async function fetchContents() {
    try {
      const res = await fetch("/api/contents");
      if (res.ok) setContents(await res.json());
    } catch { toast.error("Failed to load contents"); }
    finally { setLoading(false); }
  }

  async function fetchStyles() {
    try {
      const res = await fetch("/api/styles");
      if (res.ok) setStyles(await res.json());
    } catch { /* silent */ }
  }

  async function runGenerate() {
    setGenerating(true);
    setGeneratedContent(null);
    try {
      const res = await fetch("/api/contents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          videoDuration: formData.videoDuration ? parseInt(formData.videoDuration) : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedContent(data);
        setEditableContent({
          headline: data.headline || "",
          subheadline: data.subheadline || "",
          body: data.body || "",
          hashtags: data.hashtags || "",
          imagePrompt: data.imagePrompt || "",
        });
        toast.success("Content generated!");
      } else {
        const data = await res.json();
        if (data.error?.toLowerCase().includes("openai api key")) {
          setShowOpenAIDialog(true);
        } else {
          toast.error(data.error || "Failed to generate content");
        }
      }
    } catch { toast.error("Failed to generate content"); }
    finally { setGenerating(false); }
  }

  async function handleSaveOpenAIKey() {
    if (!openAIKeyInput.trim()) return;
    setSavingOpenAIKey(true);
    try {
      const res = await fetch("/api/user/api-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openaiKey: openAIKeyInput.trim() }),
      });
      if (!res.ok) throw new Error();
      setShowOpenAIDialog(false);
      setOpenAIKeyInput("");
      toast.success("Saved OpenAI key — generating...");
      await runGenerate();
    } catch { toast.error("Failed to save key"); }
    finally { setSavingOpenAIKey(false); }
  }

  async function handleSave() {
    if (!generatedContent) return;
    setSaving(true);
    try {
      const res = await fetch("/api/contents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...generatedContent, ...editableContent }),
      });
      if (res.ok) {
        toast.success("Content saved!");
        fetchContents();
        resetForm();
        setView("library");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch { toast.error("Failed to save content"); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deletingContentId) return;
    try {
      const res = await fetch(`/api/contents/${deletingContentId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Deleted");
        setDeleteDialogOpen(false);
        setDeletingContentId(null);
        fetchContents();
      } else { toast.error("Failed to delete"); }
    } catch { toast.error("Failed to delete content"); }
  }

  function resetForm() {
    setFormData({ sourceText: "", sourceUrl: "", styleId: "", language: "TH", imageModel: "nanobanana", videoDuration: "60" });
    setGeneratedContent(null);
    setEditableContent({ headline: "", subheadline: "", body: "", hashtags: "", imagePrompt: "" });
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }

  // ─── Field input component ────────────────────────────────────────────────
  function Field({ label, value, onChange, multiline, rows }: {
    label: string; value: string; onChange: (v: string) => void;
    multiline?: boolean; rows?: number;
  }) {
    return (
      <div className="rounded-xl p-4" style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
        {multiline ? (
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={rows || 4}
            className={cn(FIELD_STYLE, "bg-transparent p-0 text-sm leading-relaxed")}
            style={{ color: "var(--ui-text-secondary)" }}
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(FIELD_STYLE, "bg-transparent p-0 h-auto text-sm")}
            style={{ color: "var(--ui-text-secondary)" }}
          />
        )}
      </div>
    );
  }

  return (
    <DashboardLayout noPadding>
      <div className="flex flex-1 flex-col overflow-hidden">

        {/* ── Page Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--ui-divider)" }}>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: "var(--ui-text-primary)" }}>Content Generator</h1>
            <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>AI-powered social media content creation</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setView("create")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                view === "create" ? "bg-cyan-500/15 text-cyan-400" : "hover:bg-black/5 dark:hover:bg-white/5"
              )}
              style={{ color: view === "create" ? undefined : "var(--ui-text-muted)" }}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Generate
            </button>
            <button
              onClick={() => setView("library")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                view === "library" ? "bg-cyan-500/15 text-cyan-400" : "hover:bg-black/5 dark:hover:bg-white/5"
              )}
              style={{ color: view === "library" ? undefined : "var(--ui-text-muted)" }}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Library
              {contents.length > 0 && (
                <span className="ml-1 rounded-full px-1.5 py-0.5 text-[10px]"
                  style={{ background: "var(--ui-btn-bg)", color: "var(--ui-text-muted)" }}>
                  {contents.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ── Generate View (two-panel) ── */}
        {view === "create" && (
          <div className="flex flex-1 min-h-0">

            {/* Left panel — source + settings */}
            <div className="w-96 shrink-0 flex flex-col overflow-y-auto border-r p-5 gap-4" style={{ borderColor: "var(--ui-divider)" }}>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--ui-text-muted)" }}>Source Content</p>
                <Textarea
                  placeholder={"วางข้อความต้นฉบับ บทความ หรือหัวข้อที่ต้องการให้ AI สร้างเป็นเนื้อหา..."}
                  value={formData.sourceText}
                  onChange={(e) => setFormData({ ...formData, sourceText: e.target.value })}
                  rows={10}
                  className="w-full rounded-xl text-sm resize-none border-0 focus-visible:ring-1 focus-visible:ring-cyan-500/50"
                  style={{ background: "var(--ui-input-bg)", padding: "12px 14px", color: "var(--ui-text-secondary)" }}
                />
                <p className="mt-1 text-right text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{formData.sourceText.length} chars</p>
              </div>

              {/* Writing Style */}
              <div className="space-y-1.5">
                <Label className="text-xs" style={{ color: "var(--ui-text-muted)" }}>AI Writing Style</Label>
                <Select
                  value={formData.styleId || undefined}
                  onValueChange={(v) => setFormData({ ...formData, styleId: v })}
                >
                  <SelectTrigger className="h-9 rounded-lg border-0 text-sm focus:ring-cyan-500/50"
                    style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}>
                    <SelectValue placeholder="No style (default)" />
                  </SelectTrigger>
                  <SelectContent className="border" style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}>
                    {styles.map((s) => (
                      <SelectItem key={s.id} value={s.id} style={{ color: "var(--ui-text-secondary)" }}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Language */}
              <div className="space-y-1.5">
                <Label className="text-xs" style={{ color: "var(--ui-text-muted)" }}>Language</Label>
                <div className="flex gap-2">
                  {[{ value: "TH", label: "🇹🇭 ไทย" }, { value: "EN", label: "🇬🇧 English" }].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setFormData({ ...formData, language: value })}
                      className={cn("flex-1 rounded-lg py-2 text-sm font-medium transition-all")}
                      style={{
                        background: formData.language === value ? "hsl(190 100% 50% / 0.08)" : "var(--ui-input-bg)",
                        border: `1px solid ${formData.language === value ? "hsl(190 100% 50% / 0.3)" : "var(--ui-input-border)"}`,
                        color: formData.language === value ? "hsl(190 100% 50%)" : "var(--ui-text-muted)",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Video Duration */}
              <div className="space-y-1.5">
                <Label className="text-xs" style={{ color: "var(--ui-text-muted)" }}>Script Length</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {[{ value: "30", label: "30s" }, { value: "60", label: "60s" }, { value: "90", label: "90s" }, { value: "120", label: "2 min" }].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setFormData({ ...formData, videoDuration: value })}
                      className={cn("rounded-lg py-2 text-sm font-medium transition-all")}
                      style={{
                        background: formData.videoDuration === value ? "hsl(190 100% 50% / 0.08)" : "var(--ui-input-bg)",
                        border: `1px solid ${formData.videoDuration === value ? "hsl(190 100% 50% / 0.3)" : "var(--ui-input-border)"}`,
                        color: formData.videoDuration === value ? "hsl(190 100% 50%)" : "var(--ui-text-muted)",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Generate button */}
              <button
                onClick={runGenerate}
                disabled={generating || !formData.sourceText.trim()}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 active:scale-98"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}
              >
                {generating ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate Social Draft
                  </>
                )}
              </button>
            </div>

            {/* Right panel — AI preview */}
            <div className="flex-1 flex flex-col overflow-y-auto p-5 gap-4">
              {!generatedContent ? (
                <div className="flex flex-1 flex-col items-center justify-center text-center gap-4 py-20">
                  <div
                    className="flex h-16 w-16 items-center justify-center rounded-2xl"
                    style={{ background: "hsl(190 100% 50% / 0.08)", border: "1px solid hsl(190 100% 50% / 0.15)" }}
                  >
                    <Sparkles className="h-7 w-7 text-cyan-400/60" />
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: "var(--ui-text-muted)" }}>AI-Generated Preview</p>
                    <p className="text-xs mt-1" style={{ color: "var(--ui-text-muted)" }}>Fill in source content and click Generate</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Preview header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.15)" }}>
                        <CheckCircle2 className="h-3.5 w-3.5 text-cyan-400" />
                      </div>
                      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>AI-Generated Preview</p>
                    </div>
                    <button
                      onClick={runGenerate}
                      disabled={generating}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40"
                      style={{ color: "var(--ui-text-muted)" }}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Regenerate
                    </button>
                  </div>

                  {/* Editable fields */}
                  <Field
                    label="Headline"
                    value={editableContent.headline}
                    onChange={(v) => setEditableContent({ ...editableContent, headline: v })}
                  />
                  <Field
                    label="Subheadline"
                    value={editableContent.subheadline}
                    onChange={(v) => setEditableContent({ ...editableContent, subheadline: v })}
                    multiline rows={2}
                  />
                  <Field
                    label="Body"
                    value={editableContent.body}
                    onChange={(v) => setEditableContent({ ...editableContent, body: v })}
                    multiline rows={7}
                  />
                  <Field
                    label="Hashtags"
                    value={editableContent.hashtags}
                    onChange={(v) => setEditableContent({ ...editableContent, hashtags: v })}
                  />
                  {editableContent.imagePrompt && (
                    <Field
                      label="Image Prompt"
                      value={editableContent.imagePrompt}
                      onChange={(v) => setEditableContent({ ...editableContent, imagePrompt: v })}
                      multiline rows={2}
                    />
                  )}

                  {/* CTA buttons */}
                  <div className="flex gap-3 pt-2 border-t" style={{ borderColor: "var(--ui-divider)" }}>
                    <button
                      onClick={() => {
                        const all = `${editableContent.headline}\n\n${editableContent.subheadline}\n\n${editableContent.body}\n\n${editableContent.hashtags}`;
                        copyToClipboard(all, "All content");
                      }}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:opacity-80 transition-colors border"
                      style={{ borderColor: "var(--ui-btn-border)", color: "var(--ui-text-muted)" }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy All
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors"
                      style={{ background: "hsl(142 72% 29% / 0.9)", border: "1px solid hsl(142 72% 29%)" }}
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Save Content
                    </button>
                    <Link
                      href="/short-video"
                      className="ml-auto flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-all hover:opacity-90"
                      style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}
                    >
                      <Film className="h-3.5 w-3.5" />
                      Use in Avatar Cloning
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Library View ── */}
        {view === "library" && (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>Saved Content</p>
              <button
                onClick={() => setView("create")}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}
              >
                <Plus className="h-3.5 w-3.5" />
                Generate New
              </button>
            </div>

            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-cyan-400/50" />
              </div>
            ) : contents.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
                  <FileText className="h-6 w-6" style={{ color: "var(--ui-text-muted)" }} />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: "var(--ui-text-muted)" }}>No content yet</p>
                  <p className="text-xs mt-1" style={{ color: "var(--ui-text-muted)" }}>Generate your first AI content</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {contents.map((content) => (
                  <div
                    key={content.id}
                    className="group rounded-xl p-4 transition-all"
                    style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
                        <Globe className="h-3 w-3" />
                        {content.language === "TH" ? "ไทย" : "English"}
                        <span className="mx-1">·</span>
                        {new Date(content.createdAt).toLocaleDateString("th-TH")}
                      </div>
                      <button
                        onClick={() => { setDeletingContentId(content.id); setDeleteDialogOpen(true); }}
                        className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                        style={{ color: "var(--ui-text-muted)" }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-sm font-medium line-clamp-2 mb-1" style={{ color: "var(--ui-text-secondary)" }}>
                      {content.headline || "Untitled"}
                    </p>
                    {content.subheadline && (
                      <p className="text-xs line-clamp-2 mb-2" style={{ color: "var(--ui-text-muted)" }}>{content.subheadline}</p>
                    )}
                    {content.hashtags && (
                      <p className="text-[10px] text-cyan-400/60 line-clamp-1 mb-3">
                        <Hash className="inline h-3 w-3 mr-0.5" />
                        {content.hashtags}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setViewingContent(content); setViewDialogOpen(true); }}
                        className="flex-1 flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs hover:opacity-80 transition-colors"
                        style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-muted)" }}
                      >
                        <Eye className="h-3 w-3" />
                        View
                      </button>
                      <Link
                        href="/short-video"
                        className="flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs text-cyan-400/80 hover:text-cyan-400 transition-colors"
                        style={{ background: "hsl(190 100% 50% / 0.07)", border: "1px solid hsl(190 100% 50% / 0.2)" }}
                      >
                        <Film className="h-3 w-3" />
                        Use
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── View Dialog ── */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="sm:max-w-xl border" style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}>
          <DialogHeader>
            <DialogTitle className="text-xl" style={{ color: "var(--ui-text-primary)" }}>{viewingContent?.headline}</DialogTitle>
            <DialogDescription className="flex items-center gap-2" style={{ color: "var(--ui-text-muted)" }}>
              <Globe className="h-3.5 w-3.5" />
              {viewingContent?.language === "TH" ? "Thai" : "English"}
            </DialogDescription>
          </DialogHeader>
          {viewingContent && (
            <div className="space-y-4 pt-2">
              {viewingContent.subheadline && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ui-text-muted)" }}>Subheadline</p>
                  <p className="text-sm" style={{ color: "var(--ui-text-secondary)" }}>{viewingContent.subheadline}</p>
                </div>
              )}
              {viewingContent.body && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ui-text-muted)" }}>Body</p>
                  <p className="whitespace-pre-wrap text-sm" style={{ color: "var(--ui-text-secondary)" }}>{viewingContent.body}</p>
                </div>
              )}
              {viewingContent.hashtags && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ui-text-muted)" }}>Hashtags</p>
                  <p className="text-sm text-cyan-400/80">{viewingContent.hashtags}</p>
                </div>
              )}
              <button
                onClick={() => {
                  const all = `${viewingContent.headline}\n\n${viewingContent.subheadline}\n\n${viewingContent.body}\n\n${viewingContent.hashtags}`;
                  copyToClipboard(all, "Content");
                  setViewDialogOpen(false);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium hover:opacity-80 transition-colors"
                style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}
              >
                <Copy className="h-4 w-4" />
                Copy All
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete Dialog ── */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="border" style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: "var(--ui-text-primary)" }}>Delete content?</AlertDialogTitle>
            <AlertDialogDescription style={{ color: "var(--ui-text-muted)" }}>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border hover:opacity-80" style={{ borderColor: "var(--ui-btn-border)", background: "transparent", color: "var(--ui-text-secondary)" }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700 text-white">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── OpenAI Key Dialog ── */}
      <Dialog open={showOpenAIDialog} onOpenChange={setShowOpenAIDialog}>
        <DialogContent className="sm:max-w-md border" style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}>
          <DialogHeader>
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "hsl(38 92% 50% / 0.12)" }}>
              <Key className="h-5 w-5 text-amber-400" />
            </div>
            <DialogTitle className="text-center" style={{ color: "var(--ui-text-primary)" }}>OpenAI API Key Required</DialogTitle>
            <DialogDescription className="text-center" style={{ color: "var(--ui-text-muted)" }}>
              Add your OpenAI key to generate content
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <Input
              type="password"
              placeholder="sk-..."
              value={openAIKeyInput}
              onChange={(e) => setOpenAIKeyInput(e.target.value)}
              className="border-0 focus-visible:ring-cyan-500/50"
              style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
              onKeyDown={(e) => e.key === "Enter" && handleSaveOpenAIKey()}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveOpenAIKey}
                disabled={!openAIKeyInput.trim() || savingOpenAIKey}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}
              >
                {savingOpenAIKey && <Loader2 className="h-4 w-4 animate-spin" />}
                Save & Generate
              </button>
              <button
                onClick={() => { setShowOpenAIDialog(false); window.location.href = "/settings?tab=api-keys"; }}
                className="rounded-lg px-3 py-2.5 text-sm hover:opacity-80 transition-colors border"
                style={{ borderColor: "var(--ui-btn-border)", background: "transparent", color: "var(--ui-text-muted)" }}
              >
                Settings
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
