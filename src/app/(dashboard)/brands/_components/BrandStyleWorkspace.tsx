"use client";

import { useState } from "react";
import { ImageOff, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stylePackSample } from "@/lib/style-pack-samples";
import { renderSubtitle } from "@/remotion/renderSubtitle";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { stylePack } from "@/lib/style-pack-catalog";
import { VisualFormatPicker } from "./VisualFormatPicker";
import type { BrandPayload, LibraryResponse, VisualFormatId } from "./types";

/** Packs shown before "ดูสไตล์ทั้งหมด". `comic-story` is here because the
 * old "ปรับสไตล์เอง · การ์ตูน…" button showed creators were hunting for it
 * (HERO-35). */
const STARTER_PACK_IDS: ReadonlyArray<BrandPayload["visual"]["stylePackId"]> = ["life-drama", "finance-clear", "health-simple", "comic-story"];

export function BrandStyleWorkspace({ draft, library, disabled, onSelect, onFormatChange }: {
  draft: BrandPayload; library: LibraryResponse; disabled: boolean;
  onSelect: (id: BrandPayload["visual"]["stylePackId"]) => void;
  /** Picks a Visual Format on its own. The client unlinks the pack (ADR 0058)
   *  but keeps every other value the pack resolved. */
  onFormatChange: (id: VisualFormatId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const selected = library.stylePacks.find((item) => item.id === draft.visual.stylePackId);
  // The pack a custom look was adjusted from — display only, never persisted:
  // the payload has no such field because a half-linked pack is exactly what
  // ADR 0058 forbids.
  const [lastPack, setLastPack] = useState(selected ?? null);
  if (selected && selected.id !== lastPack?.id) setLastPack(selected);
  const basePack = selected ?? lastPack;
  const starters = [...STARTER_PACK_IDS, selected?.id];
  const visible = showAll ? library.stylePacks : library.stylePacks.filter((item) => starters.includes(item.id));
  const format = library.visualFormats.find((item) => item.id === draft.visual.primaryVisualFormatId);
  const sample = selected ? stylePackSample(selected.id) : null;
  // A pack sample is the honest picture of the whole look; without one, the
  // qualified Visual Format preview still shows the creator what the picture
  // axis of their look means instead of an empty frame.
  const image = sample?.imageUrl
    ? { url: sample.imageUrl, alt: `ภาพประกอบแนวทาง ${selected?.thaiLabel}`, label: sample.label }
    : format?.previewUrl
      ? { url: format.previewUrl, alt: `ตัวอย่างแนวภาพ ${format.label}`, label: `ตัวอย่างแนวภาพ ${format.label} · สี เสียง ซับ ตามค่าที่ตั้งไว้` }
      : null;
  const imageUrl = image && failedUrl !== image.url ? image.url : null;
  const pack = selected ? stylePack(selected.id) : null;
  const config = normalizeSubtitleStylePresetConfig(draft.subtitle.config) ?? stylePack("life-drama").subtitle;
  const voice = draft.voice.provider === "gemini" ? "เสียง AI" : draft.voice.provider === "omnivoice" ? "Hero AI Voice" : "ElevenLabs";
  const title = selected?.thaiLabel ?? (basePack ? `ปรับจาก ${basePack.thaiLabel}` : "สไตล์ที่กำหนดเอง");

  return <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.85fr)]">
    <div className="min-w-0 space-y-4 lg:order-first">
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="mb-3 text-sm font-semibold">สไตล์เริ่มต้น</legend>
        <div className="divide-y divide-border border-y border-border">
          {visible.map((item) => <label key={item.id} className={`flex min-h-[76px] cursor-pointer items-center gap-3 px-3 py-4 transition-colors ${item.id === selected?.id ? "bg-violet-500/10" : "hover:bg-muted/60"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
            <input type="radio" name="brand-setup-style" value={item.id} checked={item.id === selected?.id} onChange={() => onSelect(item.id)} className="h-4 w-4 shrink-0 accent-violet-600" />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.thaiLabel}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.tagline}</span></span>
            {item.id === selected?.id && <span aria-hidden="true" className="shrink-0 text-xs font-medium text-violet-500">เลือกอยู่</span>}
          </label>)}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" disabled={disabled} onClick={() => setShowAll(!showAll)} className="h-auto min-h-11 max-w-full whitespace-normal py-3 text-left text-sm">{showAll ? "แสดงสไตล์เริ่มต้น" : "ดูสไตล์ทั้งหมด"}</Button>
        <Button type="button" variant="ghost" disabled={disabled} aria-expanded={formatOpen} aria-controls="brand-setup-format" onClick={() => setFormatOpen(!formatOpen)} className="h-auto min-h-11 max-w-full whitespace-normal py-3 text-left text-sm"><SlidersHorizontal className="h-4 w-4" />{formatOpen ? "ซ่อนแนวภาพ" : "เลือกแนวภาพเอง"}</Button>
      </div>
      {formatOpen && <div id="brand-setup-format" className="rounded-xl border border-border p-3">
        <VisualFormatPicker formats={library.visualFormats} value={draft.visual.primaryVisualFormatId} onChange={onFormatChange} disabled={disabled} />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">เปลี่ยนแค่แนวภาพ สี เสียง ซับ และจังหวะยังเป็นค่าจากสไตล์ที่เลือกไว้ · แก้ค่าอื่นได้ใน “ตั้งค่าเพิ่มเติม”</p>
      </div>}
      <p className="text-xs leading-5 text-muted-foreground">เป็นค่าเริ่มต้นสำหรับคลิปใหม่ เปลี่ยนรายคลิปได้ คลิปเดิมคงเดิม</p>
    </div>

    <aside className="order-first min-w-0 self-start rounded-xl border border-border bg-card p-4 lg:order-last" aria-label="ตัวอย่างและการตั้งค่าที่เลือก">
      <div className="mb-3 flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3><span className="text-xs text-muted-foreground">ดูตัวอย่างไม่ใช้เครดิต</span></div>
      <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-4 sm:grid-cols-[140px_minmax(0,1fr)] lg:grid-cols-[140px_minmax(0,1fr)]">
        <figure className="relative aspect-[9/12] overflow-hidden rounded-lg bg-muted lg:aspect-[9/16]">
          {/* Static versioned samples are already sized/compressed; show load failures in place. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {imageUrl ? <img src={imageUrl} alt={image?.alt} className="h-full w-full object-cover" onError={() => setFailedUrl(imageUrl)} /> : <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-xs leading-5 text-muted-foreground"><ImageOff className="h-5 w-5" />ภาพตัวอย่างยังไม่พร้อม</div>}
        </figure>
        <div className="min-w-0">
          <dl className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-2 break-words text-xs leading-5" aria-live="polite">
            <dt className="text-muted-foreground">ภาพ</dt><dd>{format?.label ?? "แนวภาพที่เลือก"}</dd>
            <dt className="text-muted-foreground">เสียง</dt><dd className="break-words">{voice}{draft.voice.voiceId ? ` · ${draft.voice.provider === "gemini" ? draft.voice.voiceId : "เสียงที่บันทึกไว้"}` : " · ค่าเริ่มต้นบัญชี"}</dd>
            <dt className="text-muted-foreground">ซับ</dt><dd>{library.subtitlePresets.find((item) => item.id === draft.subtitle.presetId)?.name ?? (pack ? "ซับของชุดสไตล์" : "ค่าที่เลือกไว้")}</dd>
            <dt className="text-muted-foreground">จังหวะ</dt><dd>{pack ? ({ slow: "ช้า", normal: "ปกติ", fast: "เร็ว" }[pack.pacing]) : "ตามการตั้งค่าคลิป"}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="ชุดสีที่เลือก">{draft.visual.palette.map((color, i) => <span key={`${color}-${i}`} title={color} className="h-5 w-5 rounded-full border border-border" style={{ backgroundColor: color }} />)}</div>
          <details className="mt-3"><summary className="cursor-pointer py-2 text-xs text-muted-foreground">ดูตัวอย่างซับ</summary><div className="mt-2 rounded-lg bg-zinc-900 px-3 py-4 text-center" aria-label="ตัวอย่างตัวอักษรซับ">{renderSubtitle("ทุกเรื่องเริ่มต้นได้", config.textColor, 20, false, config.preset, config.fontFamily, config.fontWeight, -1, 60, config.effect, config.accentColor, { shadow: config.shadow, outline: config.outline, outlineSize: config.outlineSize })}</div>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">ตัวอย่างสีและตัวอักษร · จังหวะซับดูในคลิปจริง</p></details>
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{imageUrl ? image?.label : "ภาพตัวอย่างยังไม่พร้อม · ยังเลือกสไตล์และสร้างคลิปได้"}</p>
      <details className="mt-2 text-xs leading-5 text-muted-foreground"><summary className="cursor-pointer py-2">เกี่ยวกับตัวอย่าง</summary><p>ฟุตเทจสต็อกปรับอารมณ์การเลือกภาพ ส่วนภาพ AI ใช้แนวภาพและชุดสีที่เลือก ตัวอย่างนี้แสดงภาพนิ่ง สี และรูปแบบตัวอักษร ยังไม่ใช่คลิปหลายฉากพร้อมเสียง</p></details>
    </aside>
  </div>;
}
