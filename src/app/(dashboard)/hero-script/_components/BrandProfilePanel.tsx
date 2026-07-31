"use client";

// BrandProfilePanel — the Hero Script "Setup rail" (UI spec step 1):
// BrandProfile picker + create/edit dialog (manual form + analyze-from-sample
// tab) + Niche Drill-down, and the duration select (30/60/90 วิ). This is the
// Task 1 vertical slice; later Hero Script tasks mount steps 2-5 (topic, hook,
// full script, send-to-editor) alongside it in page.tsx.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Lock, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { limitsForPlan, PLAN_LABEL } from "@/lib/plan-limits";
import { CTA_STYLES } from "@/lib/viral-frameworks";
import { BRAND_PROFILE_CAPS } from "@/lib/brand-profile-limits";

const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";

// 429 quota copy — exact Thai string from the shared spec's "Quota/error states" table.
const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

export interface BrandProfile {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  bannedWords: string[];
  ctaStyle: string;
  language: string;
  sampleText: string | null;
  sampleUrl: string | null;
  analysisNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NicheIdea {
  niche: string;
  why: string;
  audience: string;
  sampleTopics: [string, string];
}

const DURATIONS = [30, 60, 90] as const;
export type DurationSec = (typeof DURATIONS)[number];

interface BrandProfilePanelProps {
  plan: string;
  selectedProfileId: string | null;
  onSelectedProfileIdChange: (id: string | null) => void;
  durationSec: DurationSec;
  onDurationSecChange: (sec: DurationSec) => void;
}

async function toastErrorResponse(res: Response, fallback: string) {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 429) { toast.error(QUOTA_MESSAGE); return; }
  if (res.status === 409 && data?.code === "KEY_REQUIRED") {
    toast.error("ยังไม่ได้ตั้งค่า Gemini API key — ไปที่ Settings เพื่อเพิ่มคีย์");
    return;
  }
  toast.error(data?.error || fallback);
}

// `analysisNotes` (+ the sample it came from) are carried in the form, not just
// shown: they are what the analyze step is FOR — the server renders
// analysisNotes into the brand block of every later prompt (buildBrandBlock),
// so dropping them client-side left the column NULL and the block reading
// "ไม่มี" forever, i.e. the analyze feature bought the user nothing.
const emptyForm = {
  name: "", niche: "", audience: "", tone: "", bannedWordsText: "", ctaStyle: "follow",
  analysisNotes: "", analyzedSampleText: "", analyzedSampleUrl: "",
};

