"use client";

import { useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import { ChevronDown, Loader2, Sparkles, Upload, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { normalizeHexColor } from "@/lib/hex-color";
import type { BrandPayload, LibraryResponse, VisualProposal } from "./types";

const NO_SUBTITLE_PRESET = "__clip-default__";
const NO_BRAND_ASSET = "__none__";

const BRAND_MARK_POSITIONS: Array<[string, string]> = [
  ["top-left", "บนซ้าย"],
  ["top-right", "บนขวา"],
  ["bottom-left", "ล่างซ้าย"],
  ["bottom-right", "ล่างขวา"],
];

function FieldShell({
  id,
  label,
  helper,
  children,
}: {
  id: string;
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-[13px] font-semibold">
        {label}
      </Label>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function TextField({
  id,
  label,
  helper,
  value,
  onChange,
  placeholder,
  disabled,
  maxLength,
}: {
  id: string;
  label: string;
  helper?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <FieldShell id={id} label={label} helper={helper}>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        className="h-10"
      />
    </FieldShell>
  );
}

function NotesField({
  id,
  label,
  helper,
  value,
  onChange,
  placeholder,
  disabled,
  rows,
  maxLength,
}: {
  id: string;
  label: string;
  helper?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows: number;
  maxLength?: number;
}) {
  return (
    <FieldShell id={id} label={label} helper={helper}>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
      />
    </FieldShell>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-muted/30 p-4">
      <p className="text-[13px] font-semibold text-foreground">{title}</p>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

/** No Switch primitive exists in @/components/ui — this is the same
 * role="switch" pattern the Editor v2 overlay controls already use. */
function ToggleSwitch({
  id,
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </Label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
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

function RangeField({
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
      <Label htmlFor={id} className="flex items-center justify-between text-[13px] font-medium">
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

function HexColorField({
  value,
  index,
  disabled,
  onApply,
}: {
  value: string;
  index: number;
  disabled?: boolean;
  onApply: (value: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(value);
  const [showError, setShowError] = useState(false);
  const normalized = normalizeHexColor(draft);

  useEffect(() => {
    setDraft(value);
    setShowError(false);
  }, [value]);

  function apply() {
    if (!normalized) {
      setShowError(true);
      return;
    }
    onApply(normalized);
    setDraft(normalized);
    setShowError(false);
  }

  return (
    <div className="min-w-[210px] flex-1">
      <Label htmlFor={id} className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
        สีที่ {index + 1} · HEX
      </Label>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-9 w-9 shrink-0 rounded-lg border border-border"
          style={{ background: normalizeHexColor(value) ?? "#151515" }}
        />
        <Input
          id={id}
          value={draft}
          inputMode="text"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={showError && !normalized}
          aria-describedby={showError && !normalized ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value.toUpperCase());
            if (showError) setShowError(false);
          }}
          onBlur={() => setShowError(Boolean(draft.trim()) && !normalizeHexColor(draft))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
          placeholder="#D29D00"
          className="h-9 min-w-0 uppercase tracking-[0.08em]"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || normalized === normalizeHexColor(value)}
          onClick={apply}
          className="h-9 shrink-0 px-3 text-xs focus-visible:ring-violet-500/60"
        >
          ตกลง
        </Button>
      </div>
      {showError && !normalized && (
        <p id={errorId} role="alert" className="mt-1.5 text-[11px] text-destructive">
          ใช้รูปแบบ HEX เช่น #D29D00
        </p>
      )}
    </div>
  );
}

function BrandMarkPreview({
  draft,
  library,
}: {
  draft: BrandPayload;
  library: LibraryResponse;
}) {
  const asset = library.brandAssets.find((item) => item.id === draft.brandMark.assetId);
  const positionClass = {
    "top-left": "left-[7%] top-[5%]",
    "top-right": "right-[7%] top-[5%]",
    "bottom-left": "bottom-[5%] left-[7%]",
    "bottom-right": "bottom-[5%] right-[7%]",
  }[draft.brandMark.position] ?? "right-[7%] top-[5%]";

  return (
    <div className="grid items-start gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
      <div
        data-brand-mark-preview="true"
        className="relative aspect-[9/16] w-[160px] max-w-full overflow-hidden rounded-xl border border-border bg-[#14131b]"
        aria-label="ตัวอย่างขนาดและตำแหน่งโลโก้บนวิดีโอแนวตั้ง"
      >
        <div className="absolute inset-[6%] rounded-lg border border-dashed border-white/15" />
        <div className="absolute left-[12%] right-[12%] top-[43%] space-y-2" aria-hidden="true">
          <div className="h-2 rounded bg-white/10" />
          <div className="mx-auto h-2 w-3/4 rounded bg-white/10" />
        </div>
        <div className="absolute bottom-[16%] left-[14%] right-[14%] h-3 rounded bg-white/15" aria-hidden="true" />
        {draft.brandMark.enabled && asset ? (
          <img
            src={`/api/user/brand-assets/${asset.id}/image`}
            alt={`ตัวอย่างโลโก้ ${asset.name}`}
            className={cn("absolute max-h-[40%] object-contain", positionClass)}
            style={{ width: `${draft.brandMark.sizePct}%`, opacity: draft.brandMark.opacity }}
          />
        ) : (
          <span className="absolute inset-x-3 top-1/2 -translate-y-1/2 text-center text-[10px] leading-4 text-white/45">
            {draft.brandMark.enabled ? "เลือกไฟล์โลโก้เพื่อดูตัวอย่าง" : "เปิดลายน้ำเพื่อดูตัวอย่าง"}
          </span>
        )}
      </div>
      <div className="pt-1">
        <p className="text-[13px] font-semibold text-foreground">ตัวอย่างบนวิดีโอ 9:16</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          ขนาด ตำแหน่ง และความทึบจะเปลี่ยนทันทีขณะลาก ค่าจริงตอนส่งออกใช้สัดส่วนเดียวกัน
        </p>
        {asset && (
          <p className="mt-2 truncate text-[11px] text-muted-foreground">{asset.name}</p>
        )}
      </div>
    </div>
  );
}

export function AdvancedSettings({
  open,
  onOpenChange,
  draft,
  setDraft,
  updateVisual,
  library,
  busy,
  disabled,
  proposal,
  onAskHelper,
  onApplyProposal,
  onUploadBrandMark,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: BrandPayload;
  setDraft: Dispatch<SetStateAction<BrandPayload>>;
  updateVisual: <K extends keyof BrandPayload["visual"]>(
    key: K,
    value: BrandPayload["visual"][K],
  ) => void;
  library: LibraryResponse;
  busy: string | null;
  disabled: boolean;
  proposal: VisualProposal | null;
  onAskHelper: () => void;
  onApplyProposal: (proposal: VisualProposal) => void;
  onUploadBrandMark: (file: File) => void;
}) {
  const helperDisabled = disabled || busy !== null || !draft.niche.trim() || !draft.audience.trim();
  const proposedFormatLabel = proposal
    ? library.visualFormats.find((format) => format.id === proposal.primaryVisualFormatId)?.label
    : null;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="brand-advanced-panel"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/50"
      >
        <span>
          <span className="block text-sm font-semibold text-foreground">ตั้งค่าเพิ่มเติม</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            สี เสียง ซับ โลโก้ และรายละเอียดแบรนด์ — ไม่กรอกก็ได้
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div id="brand-advanced-panel" className="space-y-5 border-t border-border p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              id="brand-niche"
              label="นิชหลัก"
              value={draft.niche}
              onChange={(value) => setDraft((current) => ({ ...current, niche: value }))}
              placeholder="เช่น การตลาดสำหรับ Creator"
              disabled={disabled}
              maxLength={300}
            />
            <TextField
              id="brand-audience"
              label="กลุ่มเป้าหมาย"
              value={draft.audience}
              onChange={(value) => setDraft((current) => ({ ...current, audience: value }))}
              placeholder="ใครควรรู้สึกว่านี่ทำมาเพื่อเขา"
              disabled={disabled}
              maxLength={500}
            />
          </div>

          <Group title="ผู้ช่วยออกแบบแนวภาพ">
            <p className="text-xs leading-5 text-muted-foreground">
              AI เสนอค่าให้ดูก่อนเท่านั้น ไม่สร้างภาพและไม่เปลี่ยนร่างจนกว่าคุณจะกดนำมาใช้
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={onAskHelper}
              disabled={helperDisabled}
              className="h-10"
            >
              {busy === "helper" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 text-violet-500" />
              )}
              ขอคำแนะนำ
            </Button>
            {proposal && (
              <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <WandSparkles className="h-3.5 w-3.5 text-violet-500" />
                  AI แนะนำ: {proposedFormatLabel}
                </p>
                {proposal.rationale && (
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {proposal.rationale}
                  </p>
                )}
                <Button
                  type="button"
                  variant="link"
                  onClick={() => onApplyProposal(proposal)}
                  disabled={disabled}
                  className="mt-1 h-auto p-0 text-xs text-violet-500"
                >
                  นำคำแนะนำมาใส่ในร่าง
                </Button>
              </div>
            )}
          </Group>

          <Group title="สไตล์การเขียน">
            <TextField
              id="brand-tone"
              label="โทนสคริปต์"
              value={draft.script.tone}
              onChange={(value) =>
                setDraft((current) => ({ ...current, script: { ...current.script, tone: value } }))
              }
              disabled={disabled}
              maxLength={500}
            />
            <NotesField
              id="brand-analysis-notes"
              label="โน้ตสไตล์การเขียน"
              value={draft.script.analysisNotes ?? ""}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  script: { ...current.script, analysisNotes: value || null },
                }))
              }
              placeholder="ระบบเติมจาก Writing Style เดิมให้ตรวจและแก้ได้"
              disabled={disabled}
              rows={4}
              maxLength={4000}
            />
          </Group>

          <Group title="โทนภาพของแบรนด์">
            <div>
              <p className="text-[13px] font-semibold text-foreground">สีประจำแบรนด์</p>
              <p className="mt-1 text-xs text-muted-foreground">
                ระบบจะใช้สีเหล่านี้เป็นโทนของภาพ ไม่ใช่วาดเป็นวัตถุในภาพ
              </p>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {draft.visual.palette.map((color, index) => (
                  <HexColorField
                    key={index}
                    value={color}
                    index={index}
                    disabled={disabled}
                    onApply={(value) =>
                      updateVisual(
                        "palette",
                        draft.visual.palette.map((item, itemIndex) =>
                          itemIndex === index ? value : item,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </div>
            <TextField
              id="brand-visual-personality"
              label="บุคลิกของภาพ"
              value={draft.visual.personality}
              onChange={(value) => updateVisual("personality", value)}
              disabled={disabled}
              maxLength={500}
            />
            <FieldShell
              id="brand-treatment-policy"
              label="แนวเล่าเรื่องของแต่ละคลิป"
              helper="ค่าเริ่มต้นให้ AI อ่านทั้งเนื้อหาและเลือกจากแนวที่ตรวจแล้ว โดยไม่เพิ่มขั้นตอนก่อนสร้างคลิป"
            >
              <Select
                value={draft.visual.treatmentPolicy}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === "adaptive") {
                    updateVisual("treatmentPolicy", "adaptive");
                    updateVisual("lockedTreatmentPresetId", null);
                  } else {
                    updateVisual("treatmentPolicy", "locked");
                    if (!draft.visual.lockedTreatmentPresetId) {
                      updateVisual("lockedTreatmentPresetId", library.treatmentPresets[0]?.id ?? null);
                    }
                  }
                }}
              >
                <SelectTrigger id="brand-treatment-policy" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="adaptive">AI เลือกแนวเล่าเรื่องตามเนื้อหา</SelectItem>
                  <SelectItem value="locked">ใช้แนวเล่าเรื่องเดิมทุกคลิป</SelectItem>
                </SelectContent>
              </Select>
            </FieldShell>
            {draft.visual.treatmentPolicy === "locked" && (
              <FieldShell id="brand-locked-treatment" label="แนวเล่าเรื่องที่ใช้ทุกคลิป">
                <Select
                  value={draft.visual.lockedTreatmentPresetId ?? undefined}
                  disabled={disabled}
                  onValueChange={(value) => updateVisual(
                    "lockedTreatmentPresetId",
                    value as BrandPayload["visual"]["lockedTreatmentPresetId"],
                  )}
                >
                  <SelectTrigger id="brand-locked-treatment" className="h-10">
                    <SelectValue placeholder="เลือกแนวเล่าเรื่อง" />
                  </SelectTrigger>
                  <SelectContent>
                    {library.treatmentPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldShell>
            )}
            <NotesField
              id="brand-visual-notes"
              label="โน้ตทิศทางภาพ"
              value={draft.visual.visualNotes}
              onChange={(value) => updateVisual("visualNotes", value)}
              disabled={disabled}
              rows={4}
              maxLength={800}
            />
          </Group>

          <Group title="เสียงเริ่มต้นของแบรนด์">
            <div className="grid gap-4 md:grid-cols-2">
              <FieldShell id="brand-voice-provider" label="ผู้ให้บริการเสียง">
                <Select
                  value={draft.voice.provider}
                  disabled={disabled}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, voice: { provider: value, voiceId: null } }))
                  }
                >
                  <SelectTrigger id="brand-voice-provider" className="h-10">
                    <SelectValue placeholder="เลือกผู้ให้บริการเสียง" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                    <SelectItem value="omnivoice">Hero Voice</SelectItem>
                  </SelectContent>
                </Select>
              </FieldShell>
              <TextField
                id="brand-voice-id"
                label={draft.voice.provider === "gemini" ? "ชื่อเสียง Gemini" : "Voice ID"}
                value={draft.voice.voiceId ?? ""}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    voice: { ...current.voice, voiceId: value.trim() ? value : null },
                  }))
                }
                placeholder="เว้นว่างเพื่อใช้ค่าเริ่มต้นบัญชี"
                disabled={disabled}
                maxLength={180}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              โปรเจกต์ใหม่รับค่านี้เป็นค่าเริ่มต้น และยังเลือกเสียงอื่นรายคลิปได้
            </p>
          </Group>

          <Group title="ซับเริ่มต้น">
            <FieldShell id="brand-subtitle-preset" label="รูปแบบซับ">
              <Select
                value={draft.subtitle.presetId ?? NO_SUBTITLE_PRESET}
                disabled={disabled}
                onValueChange={(value) => {
                  const preset = library.subtitlePresets.find((item) => item.id === value);
                  setDraft((current) => ({
                    ...current,
                    subtitle: preset
                      ? { presetId: preset.id, config: preset.config }
                      : { presetId: null, config: {} },
                  }));
                }}
              >
                <SelectTrigger id="brand-subtitle-preset" className="h-10">
                  <SelectValue placeholder="ใช้ค่าเริ่มต้นของคลิป" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SUBTITLE_PRESET}>ใช้ค่าเริ่มต้นของคลิป</SelectItem>
                  {library.subtitlePresets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
            <p className="text-[11px] text-muted-foreground">
              เลือกได้ทุกแผน ระบบเก็บค่านี้ไว้กับแนวภาพแต่ละรุ่น จึงไม่เปลี่ยนตามการแก้รูปแบบภายหลัง
            </p>
          </Group>

          <Group title="โลโก้ / ลายน้ำเริ่มต้น">
            <ToggleSwitch
              id="brand-mark-enabled"
              label="เปิดลายน้ำในโปรเจกต์ใหม่"
              checked={draft.brandMark.enabled}
              disabled={disabled}
              onCheckedChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  brandMark: { ...current.brandMark, enabled: value },
                }))
              }
            />
            <div>
              <label
                className={cn(
                  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-dashed border-input px-3 text-xs font-medium transition-colors",
                  disabled || busy !== null
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:border-violet-500 hover:text-violet-500",
                )}
              >
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={disabled || busy !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) onUploadBrandMark(file);
                  }}
                  className="hidden"
                />
                {busy === "brand-mark" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                อัปโหลดโลโก้ใหม่
              </label>
              <p className="mt-2 text-[11px] text-muted-foreground">
                JPG, PNG หรือ WebP ไม่เกิน 5 MB · ทุกแผนที่ใช้ระบบแนวภาพแก้ลายน้ำของแบรนด์ได้
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <FieldShell id="brand-mark-asset" label="ไฟล์โลโก้">
                <Select
                  value={draft.brandMark.assetId ?? NO_BRAND_ASSET}
                  disabled={disabled}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      brandMark: {
                        ...current.brandMark,
                        assetId: value === NO_BRAND_ASSET ? null : value,
                      },
                    }))
                  }
                >
                  <SelectTrigger id="brand-mark-asset" className="h-10">
                    <SelectValue placeholder="ยังไม่เลือกไฟล์" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BRAND_ASSET}>ยังไม่เลือกไฟล์</SelectItem>
                    {library.brandAssets.map((asset) => (
                      <SelectItem key={asset.id} value={asset.id}>
                        {asset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldShell>
              <FieldShell id="brand-mark-position" label="ตำแหน่ง">
                <Select
                  value={draft.brandMark.position}
                  disabled={disabled}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      brandMark: { ...current.brandMark, position: value },
                    }))
                  }
                >
                  <SelectTrigger id="brand-mark-position" className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BRAND_MARK_POSITIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldShell>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <RangeField
                id="brand-mark-size"
                label="ขนาด"
                suffix={`${Math.round(draft.brandMark.sizePct)}%`}
                min={5}
                max={40}
                value={draft.brandMark.sizePct}
                disabled={disabled}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    brandMark: { ...current.brandMark, sizePct: value },
                  }))
                }
              />
              <RangeField
                id="brand-mark-opacity"
                label="ความทึบ"
                suffix={`${Math.round(draft.brandMark.opacity * 100)}%`}
                min={0}
                max={100}
                value={Math.round(draft.brandMark.opacity * 100)}
                disabled={disabled}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    brandMark: { ...current.brandMark, opacity: value / 100 },
                  }))
                }
              />
            </div>
            <BrandMarkPreview draft={draft} library={library} />
          </Group>
        </div>
      )}
    </Card>
  );
}
