"use client";

import Image from "next/image";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VisualFormat, VisualFormatId } from "./types";

/** แนวภาพประจำแบรนด์ — the second (and last) input on the default surface.
 * One card per Visual Format; the selected card carries the violet accent. */
export function VisualFormatPicker({
  formats,
  value,
  onChange,
  disabled,
}: {
  formats: VisualFormat[];
  value: VisualFormatId;
  onChange: (id: VisualFormatId) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-foreground">แนวภาพประจำแบรนด์</p>
      <p className="mt-1 text-xs text-muted-foreground">
        ทุกคลิปของแบรนด์นี้จะใช้แนวภาพเดียวกัน เปลี่ยนทีหลังได้
      </p>
      <div
        role="radiogroup"
        aria-label="แนวภาพประจำแบรนด์"
        className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"
      >
        {formats.map((format, index) => {
          const selected = value === format.id;
          return (
            <button
              key={format.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              title={format.description}
              onClick={() => onChange(format.id)}
              className={cn(
                "group relative overflow-hidden rounded-xl border text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-violet-500 ring-1 ring-violet-500/45"
                  : "border-border hover:border-violet-500/45",
              )}
            >
              <div className="relative aspect-[9/14] bg-muted">
                <Image
                  src={format.previewUrl}
                  alt={`ตัวอย่างแนวภาพ ${format.label}`}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 200px"
                  className="object-cover"
                  priority={index < 2}
                />
              </div>
              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 px-2.5 py-2",
                  selected ? "bg-violet-600 text-white" : "bg-black/70 text-white",
                )}
              >
                <span className="text-xs font-semibold leading-4">{format.label}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
