"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeHexColor } from "@/lib/hex-color";
import { cn } from "@/lib/utils";
import { CURATED_BRAND_SWATCHES, PALETTE_SLOT_LABELS } from "./brand-kit-constants";

function PaletteHexSlot({
  value,
  index,
  active,
  disabled,
  onFocus,
  onApply,
}: {
  value: string;
  index: number;
  active: boolean;
  disabled?: boolean;
  onFocus: () => void;
  onApply: (hex: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(value);
  const [showError, setShowError] = useState(false);
  const normalized = normalizeHexColor(draft);
  const meta = PALETTE_SLOT_LABELS[index] ?? { role: `สีที่ ${index + 1}`, hint: "" };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync controlled palette prop when Style Pack or quick-swatch changes
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
    <div
      onClick={onFocus}
      className={cn(
        "min-w-0 rounded-xl border p-3 transition-colors",
        active ? "border-violet-500/60 bg-violet-500/5" : "border-border bg-background/50",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs font-semibold text-foreground">
          {meta.role}
        </Label>
        <span className="text-[10.5px] text-muted-foreground">สีที่ {index + 1}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-9 w-9 shrink-0 rounded-lg border border-border shadow-xs"
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
          onFocus={onFocus}
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
          placeholder="#8B5CF6"
          className="h-9 min-w-0 font-mono text-xs uppercase tracking-[0.06em]"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || normalized === normalizeHexColor(value)}
          onClick={apply}
          className="h-9 shrink-0 px-2.5 text-xs focus-visible:ring-violet-500/60"
        >
          ตกลง
        </Button>
      </div>
      {showError && !normalized && (
        <p id={errorId} role="alert" className="mt-1.5 text-[11px] text-destructive">
          ใช้รูปแบบ HEX เช่น #8B5CF6
        </p>
      )}
    </div>
  );
}

export function BrandColorPaletteEditor({
  palette,
  disabled,
  onChange,
}: {
  palette: string[];
  disabled?: boolean;
  onChange: (nextPalette: string[]) => void;
}) {
  const [activeSlot, setActiveSlot] = useState(1);
  const safeSlot = Math.min(activeSlot, Math.max(0, palette.length - 1));

  function updateSlot(index: number, hex: string) {
    onChange(palette.map((item, idx) => (idx === index ? hex : item)));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">สีประจำแบรนด์ (Brand CI)</p>
        <p className="text-xs text-muted-foreground">
          ระบบจะใช้สีเหล่านี้เป็นโทนของภาพ ไม่ใช่วาดเป็นวัตถุในภาพ
        </p>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {palette.slice(0, 3).map((hex, index) => (
          <PaletteHexSlot
            key={index}
            value={hex}
            index={index}
            active={safeSlot === index}
            disabled={disabled}
            onFocus={() => setActiveSlot(index)}
            onApply={(nextHex) => updateSlot(index, nextHex)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <span className="text-[11px] text-muted-foreground">
          จิ้มสีด่วน ({PALETTE_SLOT_LABELS[safeSlot]?.role ?? `สีที่ ${safeSlot + 1}`}):
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {CURATED_BRAND_SWATCHES.map((swatch) => {
            const current = normalizeHexColor(palette[safeSlot] ?? "");
            const selected = current === swatch;
            return (
              <button
                key={swatch}
                type="button"
                disabled={disabled}
                aria-label={`เลือกสี ${swatch}`}
                title={swatch}
                onClick={() => updateSlot(safeSlot, swatch)}
                className={cn(
                  "h-6 w-6 rounded-full border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/70 disabled:opacity-50",
                  selected ? "border-violet-400 ring-2 ring-violet-500/40" : "border-border",
                )}
                style={{ backgroundColor: swatch }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
