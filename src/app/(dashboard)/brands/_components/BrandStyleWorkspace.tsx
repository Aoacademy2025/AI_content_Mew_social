"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import {
  ChevronDown,
  FileText,
  Film,
  ImageOff,
  Loader2,
  Mic,
  Palette,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Type,
  Upload,
  Wand2,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { BRAND_PROFILE_CAPS } from "@/lib/brand-profile-limits";
import { stylePackSample } from "@/lib/style-pack-samples";
import { MUSIC_MOODS, stylePack, type MusicMood } from "@/lib/style-pack-catalog";
import {
  DEFAULT_THEME_BRAND_CI,
  isMotionMascotId,
  isMotionThemeId,
  isNewMotionTheme,
  type MotionMascotId,
  type MotionThemeId,
} from "@/lib/motion-broll-catalog";
import { HEADLINE_HOOK_PRESETS, type HeadlineHookPreset } from "@/lib/headline-hook";
import { CTA_STYLES } from "@/lib/viral-frameworks";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { V2_ACCENT_COLORS, V2_TEXT_COLORS } from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import { GeminiVoiceStyleSelect } from "@/components/gemini-voice-style-select";
import { BrandBasicsForm } from "./BrandBasicsForm";
import { BrandColorPaletteEditor } from "./BrandColorPaletteEditor";
import { BrandLiveStage } from "./BrandLiveStage";
import { BrandVoicePicker } from "./BrandVoicePicker";
import { VisualFormatPicker } from "./VisualFormatPicker";
import {
  BRAND_SUBTITLE_FONTS,
  BRAND_SUBTITLE_QUICK_STYLES,
  HEADLINE_HOOK_PRESET_META,
  MOTION_MASCOT_META,
  MOTION_THEME_DISPLAY_ORDER,
  MOTION_THEME_META,
  MUSIC_MOOD_LABELS,
  TTS_SPEED_OPTIONS,
  VISUAL_MODE_OPTIONS,
  resolveEffectiveBrollSource,
} from "./brand-kit-constants";
import type { BrandPayload, LibraryResponse, VisualFormatId, VisualProposal } from "./types";

type StudioTab = "visual" | "audio" | "captions" | "script";

type NicheIdea = {
  niche: string;
  why: string;
  audience: string;
  sampleTopics: [string, string];
};

const STARTER_PACK_IDS: ReadonlyArray<BrandPayload["visual"]["stylePackId"]> = [
  "life-drama",
  "finance-clear",
  "health-simple",
  "comic-story",
];

const NO_SUBTITLE_PRESET = "__clip-default__";
const NO_BRAND_ASSET = "__none__";

const BRAND_MARK_POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["top-left", "บนซ้าย"],
  ["top-right", "บนขวา"],
  ["bottom-left", "ล่างซ้าย"],
  ["bottom-right", "ล่างขวา"],
];

function ProBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-violet-500/40 bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-violet-300",
        className,
      )}
    >
      PRO
    </span>
  );
}