export function BrandProfilePanel({
  plan, selectedProfileId, onSelectedProfileIdChange, durationSec, onDurationSecChange,
}: BrandProfilePanelProps) {
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTab, setFormTab] = useState<"manual" | "analyze">("manual");
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const [sampleText, setSampleText] = useState("");
  const [sampleUrl, setSampleUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);

  const [drilldownOpen, setDrilldownOpen] = useState(false);
  const [nicheLoading, setNicheLoading] = useState(false);
  const [nicheCards, setNicheCards] = useState<NicheIdea[]>([]);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const cap = limitsForPlan(plan).brandProfiles;
  const atCap = profiles.length >= cap;
  const planLabel = PLAN_LABEL[plan] ?? plan;
  const capLabel = Number.isFinite(cap) ? String(cap) : "ไม่จำกัด";
  // Verbatim from the API contracts table's 403 PROFILE_LIMIT message.
  const upsellMessage = `แผน ${planLabel} เซฟนิชได้ ${capLabel} โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช`;

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/brand-profiles");
      if (res.ok) {
        const data = await res.json();
        setProfiles(Array.isArray(data) ? data : []);
      }
    } catch {
      toast.error("โหลดโปรไฟล์แบรนด์ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  function resetDialog() {
    setForm(emptyForm);
    setSampleText("");
    setSampleUrl("");
    setFormTab("manual");
    setEditingId(null);
    setNicheCards([]);
  }

  function openCreateDialog() {
    if (atCap) return;
    resetDialog();
    setDialogOpen(true);
  }

  function openEditDialog(p: BrandProfile) {
    setForm({
      name: p.name, niche: p.niche, audience: p.audience, tone: p.tone,
      bannedWordsText: p.bannedWords.join(", "),
      ctaStyle: p.ctaStyle || "follow",
      // Carried through an edit so a PUT never silently drops what analyze found.
      analysisNotes: p.analysisNotes ?? "",
      analyzedSampleText: p.sampleText ?? "",
      analyzedSampleUrl: p.sampleUrl ?? "",
    });
    setEditingId(p.id);
    setFormTab("manual");
    setDialogOpen(true);
  }

  async function handleAnalyze() {
    if (!sampleText.trim() && !sampleUrl.trim()) {
      toast.error("กรุณาใส่ตัวอย่างข้อความหรือ URL");
      return;
    }
    setAnalyzing(true);
    try {
      // Exactly what the server analyzed: text wins over URL, and the text is
      // truncated to the same bound the route applies before prompting.
      const usedText = sampleText.trim().slice(0, BRAND_PROFILE_CAPS.longFieldChars);
      const usedUrl = usedText ? "" : sampleUrl.trim().slice(0, BRAND_PROFILE_CAPS.urlChars);
      const res = await fetch("/api/brand-profiles/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sampleText: usedText || undefined,
          sampleUrl: usedUrl || undefined,
        }),
      });
      if (!res.ok) { await toastErrorResponse(res, "วิเคราะห์ไม่สำเร็จ"); return; }
      const data = await res.json();
      setForm((f) => ({
        ...f,
        niche: data.niche,
        audience: data.audience,
        tone: data.tone,
        // Persisted with the profile — this is the brand block's style note.
        analysisNotes: typeof data.analysisNotes === "string"
          ? data.analysisNotes.slice(0, BRAND_PROFILE_CAPS.longFieldChars)
          : "",
        analyzedSampleText: usedText,
        analyzedSampleUrl: usedUrl,
      }));
      setFormTab("manual");
      toast.success("วิเคราะห์เสร็จแล้ว ตรวจสอบและแก้ไขได้ก่อนบันทึก");
    } catch {
      toast.error("วิเคราะห์ไม่สำเร็จ");
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleDrilldown(seed: string) {
    if (!seed.trim()) { toast.error("กรุณาระบุเรื่องที่สนใจ"); return; }
    setNicheLoading(true);
    try {
      const res = await fetch("/api/brand-profiles/niche-ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: seed.trim() }),
      });
      if (!res.ok) { await toastErrorResponse(res, "ขุดนิชไม่สำเร็จ"); return; }
      const data = await res.json();
      setNicheCards(Array.isArray(data.niches) ? data.niches : []);
      setDrilldownOpen(true);
    } catch {
      toast.error("ขุดนิชไม่สำเร็จ");
    } finally {
      setNicheLoading(false);
    }
  }

  function selectNicheCard(card: NicheIdea) {
    // เลือกแล้วเติม niche+audience ให้อัตโนมัติ (แก้ต่อได้) — ปุ่ม "ขุดนิชให้ลึกกว่านี้"
    // ข้างช่อง niche ใช้ค่านี้เป็น seed ครั้งถัดไป เพื่อขุดซ้ำลงลึกอีกชั้นได้.
    setForm((f) => ({ ...f, niche: card.niche, audience: card.audience }));
    setDrilldownOpen(false);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.niche.trim() || !form.audience.trim() || !form.tone.trim()) {
      toast.error("กรุณากรอกชื่อ, นิช, กลุ่มเป้าหมาย และโทนเสียงให้ครบ");
      return;
    }
    setSaving(true);
    try {
      const bannedWords = form.bannedWordsText
        .split(/[,\n]/)
        .map((w) => w.trim())
        .filter(Boolean);
      const url = editingId ? `/api/brand-profiles/${editingId}` : "/api/brand-profiles";
      const method = editingId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          niche: form.niche.trim(),
          audience: form.audience.trim(),
          tone: form.tone.trim(),
          bannedWords,
          ctaStyle: form.ctaStyle,
          // Omitted (undefined) when there is nothing from analyze: PUT is
          // skip-if-absent, so an edit never wipes a stored note.
          analysisNotes: form.analysisNotes.trim() || undefined,
          sampleText: form.analyzedSampleText.trim() || undefined,
          sampleUrl: form.analyzedSampleUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          const data = await res.json().catch(() => null);
          toast.error(data?.error || upsellMessage);
        } else {
          await toastErrorResponse(res, "บันทึกโปรไฟล์ไม่สำเร็จ");
        }
        return;
      }
      const saved = await res.json();
      toast.success(editingId ? "อัปเดตโปรไฟล์แล้ว" : "สร้างโปรไฟล์แล้ว");
      setDialogOpen(false);
      resetDialog();
      await fetchProfiles();
      if (!editingId) onSelectedProfileIdChange(saved.id);
    } catch {
      toast.error("บันทึกโปรไฟล์ไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/brand-profiles/${deleteId}`, { method: "DELETE" });
      if (!res.ok) { await toastErrorResponse(res, "ลบโปรไฟล์ไม่สำเร็จ"); return; }
      toast.success("ลบโปรไฟล์แล้ว");
      if (selectedProfileId === deleteId) onSelectedProfileIdChange(null);
      await fetchProfiles();
    } catch {
      toast.error("ลบโปรไฟล์ไม่สำเร็จ");
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  const showManualForm = editingId != null || formTab === "manual";

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ตั้งค่าเริ่มต้น</h2>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Profile picker */}
        <div>
          <Label className="mb-1.5 block text-xs" style={{ color: "var(--ui-text-secondary)" }}>โปรไฟล์แบรนด์</Label>
          <Select
            value={selectedProfileId ?? "none"}
            onValueChange={(v) => onSelectedProfileIdChange(v === "none" ? null : v)}
          >
            <SelectTrigger className="min-h-11">
              <SelectValue placeholder="เลือกโปรไฟล์แบรนด์" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">ไม่ใช้โปรไฟล์</SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Duration */}
        <div>
          <Label className="mb-1.5 block text-xs" style={{ color: "var(--ui-text-secondary)" }}>ความยาว</Label>
          <Select
            value={String(durationSec)}
            onValueChange={(v) => onDurationSecChange(Number(v) as DurationSec)}
          >
            <SelectTrigger className="min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>{d} วิ</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Profile list + actions */}
      <div className="mt-4 space-y-2">
        {loading ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังโหลด...
          </div>
        ) : profiles.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีโปรไฟล์แบรนด์</p>
        ) : (
          profiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: selectedProfileId === p.id ? VIOLET : "var(--ui-card-border)",
                background: selectedProfileId === p.id ? "rgba(139,92,246,.08)" : "transparent",
              }}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelectedProfileIdChange(p.id)}
              >
                <p className="truncate font-medium" style={{ color: "var(--ui-text-primary)" }}>{p.name}</p>
                <p className="truncate" style={{ color: "var(--ui-text-muted)" }}>{p.niche}</p>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {/* 44x44 hit area (was p-1.5 ≈ 26px) — icon-only buttons need the full touch target, not just the visible glyph */}
                <button onClick={() => openEditDialog(p)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5" aria-label="แก้ไข">
                  <Pencil className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
                </button>
                <button onClick={() => setDeleteId(p.id)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5" aria-label="ลบ">
                  <Trash2 className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create button (locked at cap with upsell) */}
      <div className="mt-4">
        {atCap ? (
          <div className="rounded-lg border px-3 py-2.5 text-xs" style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-muted)" }}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>{upsellMessage}</span>
            </div>
            <Link href="/pricing" className="font-medium underline" style={{ color: VIOLET_LIGHT }}>ดูแผนราคา</Link>
          </div>
        ) : (
          <Button onClick={openCreateDialog} size="sm" className="min-h-11 w-full gap-1.5 text-white sm:w-auto" style={{ background: VIOLET }}>
            <Plus className="h-3.5 w-3.5" /> สร้างโปรไฟล์แบรนด์
          </Button>
        )}
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetDialog(); }}>
        {/* max-h + overflow so the full form (name/niche/audience/tone/banned words/CTA)
            never gets clipped below the viewport on short mobile screens (iPhone SE etc). */}
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "แก้ไขโปรไฟล์แบรนด์" : "สร้างโปรไฟล์แบรนด์"}</DialogTitle>
          </DialogHeader>

          {!editingId && (
            <div className="flex gap-1 rounded-lg p-1" style={{ background: "var(--ui-btn-bg)" }}>
              <button
                type="button"
                onClick={() => setFormTab("manual")}
                className="min-h-11 flex-1 rounded-md py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: formTab === "manual" ? VIOLET : "transparent",
                  color: formTab === "manual" ? "#fff" : "var(--ui-text-secondary)",
                }}
              >
                กรอกเอง
              </button>
              <button
                type="button"
                onClick={() => setFormTab("analyze")}
                className="min-h-11 flex-1 rounded-md py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: formTab === "analyze" ? VIOLET : "transparent",
                  color: formTab === "analyze" ? "#fff" : "var(--ui-text-secondary)",
                }}
              >
                วิเคราะห์จากตัวอย่าง
              </button>
            </div>
          )}

          {!showManualForm ? (
            <div className="space-y-3">
              <div>
                <Label className="mb-1.5 block text-xs">ข้อความตัวอย่าง</Label>
                <Textarea
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                  rows={5}
                  placeholder="วางข้อความตัวอย่างคอนเทนต์ของคุณ..."
                />
              </div>
              <div className="text-center text-xs" style={{ color: "var(--ui-text-muted)" }}>หรือ</div>
              <div>
                <Label className="mb-1.5 block text-xs">URL ตัวอย่าง</Label>
                <Input
                  value={sampleUrl}
                  onChange={(e) => setSampleUrl(e.target.value)}
                  placeholder="https://..."
                  disabled={!!sampleText.trim()}
                />
              </div>
              <Button onClick={handleAnalyze} disabled={analyzing} className="min-h-11 w-full gap-1.5 text-white" style={{ background: VIOLET }}>
                {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                วิเคราะห์
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label className="mb-1.5 block text-xs">ชื่อโปรไฟล์</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="เช่น ช่องการเงิน" />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <Label className="text-xs">นิชเจาะลึก</Label>
                  <Button
                    type="button" variant="ghost" size="sm"
                    onClick={() => handleDrilldown(form.niche)}
                    disabled={nicheLoading}
                    className="min-h-11 gap-1 px-2 text-[11px]"
                    style={{ color: VIOLET_LIGHT }}
                  >
                    {nicheLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    ขุดนิชให้ลึกกว่านี้
                  </Button>
                </div>
                <Input
                  value={form.niche}
                  onChange={(e) => setForm((f) => ({ ...f, niche: e.target.value }))}
                  placeholder="เช่น การเงินสาย dark เล่ากลโกงและคดีดัง"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">กลุ่มเป้าหมาย</Label>
                <Input value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))} placeholder="เช่น มนุษย์เงินเดือน 25-35" />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">โทนเสียง</Label>
                <Input value={form.tone} onChange={(e) => setForm((f) => ({ ...f, tone: e.target.value }))} placeholder="เช่น เป็นกันเอง ขี้เล่น มีสาระ" />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">คำต้องห้าม (คั่นด้วยจุลภาค)</Label>
                <Textarea
                  value={form.bannedWordsText}
                  onChange={(e) => setForm((f) => ({ ...f, bannedWordsText: e.target.value }))}
                  rows={2}
                  placeholder="เช่น โกหก, หลอกลวง"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">สไตล์ CTA</Label>
                <Select
                  value={form.ctaStyle}
                  onValueChange={(v) => setForm((f) => ({ ...f, ctaStyle: v }))}
                >
                  <SelectTrigger className="min-h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CTA_STYLES.map((c) => (
                      <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
                  {CTA_STYLES.find((c) => c.key === form.ctaStyle)?.description}
                </p>
              </div>
            </div>
          )}

          {showManualForm && (
            <DialogFooter>
              <Button variant="outline" className="min-h-11" onClick={() => setDialogOpen(false)}>ยกเลิก</Button>
              <Button onClick={handleSave} disabled={saving} className="min-h-11 gap-1.5 text-white" style={{ background: VIOLET }}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                บันทึก
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Niche drill-down cards */}
      <Dialog open={drilldownOpen} onOpenChange={setDrilldownOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>เลือกนิชเจาะลึก</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto sm:grid-cols-2">
            {nicheCards.map((card, i) => (
              <button
                key={i}
                type="button"
                onClick={() => selectNicheCard(card)}
                className={cn("rounded-lg border p-3 text-left text-xs transition-colors hover:border-violet-400")}
                style={{ borderColor: "var(--ui-card-border)" }}
              >
                <p className="mb-1 font-semibold" style={{ color: "var(--ui-text-primary)" }}>{card.niche}</p>
                <p className="mb-1" style={{ color: "var(--ui-text-secondary)" }}>{card.why}</p>
                <p className="mb-1.5" style={{ color: "var(--ui-text-muted)" }}>คนดู: {card.audience}</p>
                <ul className="space-y-0.5" style={{ color: "var(--ui-text-muted)" }}>
                  {card.sampleTopics.map((t, ti) => <li key={ti}>• {t}</li>)}
                </ul>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ลบโปรไฟล์แบรนด์นี้?</AlertDialogTitle>
            <AlertDialogDescription>การลบไม่สามารถย้อนกลับได้</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={confirmDelete} disabled={deleting}>ลบ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
