"use client";

// BrandProfilePanel v2 — compact Editor-v2-style control strip:
//   - Controlled searchable Brand Popover (auto-closes on select, Escape, or
//     outside click — fixes the stuck-<details> bug).
//   - Truthful rev 1+ vs rev 0 boundary: published profiles show a direct
//     "แก้ในหน้าแบรนด์ ↗" link instead of opening a modal that 409s on submit;
//     legacy rev-0 profiles retain full inline edit + archive.
//   - Zero-brand fast-start: Quick Style Presets strip shown when no Brand
//     Profile is selected so 0-brand users can start writing in 3 seconds.
//   - Inline Duration (30/60/90 วิ), Story Structure, and CTA Style selectors.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  Sparkles,
  SwatchBook,
  Trash2,
} from "lucide-react";
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
import { CTA_STYLES, STORY_STRUCTURES } from "@/lib/viral-frameworks";
import { BRAND_PROFILE_CAPS } from "@/lib/brand-profile-limits";
import {
  HERO_SCRIPT_QUICK_PRESETS,
  getQuickStylePreset,
} from "@/lib/hero-script-presets";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";

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
  activeRevisionNumber?: number;
  frozenAt?: string | null;
  isVersioned?: boolean;
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

export interface BrandProfilePanelHandle {
  openCreateDialog: () => void;
}

interface BrandProfilePanelProps {
  plan: string;
  selectedProfileId: string | null;
  onSelectedProfileIdChange: (id: string | null) => void;
  stylePreset: string | null;
  onStylePresetChange: (presetKey: string | null) => void;
  durationSec: DurationSec;
  onDurationSecChange: (sec: DurationSec) => void;
  preferredStructure: string | null;
  onPreferredStructureChange: (structure: string | null) => void;
  ctaStyleOverride: string | null;
  onCtaStyleOverrideChange: (ctaStyle: string | null) => void;
  onProfilesChange?: (profiles: BrandProfile[]) => void;
}