function ToggleSwitch({
  id,
  checked,
  onCheckedChange,
  disabled,
  label,
  description,
  badge,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Label htmlFor={id} className="text-sm font-medium text-foreground">
            {label}
          </Label>
          {badge}
        </div>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-violet-600" : "bg-muted-foreground/35",
        )}
      >
        <span
          className={cn(
            "inline-block h-[18px] w-[18px] rounded-full bg-white transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

function ContextualAdvanced({
  id,
  open,
  onToggle,
  title,
  subtitle,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-muted/20">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{subtitle}</span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div id={id} className="space-y-5 border-t border-border bg-card/40 p-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function RangeSlider({
  id,
  label,
  suffix,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  suffix: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id} className="flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{suffix}</span>
      </Label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-violet-500 disabled:opacity-50"
      />
    </div>
  );
}

export function BrandStyleWorkspace({
  draft,
  rawDraft,
  setDraft,
  updateVisual,
  library,
  activeId = null,
  statusBadge,
  disabled,
  busy = null,
  proposal = null,
  allowElevenLabs = true,
  allowLogoExport = true,
  heroScriptAllowed = true,
  sourceProjectId = null,
  onSelect,
  onFormatChange,
  onAskHelper,
  onApplyProposal,
  onUploadBrandMark,
  renderAiPreviewSection,
}: {
  /** Resolved payload (with seed fallbacks) for honest preview & defaults. */
  draft: BrandPayload;
  /** Raw editable draft state (optional for standalone mobile fixture renders). */
  rawDraft?: BrandPayload;
  setDraft?: Dispatch<SetStateAction<BrandPayload>>;
  updateVisual?: <K extends keyof BrandPayload["visual"]>(
    key: K,
    value: BrandPayload["visual"][K],
  ) => void;
  library: LibraryResponse;
  activeId?: string | null;
  statusBadge?: string;
  disabled: boolean;
  busy?: string | null;
  proposal?: VisualProposal | null;
  allowElevenLabs?: boolean;
  allowLogoExport?: boolean;
  heroScriptAllowed?: boolean;
  sourceProjectId?: string | null;
  onSelect: (id: BrandPayload["visual"]["stylePackId"]) => void;
  onFormatChange: (id: VisualFormatId) => void;
  onAskHelper?: () => void;
  onApplyProposal?: (proposal: VisualProposal) => void;
  onUploadBrandMark?: (file: File) => void;
  renderAiPreviewSection?: () => React.ReactNode;
}) {
  const editable = rawDraft ?? draft;
  const [activeTab, setActiveTab] = useState<StudioTab>("visual");
  const [showAllPacks, setShowAllPacks] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [failedThumbIds, setFailedThumbIds] = useState<Record<string, boolean>>({});
  const [advancedTabOpen, setAdvancedTabOpen] = useState<Record<StudioTab, boolean>>({
    visual: false,
    audio: false,
    captions: false,
    script: false,
  });

  // Tab 4 Script DNA interactive helpers (Analyze + Niche Drilldown + Banned Words)
  const [analyzeInput, setAnalyzeInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMessage, setAnalyzeMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [nicheIdeas, setNicheIdeas] = useState<NicheIdea[]>([]);
  const [drillingNiches, setDrillingNiches] = useState(false);
  const [nicheError, setNicheError] = useState<string | null>(null);
  const [bannedWordInput, setBannedWordInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedPack = library.stylePacks.find((item) => item.id === draft.visual.stylePackId) ?? null;
  const fullSelectedPack = selectedPack ? stylePack(selectedPack.id) : null;
  const [lastPack, setLastPack] = useState(selectedPack);
  if (selectedPack && selectedPack.id !== lastPack?.id) setLastPack(selectedPack);
  const basePack = selectedPack ?? lastPack;

  const effectiveSource = resolveEffectiveBrollSource(draft.visual, draft.subtitle.config);
  const isMotionMode = effectiveSource === "motion";
  const activeMotionTheme: MotionThemeId = isMotionThemeId(draft.visual.motionThemeId)
    ? draft.visual.motionThemeId
    : isMotionThemeId(draft.subtitle.config?.motionThemeId)
      ? draft.subtitle.config.motionThemeId
      : "apple-bento-glass";
  const activeMotionMascot: MotionMascotId = isMotionMascotId(draft.visual.motionMascot)
    ? draft.visual.motionMascot
    : isMotionMascotId(draft.subtitle.config?.motionMascot)
      ? draft.subtitle.config.motionMascot
      : "stickman-scarf";

  const starters = [...STARTER_PACK_IDS, selectedPack?.id];
  const visiblePacks = showAllPacks
    ? library.stylePacks
    : library.stylePacks.filter((item) => starters.includes(item.id));

  const subtitleConfig = normalizeSubtitleStylePresetConfig(draft.subtitle.config)
    ?? fullSelectedPack?.subtitle
    ?? stylePack("life-drama").subtitle;
  const headlineEnabled = draft.videoDefaults?.headlineHookEnabled ?? Boolean(fullSelectedPack?.headlineHookPreset);
  const headlinePreset: HeadlineHookPreset = draft.videoDefaults?.headlineHookPreset
    ?? fullSelectedPack?.headlineHookPreset
    ?? "viral";
  const activeMusicMood: MusicMood | null = draft.videoDefaults?.musicMood ?? fullSelectedPack?.musicMood ?? null;
  const activeTtsSpeed = draft.voice.ttsSpeed ?? 1;
  const activeSfxMode = draft.videoDefaults?.sfxMode ?? (subtitleConfig.sfxMode === "subtle" ? "subtle" : "none");
  const activeBrollTransition = draft.videoDefaults?.brollTransition ?? fullSelectedPack?.brollTransition ?? "dissolve";

  function patchDraft(updater: (current: BrandPayload) => BrandPayload) {
    setDraft?.(updater);
  }

  function selectVisualMode(mode: "motion" | "stock" | "automix" | "kie-image") {
    patchDraft((current) => {
      const nextSubConfig = { ...current.subtitle.config };
      if (mode === "motion") {
        const theme: MotionThemeId = isMotionThemeId(current.visual.motionThemeId)
          ? current.visual.motionThemeId
          : isMotionThemeId(current.subtitle.config?.motionThemeId)
            ? current.subtitle.config.motionThemeId
            : "apple-bento-glass";
        const mascot: MotionMascotId = isMotionMascotId(current.visual.motionMascot)
          ? current.visual.motionMascot
          : isMotionMascotId(current.subtitle.config?.motionMascot)
            ? current.subtitle.config.motionMascot
            : "stickman-scarf";
        nextSubConfig.motionThemeId = theme;
        nextSubConfig.motionMascot = mascot;
        return {
          ...current,
          visual: {
            ...current.visual,
            defaultBrollSource: "motion",
            motionThemeId: theme,
            motionMascot: mascot,
          },
          subtitle: { ...current.subtitle, config: nextSubConfig },
        };
      }
      delete nextSubConfig.motionThemeId;
      delete nextSubConfig.motionMascot;
      return {
        ...current,
        visual: {
          ...current.visual,
          defaultBrollSource: mode,
          motionThemeId: null,
          motionMascot: null,
        },
        subtitle: { ...current.subtitle, config: nextSubConfig },
      };
    });
  }

  function selectMotionTheme(themeId: MotionThemeId) {
    patchDraft((current) => ({
      ...current,
      visual: {
        ...current.visual,
        defaultBrollSource: "motion",
        motionThemeId: themeId,
        motionMascot: current.visual.motionMascot ?? activeMotionMascot,
      },
      subtitle: {
        ...current.subtitle,
        config: {
          ...current.subtitle.config,
          motionThemeId: themeId,
          motionMascot: current.visual.motionMascot ?? activeMotionMascot,
        },
      },
    }));
  }

  function selectMotionMascot(mascot: MotionMascotId) {
    patchDraft((current) => ({
      ...current,
      visual: {
        ...current.visual,
        defaultBrollSource: "motion",
        motionThemeId: current.visual.motionThemeId ?? activeMotionTheme,
        motionMascot: mascot,
      },
      subtitle: {
        ...current.subtitle,
        config: {
          ...current.subtitle.config,
          motionThemeId: current.visual.motionThemeId ?? activeMotionTheme,
          motionMascot: mascot,
        },
      },
    }));
  }

  function updateSubtitleConfig(patch: Record<string, string | number | boolean | null>) {
    patchDraft((current) => ({
      ...current,
      subtitle: {
        ...current.subtitle,
        presetId: null,
        config: {
          ...current.subtitle.config,
          ...patch,
        },
      },
    }));
  }

  function updateVideoDefaults(patch: Partial<NonNullable<BrandPayload["videoDefaults"]>>) {
    patchDraft((current) => ({
      ...current,
      videoDefaults: {
        ...current.videoDefaults,
        ...patch,
      },
    }));
  }

  async function runScriptAnalyze() {
    const trimmed = analyzeInput.trim();
    if (!trimmed || analyzing) return;
    setAnalyzing(true);
    setAnalyzeMessage(null);
    const isUrl = /^https?:\/\//i.test(trimmed);
    try {
      const response = await fetch("/api/brand-profiles/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isUrl ? { sampleUrl: trimmed } : { sampleText: trimmed }),
      });
      const data = await response.json().catch(() => null) as {
        niche?: string;
        audience?: string;
        tone?: string;
        analysisNotes?: string;
        error?: string;
      } | null;
      if (!response.ok || !data?.niche) {
        throw new Error(data?.error || "วิเคราะห์สไตล์ไม่สำเร็จ กรุณาลองอีกครั้ง");
      }
      patchDraft((current) => ({
        ...current,
        niche: data.niche ?? current.niche,
        audience: data.audience ?? current.audience,
        script: {
          ...current.script,
          tone: data.tone ?? current.script.tone,
          analysisNotes: data.analysisNotes ?? current.script.analysisNotes,
          sampleText: isUrl ? current.script.sampleText : trimmed.slice(0, BRAND_PROFILE_CAPS.longFieldChars),
        },
      }));
      setAnalyzeMessage({ tone: "ok", text: "วิเคราะห์และเติม นิช กลุ่มเป้าหมาย โทน และโน้ตสไตล์ให้แล้ว — ตรวจแก้ได้ทันที" });
    } catch (error) {
      setAnalyzeMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "วิเคราะห์สไตล์ไม่สำเร็จ",
      });
    } finally {
      setAnalyzing(false);
    }
  }

  async function runNicheDrilldown() {
    const seed = editable.niche.trim() || draft.niche.trim();
    if (!seed || drillingNiches) return;
    setDrillingNiches(true);
    setNicheError(null);
    try {
      const response = await fetch("/api/brand-profiles/niche-ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed }),
      });
      const data = await response.json().catch(() => null) as { niches?: NicheIdea[]; error?: string } | null;
      if (!response.ok || !Array.isArray(data?.niches)) {
        throw new Error(data?.error || "ขุดนิชไม่สำเร็จ กรุณาลองอีกครั้ง");
      }
      setNicheIdeas(data.niches);
    } catch (error) {
      setNicheError(error instanceof Error ? error.message : "ขุดนิชไม่สำเร็จ");
    } finally {
      setDrillingNiches(false);
    }
  }

  function addBannedWord(raw: string) {
    const words = raw
      .split(/[,，\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!words.length) return;
    patchDraft((current) => {
      const existing = new Set(current.script.bannedWords);
      for (const word of words) {
        if (existing.size >= BRAND_PROFILE_CAPS.bannedWords) break;
        existing.add(word.slice(0, 60));
      }
      return {
        ...current,
        script: { ...current.script, bannedWords: [...existing] },
      };
    });
    setBannedWordInput("");
  }

  function removeBannedWord(word: string) {
    patchDraft((current) => ({
      ...current,
      script: {
        ...current.script,
        bannedWords: current.script.bannedWords.filter((item) => item !== word),
      },
    }));
  }

  const helperDisabled = disabled || busy !== null || !editable.niche.trim() || !editable.audience.trim();
  const proposedFormatLabel = proposal
    ? library.visualFormats.find((format) => format.id === proposal.primaryVisualFormatId)?.label
    : null;

  const tabs: ReadonlyArray<{ id: StudioTab; label: string; shortLabel: string; icon: React.ReactNode }> = [
    { id: "visual", label: "ภาพ & Motion", shortLabel: "ภาพ & Motion", icon: <Palette className="h-4 w-4" /> },
    { id: "audio", label: "เสียง & เพลง", shortLabel: "เสียง & เพลง", icon: <Mic className="h-4 w-4" /> },
    { id: "captions", label: "ซับ & พาดหัว", shortLabel: "ซับ & พาดหัว", icon: <Type className="h-4 w-4" /> },
    { id: "script", label: "Script DNA", shortLabel: "Script DNA", icon: <FileText className="h-4 w-4" /> },
  ];

  return (
    <div className="grid min-w-0 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_328px] xl:grid-cols-[minmax(0,1fr)_356px]">
      {/* Left: Brand Kit Studio Controls */}
      <div className="min-w-0 space-y-6 lg:order-first">
        {/* Always-visible inline Brand Name header */}
        <BrandBasicsForm
          name={editable.name}
          onNameChange={(value) => patchDraft((current) => ({ ...current, name: value }))}
          disabled={disabled}
          statusBadge={statusBadge}
        />

        {/* 4-Tab Studio Bar */}
        <div
          role="tablist"
          aria-label="หมวดตั้งค่าแบรนด์"
          className="grid grid-cols-2 gap-1.5 rounded-xl border border-border bg-muted/35 p-1.5 sm:grid-cols-4"
        >
          {tabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`brand-tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`brand-tabpanel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition-all sm:text-[13px]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
                  active
                    ? "bg-violet-600 text-white shadow-xs"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {tab.icon}
                <span className="truncate">{tab.shortLabel}</span>
              </button>
            );
          })}
        </div>

        {/* ── TAB 1: ภาพ & Motion ─────────────────────────────────────────── */}
        {activeTab === "visual" && (
          <div
            role="tabpanel"
            id="brand-tabpanel-visual"
            aria-labelledby="brand-tab-visual"
            className="space-y-6"
          >
            {/* 1A: 3 Visual Mode Cards */}
            <section className="space-y-2.5">
              <div>
                <p className="text-sm font-semibold text-foreground">แนวทางภาพเริ่มต้นของแบรนด์</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  กำหนดค่าเริ่มต้นให้คลิปใหม่ทุกชิ้น (เปลี่ยนรายคลิปได้ใน Video Editor)
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="แนวทางภาพเริ่มต้น">
                {VISUAL_MODE_OPTIONS.map((mode) => {
                  const selected = mode.id === "stock"
                    ? effectiveSource === "stock" || effectiveSource === "automix"
                    : effectiveSource === mode.id;
                  const showPro = mode.proOnly && !library.imageAccess.canUse;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      onClick={() => selectVisualMode(mode.id)}
                      className={cn(
                        "relative flex min-h-[84px] flex-col items-start justify-between gap-2 rounded-xl border p-3.5 text-left transition-all",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 disabled:opacity-50",
                        selected
                          ? "border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/35"
                          : "border-border bg-card hover:border-violet-500/40",
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                          {mode.id === "motion" ? (
                            <Wand2 className="h-4 w-4 text-violet-400" />
                          ) : mode.id === "stock" ? (
                            <Film className="h-4 w-4 text-violet-400" />
                          ) : (
                            <Sparkles className="h-4 w-4 text-violet-400" />
                          )}
                          {mode.title}
                        </span>
                        {showPro ? (
                          <ProBadge />
                        ) : (
                          <span className="shrink-0 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {mode.badge}
                          </span>
                        )}
                      </div>
                      <span className="text-xs leading-5 text-muted-foreground">{mode.desc}</span>
                    </button>
                  );
                })}
              </div>
              {effectiveSource === "stock" || effectiveSource === "automix" ? (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="text-xs text-muted-foreground">สัดส่วนในโหมดสต็อก:</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={effectiveSource === "stock"}
                    onClick={() => selectVisualMode("stock")}
                    className={cn(
                      "min-h-9 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      effectiveSource === "stock"
                        ? "border-violet-500 bg-violet-500/12 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    สต็อกฟรีล้วน · 0 เครดิต
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={effectiveSource === "automix"}
                    onClick={() => selectVisualMode("automix")}
                    className={cn(
                      "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      effectiveSource === "automix"
                        ? "border-violet-500 bg-violet-500/12 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span>AutoMix ผสมภาพ AI</span>
                    {!library.imageAccess.canUse ? <ProBadge /> : null}
                  </button>
                </div>
              ) : null}
            </section>

            {/* 1B: Motion Themes & Mascots OR Style Packs Grid */}
            {isMotionMode ? (
              <section className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">เลือกธีม Motion B-Roll (6 ธีม)</p>
                  <span className="text-xs text-muted-foreground">ดูผลสดบนจอพรีวิวทันที · 0 เครดิต</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {MOTION_THEME_DISPLAY_ORDER.map((themeId) => {
                    const meta = MOTION_THEME_META[themeId];
                    const ci = DEFAULT_THEME_BRAND_CI[themeId];
                    const selected = activeMotionTheme === themeId;
                    return (
                      <button
                        key={themeId}
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() => selectMotionTheme(themeId)}
                        className={cn(
                          "flex min-h-[88px] flex-col items-start justify-between gap-2 rounded-xl border p-3.5 text-left transition-all",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 disabled:opacity-50",
                          selected
                            ? "border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/35"
                            : "border-border bg-card hover:border-violet-500/40",
                        )}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{meta.shortLabel}</span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {isNewMotionTheme(themeId) ? (
                              <span className="rounded-full bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                                ใหม่
                              </span>
                            ) : null}
                            <span className="flex items-center gap-1" aria-hidden="true">
                              {[ci.backgroundColor, ci.primaryColor, ci.accentColor].map((hex, i) => (
                                <span
                                  key={`${themeId}-${i}`}
                                  className="h-2.5 w-2.5 rounded-full border border-white/25"
                                  style={{ backgroundColor: hex }}
                                />
                              ))}
                            </span>
                          </div>
                        </div>
                        <span className="text-xs leading-5 text-muted-foreground">{meta.tagline}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 4 Mascots */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground">ตัวละครประจำช่อง (Mascot)</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {MOTION_MASCOT_META.map((mascot) => {
                      const active = activeMotionMascot === mascot.id;
                      return (
                        <button
                          key={mascot.id}
                          type="button"
                          disabled={disabled}
                          aria-pressed={active}
                          onClick={() => selectMotionMascot(mascot.id)}
                          className={cn(
                            "flex min-h-12 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 disabled:opacity-50",
                            active
                              ? "border-violet-500 bg-violet-500/12 text-foreground"
                              : "border-border bg-card text-muted-foreground hover:border-violet-500/40 hover:text-foreground",
                          )}
                        >
                          <span className="text-xs font-semibold text-foreground">{mascot.label}</span>
                          <span className="text-[10.5px] text-muted-foreground">{mascot.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            ) : (
              <section className="space-y-3">
                <fieldset disabled={disabled} className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <legend className="text-sm font-semibold text-foreground">
                      ชุดสไตล์เริ่มต้น ({showAllPacks ? `ทั้งหมด ${library.stylePacks.length}` : "แนะนำ 4 สไตล์"})
                    </legend>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setShowAllPacks((prev) => !prev)}
                      className="h-9 px-2.5 text-xs text-violet-400 hover:text-violet-300"
                    >
                      {showAllPacks ? "แสดงสไตล์แนะนำ" : `ดูสไตล์ทั้งหมด (${library.stylePacks.length})`}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {visiblePacks.map((item) => {
                      const checked = item.id === selectedPack?.id;
                      const packSample = stylePackSample(item.id);
                      const thumbUrl = packSample?.imageUrl && !failedThumbIds[item.id] ? packSample.imageUrl : null;
                      return (
                        <label
                          key={item.id}
                          className={cn(
                            "flex min-h-[78px] cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all",
                            checked
                              ? "border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/35"
                              : "border-border bg-card hover:border-violet-500/40",
                            disabled && "cursor-not-allowed opacity-60",
                          )}
                        >
                          <input
                            type="radio"
                            name="brand-setup-style"
                            value={item.id}
                            checked={checked}
                            onChange={() => onSelect(item.id)}
                            className="sr-only"
                          />
                          <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                            {thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={thumbUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                onError={() => setFailedThumbIds((prev) => ({ ...prev, [item.id]: true }))}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                <ImageOff className="h-3.5 w-3.5" />
                              </div>
                            )}
                          </div>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-semibold text-foreground">{item.thaiLabel}</span>
                              <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                                {item.palette.map((hex, i) => (
                                  <span
                                    key={`${item.id}-${i}`}
                                    className="h-2.5 w-2.5 rounded-full border border-white/25"
                                    style={{ backgroundColor: hex }}
                                  />
                                ))}
                              </span>
                            </span>
                            <span className="mt-1 line-clamp-2 block text-xs leading-4 text-muted-foreground">
                              {item.tagline}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    aria-expanded={formatOpen}
                    aria-controls="brand-setup-format"
                    onClick={() => setFormatOpen((prev) => !prev)}
                    className="h-auto min-h-11 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {formatOpen ? "ซ่อนแนวภาพ" : "เลือกแนวภาพเอง (5 แนวภาพ)"}
                  </Button>
                </div>

                {formatOpen ? (
                  <div id="brand-setup-format" className="rounded-xl border border-border bg-card/50 p-4">
                    <VisualFormatPicker
                      formats={library.visualFormats}
                      value={draft.visual.primaryVisualFormatId}
                      onChange={onFormatChange}
                      disabled={disabled}
                    />
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      เปลี่ยนแค่แนวภาพ สี เสียง ซับ และจังหวะยังเป็นค่าจากชุดสไตล์เดิม
                    </p>
                  </div>
                ) : null}
              </section>
            )}

            {/* 1C: Brand CI 3-Color Palette */}
            <BrandColorPaletteEditor
              palette={editable.visual.palette}
              disabled={disabled}
              onChange={(nextPalette) => updateVisual?.("palette", nextPalette)}
            />

            {/* 1D: Quick Logo Watermark Bar */}
            <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">โลโก้ลายน้ำประจำแบรนด์</p>
                  {!allowLogoExport ? <ProBadge /> : null}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file && onUploadBrandMark) onUploadBrandMark(file);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || busy === "brand-mark"}
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-10 text-xs"
                >
                  {busy === "brand-mark" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  อัปโหลดโลโก้ (PNG/WebP)
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <Select
                  value={editable.brandMark.assetId ?? NO_BRAND_ASSET}
                  disabled={disabled}
                  onValueChange={(value) =>
                    patchDraft((current) => ({
                      ...current,
                      brandMark: {
                        ...current.brandMark,
                        assetId: value === NO_BRAND_ASSET ? null : value,
                        enabled: value !== NO_BRAND_ASSET ? true : false,
                      },
                    }))
                  }
                >
                  <SelectTrigger id="brand-mark-asset" className="h-10">
                    <SelectValue placeholder="เลือกไฟล์โลโก้" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BRAND_ASSET}>ไม่ใส่โลโก้ลายน้ำ</SelectItem>
                    {library.brandAssets.map((asset) => (
                      <SelectItem key={asset.id} value={asset.id}>
                        {asset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ToggleSwitch
                  id="brand-mark-enabled"
                  checked={editable.brandMark.enabled}
                  disabled={disabled || !editable.brandMark.assetId}
                  onCheckedChange={(checked) =>
                    patchDraft((current) => ({
                      ...current,
                      brandMark: { ...current.brandMark, enabled: checked },
                    }))
                  }
                  label="แสดงบนคลิป"
                />
              </div>
            </section>

            {/* 1E: Hero AI 3-Image Preview when in Hero AI Image mode or promoting a clip */}
            {(effectiveSource === "kie-image" || Boolean(sourceProjectId)) && renderAiPreviewSection
              ? renderAiPreviewSection()
              : null}

            {/* 1F: Contextual Advanced for Tab 1 */}
            <ContextualAdvanced
              id="brand-advanced-visual"
              open={advancedTabOpen.visual}
              onToggle={() => setAdvancedTabOpen((prev) => ({ ...prev, visual: !prev.visual }))}
              title="ปรับละเอียดเพิ่มเติม · ตำแหน่งโลโก้ แนวภาพ & ผู้ช่วย AI"
              subtitle="ขนาด/ความทึบโลโก้ บุคลิกภาพ แนวเล่าเรื่อง และ AI แนะนำโทนภาพ"
            >
              {/* Logo placement & size */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-foreground">ตำแหน่งและขนาดโลโก้ (อัปเดตสดบนจอ 9:16)</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {BRAND_MARK_POSITIONS.map(([posValue, posLabel]) => (
                    <button
                      key={posValue}
                      type="button"
                      disabled={disabled || !editable.brandMark.enabled}
                      onClick={() =>
                        patchDraft((current) => ({
                          ...current,
                          brandMark: {
                            ...current.brandMark,
                            position: posValue as BrandPayload["brandMark"]["position"],
                          },
                        }))
                      }
                      className={cn(
                        "min-h-10 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-45",
                        editable.brandMark.position === posValue
                          ? "border-violet-500 bg-violet-500/15 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {posLabel}
                    </button>
                  ))}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <RangeSlider
                    id="brand-mark-size"
                    label="ขนาดโลโก้"
                    suffix={`${editable.brandMark.sizePct}%`}
                    min={8}
                    max={30}
                    value={editable.brandMark.sizePct}
                    disabled={disabled || !editable.brandMark.enabled}
                    onChange={(sizePct) =>
                      patchDraft((current) => ({
                        ...current,
                        brandMark: { ...current.brandMark, sizePct },
                      }))
                    }
                  />
                  <RangeSlider
                    id="brand-mark-opacity"
                    label="ความทึบโลโก้"
                    suffix={`${Math.round(editable.brandMark.opacity * 100)}%`}
                    min={25}
                    max={100}
                    value={Math.round(editable.brandMark.opacity * 100)}
                    disabled={disabled || !editable.brandMark.enabled}
                    onChange={(pct) =>
                      patchDraft((current) => ({
                        ...current,
                        brandMark: { ...current.brandMark, opacity: pct / 100 },
                      }))
                    }
                  />
                </div>
              </div>

              {/* Visual personality, treatment policy, visual notes */}
              <div className="space-y-4 border-t border-border pt-4">
                <div>
                  <Label htmlFor="brand-visual-personality" className="text-xs font-semibold">
                    บุคลิกของภาพ
                  </Label>
                  <Input
                    id="brand-visual-personality"
                    value={editable.visual.personality}
                    onChange={(event) => updateVisual?.("personality", event.target.value)}
                    disabled={disabled}
                    maxLength={500}
                    placeholder="เช่น คมชัด สว่างสะอาดตา เงาละมุน"
                    className="mt-1.5 h-10"
                  />
                </div>

                <div>
                  <Label htmlFor="brand-treatment-policy" className="text-xs font-semibold">
                    แนวเล่าเรื่องของแต่ละคลิป
                  </Label>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    ค่าเริ่มต้นให้ AI อ่านเนื้อหาแล้วเลือกแนวเล่าเรื่องที่เหมาะกับคลิปนั้นให้อัตโนมัติ
                  </p>
                  <Select
                    value={editable.visual.treatmentPolicy}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (value === "adaptive") {
                        updateVisual?.("treatmentPolicy", "adaptive");
                        updateVisual?.("lockedTreatmentPresetId", null);
                      } else {
                        updateVisual?.("treatmentPolicy", "locked");
                        if (!editable.visual.lockedTreatmentPresetId) {
                          updateVisual?.("lockedTreatmentPresetId", library.treatmentPresets[0]?.id ?? null);
                        }
                      }
                    }}
                  >
                    <SelectTrigger id="brand-treatment-policy" className="mt-2 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adaptive">AI เลือกแนวเล่าเรื่องตามเนื้อหา</SelectItem>
                      <SelectItem value="locked">ใช้แนวเล่าเรื่องเดิมทุกคลิป</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {editable.visual.treatmentPolicy === "locked" ? (
                  <div>
                    <Label htmlFor="brand-locked-treatment" className="text-xs font-semibold">
                      แนวเล่าเรื่องที่ใช้ทุกคลิป
                    </Label>
                    <Select
                      value={editable.visual.lockedTreatmentPresetId ?? undefined}
                      disabled={disabled}
                      onValueChange={(value) =>
                        updateVisual?.(
                          "lockedTreatmentPresetId",
                          value as BrandPayload["visual"]["lockedTreatmentPresetId"],
                        )
                      }
                    >
                      <SelectTrigger id="brand-locked-treatment" className="mt-1.5 h-10">
                        <SelectValue placeholder="เลือกแนวเล่าเรื่อง" />
                      </SelectTrigger>
                      <SelectContent>
                        {library.treatmentPresets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div>
                  <Label htmlFor="brand-visual-notes" className="text-xs font-semibold">
                    โน้ตทิศทางภาพเพิ่มเติม
                  </Label>
                  <Textarea
                    id="brand-visual-notes"
                    value={editable.visual.visualNotes}
                    onChange={(event) => updateVisual?.("visualNotes", event.target.value)}
                    disabled={disabled}
                    rows={3}
                    maxLength={800}
                    placeholder="เช่น เน้นมุมกล้องใกล้ หลีกเลี่ยงพื้นหลังรก"
                    className="mt-1.5"
                  />
                </div>
              </div>

              {/* AI Visual Helper */}
              {onAskHelper ? (
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs font-semibold text-foreground">ผู้ช่วยออกแบบแนวภาพ (AI Suggest)</p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    AI เสนอสีและแนวภาพจากนิชและกลุ่มเป้าหมายให้ดูก่อน ไม่สร้างภาพและไม่ทับค่าเดิมจนกว่าคุณจะกดนำมาใช้
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onAskHelper}
                    disabled={helperDisabled}
                    className="h-10 text-xs"
                  >
                    {busy === "helper" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 text-violet-400" />
                    )}
                    ขอคำแนะนำแนวภาพจาก AI
                  </Button>
                  {proposal ? (
                    <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-3.5">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <WandSparkles className="h-3.5 w-3.5 text-violet-400" />
                        AI แนะนำ: {proposedFormatLabel}
                      </p>
                      {proposal.rationale ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{proposal.rationale}</p>
                      ) : null}
                      <Button
                        type="button"
                        variant="link"
                        onClick={() => onApplyProposal?.(proposal)}
                        disabled={disabled}
                        className="mt-1 h-auto p-0 text-xs text-violet-400"
                      >
                        นำคำแนะนำมาใส่ในร่าง
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Secondary AI 3-image preview if not already shown above */}
              {effectiveSource !== "kie-image" && !sourceProjectId && renderAiPreviewSection
                ? <div className="border-t border-border pt-4">{renderAiPreviewSection()}</div>
                : null}
            </ContextualAdvanced>
          </div>
        )}

        {/* ── TAB 2: เสียง & เพลง ─────────────────────────────────────────── */}
        {activeTab === "audio" && (
          <div
            role="tabpanel"
            id="brand-tabpanel-audio"
            aria-labelledby="brand-tab-audio"
            className="space-y-6"
          >
            <section className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-foreground">เสียงพากย์ประจำแบรนด์</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  เลือกผู้ให้บริการและลองฟังตัวอย่างเสียงได้ทันที
                </p>
              </div>
              <BrandVoicePicker
                value={editable.voice}
                disabled={disabled}
                allowElevenLabs={allowElevenLabs}
                onChange={(voice) => patchDraft((current) => ({ ...current, voice }))}
              />
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">อารมณ์เพลงประกอบ (Music Mood)</p>
                {activeMusicMood ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => updateVideoDefaults({ musicMood: null })}
                    className="text-xs text-violet-400 hover:underline"
                  >
                    ใช้ตามชุดสไตล์
                  </button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {MUSIC_MOODS.map((mood) => {
                  const selected = activeMusicMood === mood;
                  return (
                    <button
                      key={mood}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => updateVideoDefaults({ musicMood: mood })}
                      className={cn(
                        "min-h-10 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                        selected
                          ? "border-violet-500 bg-violet-500/15 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-violet-500/40 hover:text-foreground",
                      )}
                    >
                      {MUSIC_MOOD_LABELS[mood]}
                    </button>
                  );
                })}
              </div>
            </section>

            <ContextualAdvanced
              id="brand-advanced-audio"
              open={advancedTabOpen.audio}
              onToggle={() => setAdvancedTabOpen((prev) => ({ ...prev, audio: !prev.audio }))}
              title="ปรับละเอียดเพิ่มเติม · น้ำเสียง ความเร็ว & SFX"
              subtitle="โทนน้ำเสียง Gemini ความเร็วการพูด และเสียงเอฟเฟกต์เปลี่ยนฉาก"
            >
              {editable.voice.provider === "gemini" ? (
                <div className="space-y-1.5">
                  <GeminiVoiceStyleSelect
                    value={editable.voice.geminiVoiceStyle ?? "neutral"}
                    onChange={(geminiVoiceStyle) =>
                      patchDraft((current) => ({
                        ...current,
                        voice: { ...current.voice, geminiVoiceStyle },
                      }))
                    }
                    label="น้ำเสียง Gemini"
                    labelClassName="text-xs font-semibold text-foreground"
                    selectClassName="mt-1.5 block min-h-11 w-full max-w-xs rounded-lg border border-input bg-background px-3 text-sm text-foreground"
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">ความเร็วเสียงพากย์ (TTS Speed)</p>
                <div className="flex flex-wrap gap-2">
                  {TTS_SPEED_OPTIONS.map((opt) => {
                    const selected = activeTtsSpeed === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() =>
                          patchDraft((current) => ({
                            ...current,
                            voice: { ...current.voice, ttsSpeed: opt.value },
                          }))
                        }
                        className={cn(
                          "min-h-10 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          selected
                            ? "border-violet-500 bg-violet-500/15 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {opt.label} · {opt.note}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <ToggleSwitch
                  id="brand-sfx-mode"
                  checked={activeSfxMode === "subtle"}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    const nextSfx = checked ? "subtle" : "none";
                    updateVideoDefaults({ sfxMode: nextSfx });
                    updateSubtitleConfig({ sfxMode: nextSfx });
                  }}
                  label="เสียงเอฟเฟกต์เปลี่ยนฉาก (Transition SFX)"
                  description="ใส่เสียง Whoosh/Pop นุ่มนวลอัตโนมัติทุกจังหวะสลับฉาก"
                />
              </div>
            </ContextualAdvanced>
          </div>
        )}

        {/* ── TAB 3: ซับ & การ์ดหน้าจอ ─────────────────────────────────────── */}
        {activeTab === "captions" && (
          <div
            role="tabpanel"
            id="brand-tabpanel-captions"
            aria-labelledby="brand-tab-captions"
            className="space-y-6"
          >
            {/* Quick Subtitle Style Visual Cards */}
            <section className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-foreground">สไตล์ซับไตเติลประจำช่อง</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  เลือกแบบสำเร็จรูปที่ชอบ แล้วดูตัวอย่างสดทันทีบนจอ 9:16
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {BRAND_SUBTITLE_QUICK_STYLES.map((style) => {
                  const active = subtitleConfig.preset === style.preset;
                  return (
                    <button
                      key={style.key}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() =>
                        updateSubtitleConfig({
                          preset: style.preset,
                          effect: style.effect,
                          textColor: style.textColor,
                          accentColor: style.accentColor,
                          shadow: style.shadow,
                          outline: style.outline,
                        })
                      }
                      className={cn(
                        "flex min-h-[82px] flex-col items-start justify-between gap-1.5 rounded-xl border p-3 text-left transition-all disabled:opacity-50",
                        active
                          ? "border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/35"
                          : "border-border bg-card hover:border-violet-500/40",
                      )}
                    >
                      <span className="text-xs font-semibold text-foreground">{style.label}</span>
                      <span className="text-[11px] leading-4 text-muted-foreground">{style.desc}</span>
                    </button>
                  );
                })}
              </div>

              {library.subtitlePresets.length > 0 ? (
                <div className="pt-1">
                  <Label htmlFor="brand-subtitle-preset" className="text-xs font-semibold text-foreground">
                    หรือใช้พรีเซ็ตซับที่บันทึกไว้ของคุณ
                  </Label>
                  <Select
                    value={editable.subtitle.presetId ?? NO_SUBTITLE_PRESET}
                    disabled={disabled}
                    onValueChange={(value) => {
                      const preset = library.subtitlePresets.find((item) => item.id === value);
                      patchDraft((current) => {
                        const preservedMotion: Record<string, string | number | boolean | null> = {};
                        if (typeof current.subtitle.config?.motionThemeId === "string" && current.subtitle.config.motionThemeId) {
                          preservedMotion.motionThemeId = current.subtitle.config.motionThemeId;
                        }
                        if (typeof current.subtitle.config?.motionMascot === "string" && current.subtitle.config.motionMascot) {
                          preservedMotion.motionMascot = current.subtitle.config.motionMascot;
                        }
                        return {
                          ...current,
                          subtitle: preset
                            ? { presetId: preset.id, config: { ...preset.config, ...preservedMotion } }
                            : { presetId: null, config: preservedMotion },
                        };
                      });
                    }}
                  >
                    <SelectTrigger id="brand-subtitle-preset" className="mt-1.5 h-10">
                      <SelectValue placeholder="ใช้ค่าที่เลือกด้านบน" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SUBTITLE_PRESET}>ใช้ค่าที่เลือกด้านบน</SelectItem>
                      {library.subtitlePresets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </section>

            {/* Font Picker */}
            <section className="space-y-2.5">
              <p className="text-sm font-semibold text-foreground">ฟอนต์ซับไตเติล</p>
              <div className="flex flex-wrap gap-2">
                {BRAND_SUBTITLE_FONTS.map((f) => {
                  const selected = subtitleConfig.fontFamily === f.value;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => updateSubtitleConfig({ fontFamily: f.value })}
                      className={cn(
                        "flex min-h-11 items-center gap-2 rounded-xl border px-3.5 py-2 text-xs transition-colors",
                        selected
                          ? "border-violet-500 bg-violet-500/12 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="text-sm font-semibold" style={{ fontFamily: `'${f.value}', sans-serif` }}>
                        {f.label}
                      </span>
                      <span className="text-[11px] opacity-75">{f.note}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Headline Hook 3s */}
            <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
              <ToggleSwitch
                id="brand-headline-hook-enabled"
                checked={headlineEnabled}
                disabled={disabled}
                onCheckedChange={(checked) => updateVideoDefaults({ headlineHookEnabled: checked })}
                label="พาดหัว 3 วินาทีแรก (Headline Hook)"
                description="ขึ้นหัวข้อดึงสายตาอัตโนมัติตอนเปิดคลิป ช่วยหยุดนิ้วคนดู"
              />
              {headlineEnabled ? (
                <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
                  {HEADLINE_HOOK_PRESETS.map((preset) => {
                    const meta = HEADLINE_HOOK_PRESET_META[preset];
                    const active = headlinePreset === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        disabled={disabled}
                        aria-pressed={active}
                        onClick={() => updateVideoDefaults({ headlineHookEnabled: true, headlineHookPreset: preset })}
                        className={cn(
                          "flex min-h-12 flex-col items-start justify-center rounded-lg border px-3 py-2 text-left transition-colors",
                          active
                            ? "border-violet-500 bg-violet-500/12 text-foreground"
                            : "border-border bg-background/60 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <span className="text-xs font-semibold text-foreground">{meta.label}</span>
                        <span className="text-[10.5px] leading-4 text-muted-foreground">{meta.desc}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>

            {/* Contextual Advanced for Tab 3 */}
            <ContextualAdvanced
              id="brand-advanced-captions"
              open={advancedTabOpen.captions}
              onToggle={() => setAdvancedTabOpen((prev) => ({ ...prev, captions: !prev.captions }))}
              title="ปรับละเอียดเพิ่มเติม · สีซับ การ์ดสถิติ & จังหวะตัดภาพ"
              subtitle="สีข้อความ/สีไฮไลต์ซับ เน้นคำสำคัญอัตโนมัติ การ์ดตัวเลข ซูมเข้า และรอยต่อฉาก"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground">สีตัวอักษรซับ</p>
                  <div className="flex flex-wrap gap-2">
                    {V2_TEXT_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        disabled={disabled}
                        aria-label={`สีข้อความซับ ${hex}`}
                        onClick={() => updateSubtitleConfig({ textColor: hex })}
                        className={cn(
                          "h-8 w-8 rounded-full border transition-transform hover:scale-105",
                          subtitleConfig.textColor.toUpperCase() === hex
                            ? "border-violet-400 ring-2 ring-violet-500/50"
                            : "border-border",
                        )}
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground">สีไฮไลต์คำสำคัญ</p>
                  <div className="flex flex-wrap gap-2">
                    {V2_ACCENT_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        disabled={disabled}
                        aria-label={`สีไฮไลต์ซับ ${hex}`}
                        onClick={() => updateSubtitleConfig({ accentColor: hex })}
                        className={cn(
                          "h-8 w-8 rounded-full border transition-transform hover:scale-105",
                          subtitleConfig.accentColor.toUpperCase() === hex
                            ? "border-violet-400 ring-2 ring-violet-500/50"
                            : "border-border",
                        )}
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-3.5 border-t border-border pt-4">
                <ToggleSwitch
                  id="brand-highlight-keywords"
                  checked={draft.videoDefaults?.highlightKeywords ?? subtitleConfig.highlightKeywords === true}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    updateVideoDefaults({ highlightKeywords: checked });
                    updateSubtitleConfig({ highlightKeywords: checked });
                  }}
                  label="เน้นคำสำคัญอัตโนมัติ (Highlight Keywords)"
                  description="ไฮไลต์ตัวเลขและคำเด่น 1–2 คำต่อการ์ดซับด้วยสีเน้น"
                />
                <ToggleSwitch
                  id="brand-stat-cards"
                  checked={draft.videoDefaults?.statCards ?? subtitleConfig.statCards === true}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    updateVideoDefaults({ statCards: checked });
                    updateSubtitleConfig({ statCards: checked });
                  }}
                  label="การ์ดตัวเลขสถิติ (Stat Cards)"
                  description="สร้างการ์ดอินโฟกราฟิกเด้งขึ้นอัตโนมัติเมื่อสคริปต์มีตัวเลขสำคัญ"
                />
                <ToggleSwitch
                  id="brand-punch-zoom"
                  checked={draft.videoDefaults?.punchZoom ?? fullSelectedPack?.punchZoom ?? false}
                  disabled={disabled}
                  onCheckedChange={(checked) => updateVideoDefaults({ punchZoom: checked })}
                  label="ซูมเข้าจังหวะเน้น (Punch Zoom)"
                  description="เพิ่มแรงส่งช่วงเปลี่ยนประโยคสำคัญให้คลิปไม่นิ่ง"
                />
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs font-semibold text-foreground">รอยต่อฉาก B-Roll</p>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      { value: "dissolve", label: "ละลายภาพ (Dissolve) · นุ่มนวล" },
                      { value: "cut", label: "ตัดชน (Cut) · กระชับ ไวรัล" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      disabled={disabled}
                      aria-pressed={activeBrollTransition === item.value}
                      onClick={() => updateVideoDefaults({ brollTransition: item.value })}
                      className={cn(
                        "min-h-10 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                        activeBrollTransition === item.value
                          ? "border-violet-500 bg-violet-500/15 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </ContextualAdvanced>
          </div>
        )}

        {/* ── TAB 4: Script DNA (Hero Script & MCP) ───────────────────────── */}
        {activeTab === "script" && (
          <div
            role="tabpanel"
            id="brand-tabpanel-script"
            aria-labelledby="brand-tab-script"
            className="space-y-6"
          >
            {/* 1-Click AI Style Analyzer */}
            <section className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-violet-400" />
                  <p className="text-sm font-semibold text-foreground">
                    วิเคราะห์สไตล์ช่องอัตโนมัติจากตัวอย่างหรือ URL
                  </p>
                </div>
                {!heroScriptAllowed ? <ProBadge /> : null}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                วางบทพูดเดิม โพสต์ที่ชอบ หรือ URL บทความ — AI จะสรุปนิช กลุ่มเป้าหมาย และโทนภาษาให้ใช้กับ Hero Script &amp; MCP ทันที
              </p>
              {heroScriptAllowed ? (
                <div className="space-y-2.5">
                  <Textarea
                    value={analyzeInput}
                    onChange={(event) => setAnalyzeInput(event.target.value)}
                    disabled={disabled || analyzing}
                    rows={3}
                    placeholder="วางข้อความตัวอย่าง 1–2 ย่อหน้า หรือวางลิงก์ https://..."
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled || analyzing || analyzeInput.trim().length < 10}
                      onClick={() => void runScriptAnalyze()}
                      className="min-h-10 border-violet-500/40 text-xs font-semibold"
                    >
                      {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-violet-400" />}
                      {analyzing ? "กำลังวิเคราะห์…" : "วิเคราะห์แล้วเติมลงฟอร์ม"}
                    </Button>
                    {analyzeMessage ? (
                      <span
                        role="status"
                        className={cn(
                          "text-xs",
                          analyzeMessage.tone === "error" ? "text-destructive" : "text-emerald-400",
                        )}
                      >
                        {analyzeMessage.text}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  ตัวช่วยวิเคราะห์สไตล์ด้วย AI ใช้ได้กับสมาชิก PRO ขึ้นไป{" "}
                  <Link href="/pricing?source=brands_script_dna" className="font-semibold text-violet-400 underline underline-offset-4">
                    ดูแผนรายเดือน
                  </Link>
                </p>
              )}
            </section>

            {/* Basic Script DNA fields */}
            <section className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="brand-niche" className="text-sm font-semibold">
                    นิชหลักของช่อง
                  </Label>
                  <Input
                    id="brand-niche"
                    value={editable.niche}
                    onChange={(event) => patchDraft((current) => ({ ...current, niche: event.target.value }))}
                    placeholder="เช่น การตลาด AI สำหรับเจ้าของธุรกิจ"
                    disabled={disabled}
                    maxLength={BRAND_PROFILE_CAPS.shortFieldChars}
                    className="mt-1.5 h-10"
                  />
                </div>
                <div>
                  <Label htmlFor="brand-audience" className="text-sm font-semibold">
                    กลุ่มเป้าหมาย
                  </Label>
                  <Input
                    id="brand-audience"
                    value={editable.audience}
                    onChange={(event) => patchDraft((current) => ({ ...current, audience: event.target.value }))}
                    placeholder="ใครควรรู้สึกว่าคลิปนี้ทำมาเพื่อเขา"
                    disabled={disabled}
                    maxLength={BRAND_PROFILE_CAPS.audienceChars}
                    className="mt-1.5 h-10"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="brand-tone" className="text-sm font-semibold">
                  โทนภาษาการเขียนสคริปต์
                </Label>
                <Input
                  id="brand-tone"
                  value={editable.script.tone}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      script: { ...current.script, tone: event.target.value },
                    }))
                  }
                  placeholder="เช่น คุยตรงไปตรงมา เหมือนเพื่อนสายเทคเล่าให้ฟัง กระชับไม่เยิ่นเย้อ"
                  disabled={disabled}
                  maxLength={BRAND_PROFILE_CAPS.shortFieldChars}
                  className="mt-1.5 h-10"
                />
              </div>
            </section>

            {/* Contextual Advanced for Tab 4 */}
            <ContextualAdvanced
              id="brand-advanced-script"
              open={advancedTabOpen.script}
              onToggle={() => setAdvancedTabOpen((prev) => ({ ...prev, script: !prev.script }))}
              title="ปรับละเอียดเพิ่มเติม · ขุดนิช คำต้องห้าม & สไตล์ CTA"
              subtitle="ให้ AI ช่วยเจาะนิชเฉพาะทาง ตั้งคำที่ห้ามพูด และกำหนดแนวปิดคลิป"
            >
              {/* Niche Drilldown */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-foreground">ขุดนิชให้ลึกกว่านี้ (AI Niche Drilldown)</p>
                  {!heroScriptAllowed ? <ProBadge /> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  แตกนิชหลักของคุณออกเป็น 7 มุมเฉพาะทางที่แข่งขันต่ำ กดเลือกเพื่อเติมลงช่องนิชและกลุ่มเป้าหมายทันที
                </p>
                {heroScriptAllowed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || drillingNiches || !(editable.niche.trim() || draft.niche.trim())}
                    onClick={() => void runNicheDrilldown()}
                    className="min-h-10 text-xs"
                  >
                    {drillingNiches ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5 text-violet-400" />}
                    {drillingNiches ? "กำลังขุดนิช…" : "ขุด 7 นิชเฉพาะทาง"}
                  </Button>
                ) : null}
                {nicheError ? <p role="alert" className="text-xs text-destructive">{nicheError}</p> : null}
                {nicheIdeas.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {nicheIdeas.map((idea) => (
                      <button
                        key={idea.niche}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          patchDraft((current) => ({
                            ...current,
                            niche: idea.niche,
                            audience: idea.audience,
                          }))
                        }
                        className="flex flex-col items-start gap-1 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-violet-500/60"
                      >
                        <span className="text-xs font-semibold text-foreground">{idea.niche}</span>
                        <span className="text-[11px] leading-4 text-muted-foreground">{idea.why}</span>
                        <span className="mt-1 text-[10.5px] text-violet-400">
                          ตัวอย่าง: {idea.sampleTopics[0]}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Banned Words */}
              <div className="space-y-2 border-t border-border pt-4">
                <Label htmlFor="brand-banned-word-input" className="text-xs font-semibold">
                  คำต้องห้ามในสคริปต์ ({editable.script.bannedWords.length}/{BRAND_PROFILE_CAPS.bannedWords})
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="brand-banned-word-input"
                    value={bannedWordInput}
                    onChange={(event) => setBannedWordInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ",") {
                        event.preventDefault();
                        addBannedWord(bannedWordInput);
                      }
                    }}
                    disabled={disabled}
                    placeholder="พิมพ์คำที่ไม่อยากให้ใช้แล้วกด Enter เช่น ปังปุริเย่"
                    className="h-10"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || !bannedWordInput.trim()}
                    onClick={() => addBannedWord(bannedWordInput)}
                    className="h-10 shrink-0 px-3 text-xs"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    เพิ่ม
                  </Button>
                </div>
                {editable.script.bannedWords.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {editable.script.bannedWords.map((word) => (
                      <span
                        key={word}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-foreground"
                      >
                        {word}
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`ลบคำต้องห้าม ${word}`}
                          onClick={() => removeBannedWord(word)}
                          className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* CTA Style */}
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs font-semibold text-foreground">สไตล์ปิดคลิป (CTA Style)</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CTA_STYLES.map((cta) => {
                    const active = editable.script.ctaStyle === cta.key;
                    return (
                      <button
                        key={cta.key}
                        type="button"
                        disabled={disabled}
                        aria-pressed={active}
                        onClick={() =>
                          patchDraft((current) => ({
                            ...current,
                            script: { ...current.script, ctaStyle: cta.key },
                          }))
                        }
                        className={cn(
                          "flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-colors",
                          active
                            ? "border-violet-500 bg-violet-500/12 text-foreground"
                            : "border-border bg-card text-muted-foreground hover:border-violet-500/40 hover:text-foreground",
                        )}
                      >
                        <span className="text-xs font-semibold text-foreground">{cta.label}</span>
                        <span className="text-[11px] leading-4 text-muted-foreground">{cta.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Analysis Notes */}
              <div className="border-t border-border pt-4">
                <Label htmlFor="brand-analysis-notes" className="text-xs font-semibold">
                  โน้ตสไตล์การเขียนเพิ่มเติม
                </Label>
                <Textarea
                  id="brand-analysis-notes"
                  value={editable.script.analysisNotes ?? ""}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      script: { ...current.script, analysisNotes: event.target.value || null },
                    }))
                  }
                  placeholder="สรุปรูปแบบการเปิดเรื่อง คำเรียกแทนตัว หรือจังหวะเล่าเรื่องเฉพาะช่อง"
                  disabled={disabled}
                  rows={4}
                  maxLength={BRAND_PROFILE_CAPS.longFieldChars}
                  className="mt-1.5"
                />
              </div>
            </ContextualAdvanced>
          </div>
        )}
      </div>

      {/* Right: Sticky Live 9:16 Brand Stage */}
      <BrandLiveStage
        draft={draft}
        library={library}
        activeId={activeId}
        basePackLabel={basePack?.thaiLabel ?? null}
      />
    </div>
  );
}
