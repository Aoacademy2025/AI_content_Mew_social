"use client";

import type { Dispatch, SetStateAction } from "react";
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
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.visual.palette.map((color, index) => (
                  <label
                    key={`${index}-${color}`}
                    className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background/60 px-2.5"
                  >
                    <input
                      type="color"
                      aria-label={`สีประจำแบรนด์ลำดับ ${index + 1}`}
                      value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#151515"}
                      disabled={disabled}
                      onChange={(event) =>
                        updateVisual(
                          "palette",
                          draft.visual.palette.map((item, itemIndex) =>
                            itemIndex === index ? event.target.value.toUpperCase() : item,
                          ),
                        )
                      }
                      className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-not-allowed"
                    />
                    <span className="font-mono text-[11px] text-muted-foreground">{color}</span>
                  </label>
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
            <TextField
              id="brand-default-treatment"
              label="อารมณ์สำรองเมื่อยังไม่มีเนื้อหาให้วิเคราะห์"
              value={draft.visual.defaultTreatment}
              onChange={(value) => updateVisual("defaultTreatment", value)}
              disabled={disabled}
              maxLength={300}
            />
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
          </Group>
        </div>
      )}
    </Card>
  );
}