function isProfileVersioned(profile: BrandProfile): boolean {
  if (typeof profile.isVersioned === "boolean") return profile.isVersioned;
  if (typeof profile.activeRevisionNumber === "number" && profile.activeRevisionNumber > 0) return true;
  if (profile.frozenAt) return true;
  return false;
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

const emptyForm = {
  name: "", niche: "", audience: "", tone: "", bannedWordsText: "", ctaStyle: "follow",
  analysisNotes: "", analyzedSampleText: "", analyzedSampleUrl: "",
};

export const BrandProfilePanel = forwardRef<BrandProfilePanelHandle, BrandProfilePanelProps>(function BrandProfilePanel({
  plan,
  selectedProfileId,
  onSelectedProfileIdChange,
  stylePreset,
  onStylePresetChange,
  durationSec,
  onDurationSecChange,
  preferredStructure,
  onPreferredStructureChange,
  ctaStyleOverride,
  onCtaStyleOverrideChange,
  onProfilesChange,
}, ref) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileQuery, setProfileQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

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
  const upsellMessage = `แผน ${planLabel} เซฟนิชได้ ${capLabel} โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช`;

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/brand-profiles");
      if (res.ok) {
        const data = await res.json();
        const nextProfiles: BrandProfile[] = Array.isArray(data) ? data : [];
        setProfiles(nextProfiles);
        onProfilesChange?.(nextProfiles);
      }
    } catch {
      toast.error("โหลดโปรไฟล์แบรนด์ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [onProfilesChange]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  // Close searchable brand popover on outside pointerdown or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pickerOpen]);

  const resetDialog = useCallback(() => {
    setForm(emptyForm);
    setSampleText("");
    setSampleUrl("");
    setFormTab("manual");
    setEditingId(null);
    setNicheCards([]);
  }, []);

  const openCreateDialog = useCallback(() => {
    setPickerOpen(false);
    if (atCap) {
      toast.error(upsellMessage);
      return;
    }
    resetDialog();
    setDialogOpen(true);
  }, [atCap, resetDialog, upsellMessage]);

  useImperativeHandle(ref, () => ({ openCreateDialog }), [openCreateDialog]);

  function openEditDialog(p: BrandProfile) {
    setPickerOpen(false);
    setForm({
      name: p.name, niche: p.niche, audience: p.audience, tone: p.tone,
      bannedWordsText: p.bannedWords.join(", "),
      ctaStyle: p.ctaStyle || "follow",
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
          analysisNotes: form.analysisNotes.trim() || undefined,
          sampleText: form.analyzedSampleText.trim() || undefined,
          sampleUrl: form.analyzedSampleUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        if (res.status === 409) {
          const data = await res.json().catch(() => null) as { code?: string; error?: string; manageUrl?: string } | null;
          if (data?.code === "VERSIONED_PROFILE_READ_ONLY") {
            toast.error(data.error || "โปรไฟล์นี้แก้ไขจากหน้านี้ไม่ได้");
            router.push(data.manageUrl || "/brands");
            return;
          }
        }
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
      toast.success("นำโปรไฟล์ออกจากรายการแล้ว");
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
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const activePreset = !selectedProfile ? getQuickStylePreset(stylePreset) : null;
  const matchingProfiles = profiles.filter((profile) =>
    profile.name.toLocaleLowerCase().includes(profileQuery.trim().toLocaleLowerCase())
    || profile.niche.toLocaleLowerCase().includes(profileQuery.trim().toLocaleLowerCase()),
  );

  const defaultBrandCtaLabel = selectedProfile
    ? CTA_STYLES.find((c) => c.key === selectedProfile.ctaStyle)?.label
    : activePreset
      ? CTA_STYLES.find((c) => c.key === activePreset.defaultCtaStyle)?.label
      : null;
  const selectedStructureLabel = preferredStructure
    ? STORY_STRUCTURES.find((s) => s.key === preferredStructure)?.name ?? "อัตโนมัติ (AI เลือกให้)"
    : "อัตโนมัติ (AI เลือกให้)";
  const selectedCtaLabel = ctaStyleOverride
    ? CTA_STYLES.find((c) => c.key === ctaStyleOverride)?.label ?? "ฝากติดตาม (ค่าเริ่มต้น)"
    : defaultBrandCtaLabel
      ? `ตามสไตล์ (${defaultBrandCtaLabel})`
      : "ฝากติดตาม (ค่าเริ่มต้น)";

  return (
    <div
      className="rounded-2xl p-4 sm:p-5"
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      {/* ── Row 1: Brand/Style Popover + Duration Segmented Pills ── */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        {/* Brand Profile Controlled Searchable Popover */}
        <div ref={pickerRef} className="relative min-w-0">
          <Label className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            โปรไฟล์แบรนด์ / สไตล์
          </Label>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            aria-label="เลือกโปรไฟล์แบรนด์"
            onClick={() => setPickerOpen((open) => !open)}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
            style={{
              borderColor: selectedProfile || activePreset ? HS_COLOR.violetBorder : "var(--ui-card-border)",
              background: selectedProfile || activePreset ? HS_COLOR.violetSoft : "var(--ui-input-bg)",
              color: "var(--ui-text-primary)",
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <SwatchBook className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
              <span className="truncate font-medium">
                {selectedProfile
                  ? selectedProfile.name
                  : activePreset
                    ? `โทน: ${activePreset.label}`
                    : "โหมดทั่วไป (ไม่ใช้แบรนด์)"}
              </span>
            </span>
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 transition-transform duration-150", pickerOpen && "rotate-180")}
              style={{ color: "var(--ui-text-muted)" }}
              aria-hidden="true"
            />
          </button>

          {pickerOpen && (
            <div
              role="dialog"
              aria-label="เลือกหรือจัดการโปรไฟล์แบรนด์"
              className="absolute left-0 right-0 z-30 mt-2 rounded-xl border p-2.5 shadow-xl sm:min-w-[320px]"
              style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}
            >
              <div className="relative mb-2">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  style={{ color: "var(--ui-text-muted)" }}
                  aria-hidden="true"
                />
                <Input
                  value={profileQuery}
                  onChange={(event) => setProfileQuery(event.target.value)}
                  type="search"
                  placeholder="ค้นหาโปรไฟล์แบรนด์..."
                  aria-label="ค้นหาโปรไฟล์แบรนด์"
                  className="min-h-10 pl-8 text-sm"
                />
              </div>

              <div role="listbox" aria-label="เลือกโปรไฟล์แบรนด์" className="max-h-64 space-y-1 overflow-y-auto">
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedProfileId === null}
                  onClick={() => {
                    onSelectedProfileIdChange(null);
                    setPickerOpen(false);
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{
                    background: selectedProfileId === null ? HS_COLOR.violetSoft : "transparent",
                    color: "var(--ui-text-primary)",
                  }}
                >
                  <div className="min-w-0">
                    <span className="block truncate font-medium">ไม่ใช้โปรไฟล์ (เลือกพรีเซ็ตด่วนได้)</span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
                      เริ่มเขียนได้ทันทีโดยไม่ต้องตั้งค่าแบรนด์
                    </span>
                  </div>
                  {selectedProfileId === null && (
                    <Check className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
                  )}
                </button>

                {loading ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> กำลังโหลดโปรไฟล์...
                  </div>
                ) : matchingProfiles.length === 0 ? (
                  <p className="px-3 py-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
                    {profiles.length === 0 ? "ยังไม่มีโปรไฟล์แบรนด์ — ใช้พรีเซ็ตด่วนด้านล่างหรือสร้างใหม่ได้เลย" : "ไม่พบโปรไฟล์ที่ค้นหา"}
                  </p>
                ) : matchingProfiles.map((profile) => {
                  const versioned = isProfileVersioned(profile);
                  const isSelected = selectedProfileId === profile.id;
                  return (
                    <div
                      key={profile.id}
                      className="flex items-center gap-1 rounded-lg px-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                      style={{
                        background: isSelected ? HS_COLOR.violetSoft : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onSelectedProfileIdChange(profile.id);
                          setPickerOpen(false);
                        }}
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left text-sm"
                        style={{ color: "var(--ui-text-primary)" }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{profile.name}</span>
                            {versioned && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                                style={{ background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-muted)" }}
                              >
                                Brand Kit
                              </span>
                            )}
                          </div>
                          <span className="block truncate text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
                            {profile.niche}
                          </span>
                        </div>
                        {isSelected && (
                          <Check className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
                        )}
                      </button>

                      {versioned ? (
                        <Link
                          href="/brands"
                          onClick={() => setPickerOpen(false)}
                          className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ color: HS_COLOR.violet }}
                          aria-label={`แก้ ${profile.name} ในหน้าแบรนด์ของฉัน`}
                          title="แก้ในหน้าแบรนด์ของฉัน"
                        >
                          <span>แก้ในแบรนด์</span>
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      ) : (
                        <div className="flex shrink-0 items-center">
                          <button
                            type="button"
                            onClick={() => openEditDialog(profile)}
                            className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                            aria-label={`แก้ไข ${profile.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPickerOpen(false);
                              setDeleteId(profile.id);
                            }}
                            className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                            aria-label={`ลบ ${profile.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div
                className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5"
                style={{ borderColor: "var(--ui-divider)" }}
              >
                {atCap ? (
                  <div className="w-full rounded-lg border px-2.5 py-2 text-xs" style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-muted)" }}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <Lock className="h-3.5 w-3.5 shrink-0" />
                      <span>{upsellMessage}</span>
                    </div>
                    <Link href="/pricing" className="font-semibold underline" style={{ color: HS_COLOR.violet }}>
                      ดูแผนราคา
                    </Link>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={openCreateDialog}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-white transition hover:brightness-110"
                    style={{ background: HS_COLOR.violetGradient }}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    สร้างแบรนด์ด่วน
                  </button>
                )}
                <Link
                  href="/brands"
                  onClick={() => setPickerOpen(false)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:underline"
                  style={{ color: "var(--ui-text-secondary)" }}
                >
                  เปิดหน้าแบรนด์ของฉัน <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Duration Segmented Pills */}
        <div>
          <Label className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            ความยาวคลิป
          </Label>
          <div
            role="radiogroup"
            aria-label="ความยาวคลิป"
            className="inline-flex min-h-11 w-full items-center gap-1 rounded-xl border p-1 sm:w-auto"
            style={{ background: "var(--ui-input-bg)", borderColor: "var(--ui-card-border)" }}
          >
            {DURATIONS.map((d) => {
              const active = durationSec === d;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onDurationSecChange(d)}
                  className="min-h-9 flex-1 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-all sm:flex-initial"
                  style={{
                    background: active ? HS_COLOR.violetGradient : "transparent",
                    color: active ? "#ffffff" : "var(--ui-text-secondary)",
                    fontFamily: HS_FONT.heading,
                  }}
                >
                  {d} วิ
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Row 2: Story Structure & CTA Style Overrides (generous 50/50 width, zero Thai label clipping) ── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {/* Story Structure Override */}
        <div className="min-w-0">
          <Label className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            โครงเรื่อง
          </Label>
          <Select
            value={preferredStructure ?? "auto"}
            onValueChange={(value) => onPreferredStructureChange(value === "auto" ? null : value)}
          >
            <SelectTrigger aria-label="เลือกโครงเรื่อง" className="min-h-11 rounded-xl text-xs sm:text-sm">
              <SelectValue>{selectedStructureLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">อัตโนมัติ (AI เลือกให้)</SelectItem>
              {STORY_STRUCTURES.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* CTA Style Override */}
        <div className="min-w-0">
          <Label className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            สไตล์ CTA ปิดท้าย
          </Label>
          <Select
            value={ctaStyleOverride ?? "default"}
            onValueChange={(value) => onCtaStyleOverrideChange(value === "default" ? null : value)}
          >
            <SelectTrigger aria-label="เลือกสไตล์ CTA" className="min-h-11 rounded-xl text-xs sm:text-sm">
              <SelectValue>{selectedCtaLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                {defaultBrandCtaLabel ? `ตามสไตล์ (${defaultBrandCtaLabel})` : "ฝากติดตาม (ค่าเริ่มต้น)"}
              </SelectItem>
              {CTA_STYLES.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Row 2: Zero-Brand Quick Style Presets (shown when no Brand Profile is selected) ── */}
      {!selectedProfile && (
        <div
          className="mt-3.5 border-t pt-3.5"
          style={{ borderColor: "var(--ui-divider)" }}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
              <Sparkles className="h-3.5 w-3.5" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
              {profiles.length === 0
                ? "ยังไม่มีโปรไฟล์แบรนด์? เลือกโทนสำเร็จรูปแล้วเริ่มเขียนได้ทันที:"
                : "โทนสำเร็จรูป (ไม่ผูกแบรนด์):"}
            </span>
            {stylePreset && (
              <button
                type="button"
                onClick={() => onStylePresetChange(null)}
                className="text-[11px] font-medium hover:underline"
                style={{ color: "var(--ui-text-muted)" }}
              >
                ล้างโทน
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="โทนสำเร็จรูป">
            {HERO_SCRIPT_QUICK_PRESETS.map((preset) => {
              const active = stylePreset === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onStylePresetChange(active ? null : preset.key)}
                  title={preset.tagline}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  style={{
                    borderColor: active ? HS_COLOR.violetBorder : "var(--ui-card-border)",
                    background: active ? HS_COLOR.violetSoft : "transparent",
                    color: active ? HS_COLOR.violet : "var(--ui-text-secondary)",
                  }}
                >
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Selected Brand Context Summary Pill (compact, single line) ── */}
      {selectedProfile && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs"
          style={{ background: "var(--ui-card-bg-2)", color: "var(--ui-text-secondary)" }}
        >
          <span className="min-w-0 truncate">
            <strong style={{ color: "var(--ui-text-primary)" }}>{selectedProfile.niche}</strong>
            {selectedProfile.tone ? ` · โทน: ${selectedProfile.tone}` : ""}
          </span>
          {isProfileVersioned(selectedProfile) ? (
            <Link
              href="/brands"
              className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
              style={{ color: HS_COLOR.violet }}
            >
              แก้ในแบรนด์ของฉัน <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => openEditDialog(selectedProfile)}
              className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
              style={{ color: HS_COLOR.violet }}
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> แก้ไขโปรไฟล์นี้
            </button>
          )}
        </div>
      )}

      {/* Create/Edit dialog (legacy rev-0 edit + quick brand create) */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetDialog(); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "แก้ไขโปรไฟล์แบรนด์" : "สร้างโปรไฟล์แบรนด์ด่วน"}</DialogTitle>
          </DialogHeader>

          {!editingId && (
            <div className="flex gap-1 rounded-lg p-1" style={{ background: "var(--ui-btn-bg)" }}>
              <button
                type="button"
                onClick={() => setFormTab("manual")}
                className="min-h-11 flex-1 rounded-md py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: formTab === "manual" ? HS_COLOR.violet : "transparent",
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
                  background: formTab === "analyze" ? HS_COLOR.violet : "transparent",
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
              <Button
                onClick={handleAnalyze}
                disabled={analyzing}
                className="min-h-11 w-full gap-1.5 text-white"
                style={{ background: HS_COLOR.violetGradient }}
              >
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
                    style={{ color: HS_COLOR.violet }}
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
                <Label className="mb-1.5 block text-xs">บันทึกจากการวิเคราะห์</Label>
                <Textarea value={form.analysisNotes} onChange={(e) => setForm((f) => ({ ...f, analysisNotes: e.target.value }))} rows={2} placeholder="แนวทางเพิ่มเติมสำหรับการเขียน" />
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
              <Button
                onClick={handleSave}
                disabled={saving}
                className="min-h-11 gap-1.5 text-white"
                style={{ background: HS_COLOR.violetGradient }}
              >
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
            <AlertDialogTitle>นำโปรไฟล์แบรนด์ออกจากรายการ?</AlertDialogTitle>
            <AlertDialogDescription>โปรเจกต์และเวอร์ชันแบรนด์ที่เคยใช้งานจะยังคงอยู่ แต่แบรนด์นี้จะไม่แสดงสำหรับงานใหม่</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={confirmDelete} disabled={deleting}>นำออก</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
