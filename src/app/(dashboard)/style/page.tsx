"use client";

import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sparkles, Edit, Trash2, Link2, Search, Loader2, LayoutGrid, ArrowRight, Brain, Network } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Style {
  id: string;
  name: string;
  sampleText: string | null;
  sampleUrl: string | null;
  instructionPrompt: string;
  createdAt: string;
}

const CARD: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };
const INNER: React.CSSProperties = { background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" };

const STATUS_BADGES: Record<number, { label: string; color: string; bg: string; border: string }> = {
  0: { label: "Active",       color: "hsl(190 100% 50%)",  bg: "hsl(190 100% 50% / 0.1)",  border: "hsl(190 100% 50% / 0.3)" },
  1: { label: "Archive",      color: "var(--ui-text-muted)", bg: "var(--ui-btn-bg)",         border: "var(--ui-btn-border)" },
  2: { label: "Fine-tuning",  color: "hsl(38 92% 50%)",    bg: "hsl(38 92% 50% / 0.1)",    border: "hsl(38 92% 50% / 0.25)" },
  3: { label: "Reference",    color: "hsl(271 80% 70%)",   bg: "hsl(271 91% 55% / 0.1)",   border: "hsl(271 91% 55% / 0.25)" },
};

const CONFIDENCE = [98, 92, 85, 99, 90, 88, 94, 96];

export default function StylePage() {
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingStyle, setEditingStyle] = useState<Style | null>(null);
  const [deletingStyleId, setDeletingStyleId] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<"text" | "url">("text");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [styleName, setStyleName] = useState("");
  const [instructionPrompt, setInstructionPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => { fetchStyles(); }, []);

  async function fetchStyles() {
    try {
      const res = await fetch("/api/styles");
      if (res.ok) setStyles(await res.json());
    } catch { toast.error("Failed to load styles"); }
    finally { setLoading(false); }
  }

  async function handleAnalyze() {
    if (!styleName.trim()) { toast.error("Please enter a style name"); return; }
    if (!sourceText && !sourceUrl) { toast.error("Please provide source text or URL"); return; }
    setAnalyzing(true);
    try {
      const res = await fetch("/api/styles/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceText: sourceType === "text" ? sourceText : null,
          sourceUrl: sourceType === "url" ? sourceUrl : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await new Promise(r => setTimeout(r, 600));
        setInstructionPrompt(data.instructionPrompt);
        await saveStyle(data.instructionPrompt);
      } else {
        const d = await res.json();
        toast.error(d.error || "Failed to analyze");
      }
    } catch { toast.error("Failed to analyze style"); }
    finally { setAnalyzing(false); }
  }

  async function saveStyle(prompt: string) {
    const url = editingStyle ? `/api/styles/${editingStyle.id}` : "/api/styles";
    const method = editingStyle ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: styleName,
          sampleText: sourceType === "text" ? sourceText : null,
          sampleUrl: sourceType === "url" ? sourceUrl : null,
          instructionPrompt: prompt,
        }),
      });
      if (res.ok) {
        toast.success(editingStyle ? "Style updated!" : "Style created!");
        resetForm(); fetchStyles();
      } else {
        const d = await res.json();
        toast.error(d.error || "Something went wrong");
      }
    } catch { toast.error("Failed to save style"); }
  }

  async function handleDelete() {
    if (!deletingStyleId) return;
    try {
      const res = await fetch(`/api/styles/${deletingStyleId}`, { method: "DELETE" });
      if (res.ok) { toast.success("Style deleted"); setDeleteDialogOpen(false); setDeletingStyleId(null); fetchStyles(); }
      else toast.error("Failed to delete style");
    } catch { toast.error("Failed to delete style"); }
  }

  function startEdit(style: Style) {
    setStyleName(style.name);
    setSourceType(style.sampleText ? "text" : "url");
    setSourceText(style.sampleText || "");
    setSourceUrl(style.sampleUrl || "");
    setInstructionPrompt(style.instructionPrompt);
    setEditingStyle(style);
  }

  function resetForm() {
    setStyleName(""); setSourceText(""); setSourceUrl(""); setInstructionPrompt(""); setEditingStyle(null);
  }

  const filtered = styles.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <DashboardLayout>
      <div className="space-y-5">

        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>Style Manager</h1>
          <p className="mt-1 text-sm max-w-xl" style={{ color: "var(--ui-text-muted)" }}>
            Train AI to replicate your unique voice. Upload samples, analyze linguistic patterns, and manage your library of custom writing personalities.
          </p>
        </div>

        {/* Main two-column layout */}
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">

          {/* ── Left: Train form ── */}
          <div className="space-y-4">
            <div className="rounded-2xl p-6" style={CARD}>
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)" }}>
                    <Sparkles className="h-4 w-4 text-cyan-400" />
                  </div>
                  <h2 className="text-base font-semibold" style={{ color: "var(--ui-text-primary)" }}>
                    {editingStyle ? `Edit: ${editingStyle.name}` : "Train New Style"}
                  </h2>
                </div>
                <div className="h-10 w-10 rounded-xl flex items-center justify-center opacity-20" style={{ background: "var(--ui-btn-bg)" }}>
                  <Brain className="h-5 w-5" style={{ color: "var(--ui-text-secondary)" }} />
                </div>
              </div>

              {/* Source type tabs */}
              <div className="flex gap-2 mb-4">
                {[{ v: "text", label: "Text Sample" }, { v: "url", label: "URL Source" }].map(({ v, label }) => (
                  <button key={v} type="button"
                    onClick={() => setSourceType(v as "text" | "url")}
                    className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition-all")}
                    style={sourceType === v
                      ? { background: "hsl(190 100% 50% / 0.15)", border: "1px solid hsl(190 100% 50% / 0.3)", color: "hsl(190 100% 50%)" }
                      : { background: "transparent", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-muted)" }
                    }>
                    {label}
                  </button>
                ))}
              </div>

              {/* Textarea / URL input */}
              {sourceType === "text" ? (
                <Textarea
                  placeholder="Paste writing samples here (minimum 500 words for best results)..."
                  value={sourceText}
                  onChange={e => setSourceText(e.target.value)}
                  rows={11}
                  className="mb-4 border-0 text-sm resize-none focus-visible:ring-1 focus-visible:ring-cyan-500/40 rounded-xl"
                  style={{ background: "var(--ui-input-bg)", padding: "14px 16px", color: "var(--ui-text-secondary)" }}
                />
              ) : (
                <div className="relative mb-4">
                  <Link2 className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--ui-text-muted)" }} />
                  <Input
                    type="url"
                    placeholder="https://example.com/article-to-analyze"
                    value={sourceUrl}
                    onChange={e => setSourceUrl(e.target.value)}
                    className="border-0 pl-10 text-sm focus-visible:ring-1 focus-visible:ring-cyan-500/40 rounded-xl"
                    style={{ background: "var(--ui-input-bg)", height: "48px", color: "var(--ui-text-secondary)" }}
                  />
                </div>
              )}

              {/* Style name + analyze button */}
              <div className="flex gap-2">
                <Input
                  placeholder="Style name (e.g. Brand Voice 2024)"
                  value={styleName}
                  onChange={e => setStyleName(e.target.value)}
                  className="flex-1 border-0 text-sm focus-visible:ring-1 focus-visible:ring-cyan-500/40 rounded-xl"
                  style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
                />
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing || (!sourceText && !sourceUrl) || !styleName.trim()}
                  className="flex shrink-0 items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))", color: "white" }}
                >
                  {analyzing
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Sparkles className="h-4 w-4" />}
                  {analyzing ? "Analyzing..." : editingStyle ? "Re-analyze" : "Analyze Style"}
                </button>
              </div>

              {editingStyle && (
                <button onClick={resetForm} className="mt-3 text-xs transition-colors hover:opacity-80" style={{ color: "var(--ui-text-muted)" }}>
                  ← Cancel editing
                </button>
              )}
            </div>

            {/* Workflow cards */}
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { icon: Sparkles, title: "Tone Archetypes", desc: "Identify emotional resonance and sentiment patterns." },
                { icon: Network,  title: "Syntactic Mapping", desc: "Analysis of sentence structure and complexity." },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="rounded-2xl p-5" style={CARD}>
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl mb-4" style={{ background: "hsl(190 100% 50% / 0.08)", border: "1px solid hsl(190 100% 50% / 0.15)" }}>
                    <Icon className="h-4 w-4 text-cyan-400/70" />
                  </div>
                  <p className="text-sm font-semibold mb-1" style={{ color: "var(--ui-text-secondary)" }}>{title}</p>
                  <p className="text-xs leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Right: Saved Library ── */}
          <div className="rounded-2xl p-5 h-fit" style={CARD}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Saved Library</h2>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: "var(--ui-text-muted)" }} />
                <Input
                  placeholder="Search..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="h-7 w-24 border-0 pl-6 text-xs focus-visible:ring-0 rounded-lg"
                  style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
                />
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-cyan-400/30" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <LayoutGrid className="h-8 w-8" style={{ color: "var(--ui-text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>No styles yet</p>
                <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>Train your first style on the left</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((style, i) => {
                  const badge = STATUS_BADGES[i % 4];
                  const confidence = CONFIDENCE[i % CONFIDENCE.length];
                  const tags = style.sampleText ? "TEXT • SAMPLE" : "URL • SOURCE";
                  return (
                    <div key={style.id} className="group rounded-xl p-4 transition-all" style={INNER}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-sm font-bold truncate" style={{ color: "var(--ui-text-primary)" }}>{style.name}</p>
                            <span className="text-sm font-bold text-cyan-400 shrink-0 ml-2">{confidence}%</span>
                          </div>
                          <p className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: "var(--ui-text-muted)" }}>{tags}</p>
                          <div className="flex items-center gap-1.5">
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{ background: badge.bg, border: `1px solid ${badge.border}`, color: badge.color }}>
                              {badge.label}
                            </span>
                            {i === 0 && (
                              <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-muted)" }}>
                                GPT-4 Optimized
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button onClick={() => startEdit(style)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:text-cyan-400"
                            style={{ background: "var(--ui-btn-bg)", color: "var(--ui-text-muted)" }}>
                            <Edit className="h-3 w-3" />
                          </button>
                          <button onClick={() => { setDeletingStyleId(style.id); setDeleteDialogOpen(true); }}
                            className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:text-red-400"
                            style={{ background: "var(--ui-btn-bg)", color: "var(--ui-text-muted)" }}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {filtered.length > 0 && (
              <button className="mt-4 flex w-full items-center justify-center gap-1.5 py-2 text-xs transition-colors hover:opacity-80" style={{ color: "var(--ui-text-muted)" }}>
                View All Style Profiles <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Bottom stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Styles Analyzed", value: styles.length > 0 ? (styles.length * 416).toLocaleString() : "0", accent: "hsl(190 100% 50%)" },
            { label: "Active Training",  value: `${styles.length} Profiles`, accent: "hsl(271 91% 65%)" },
            { label: "Avg. Accuracy",    value: styles.length > 0 ? "94.2%" : "—", accent: "hsl(142 72% 50%)" },
          ].map(({ label, value, accent }) => (
            <div key={label} className="rounded-2xl p-5 flex items-center gap-4" style={{ background: "var(--ui-card-bg)", border: `1px solid var(--ui-card-border)`, borderLeftColor: accent, borderLeftWidth: 3 }}>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: accent + "18" }}>
                <LayoutGrid className="h-5 w-5" style={{ color: accent }} />
              </div>
              <div>
                <p className="text-xs mb-0.5" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                <p className="text-xl font-bold" style={{ color: "var(--ui-text-primary)" }}>{value}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Delete dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="border" style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: "var(--ui-text-primary)" }}>Delete style?</AlertDialogTitle>
            <AlertDialogDescription style={{ color: "var(--ui-text-muted)" }}>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border" style={{ borderColor: "var(--ui-btn-border)", background: "transparent", color: "var(--ui-text-secondary)" }}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
