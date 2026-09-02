"use client";

import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StylePackId } from "@/lib/style-pack-catalog";

/** สไตล์ประจำแบรนด์ — the default /brands surface (ADR 0058): one tap over
 * the existing Visual Format × narrative-treatment axes. Those two axes still
 * exist; they move under "กำหนดเอง" (the last card here, which selects
 * `null`) instead of disappearing.
 *
 * Sample images do not exist yet (`/style-packs/*.jpg`) — `onError` swaps in
 * a three-stop gradient built from the pack's own palette so the card still
 * reads as a deliberate look, not a broken image. */
export function StylePackPicker({
  packs,
  value,
  onChange,
  disabled,
  title = "สไตล์ประจำแบรนด์",
  description = "ทุกคลิปของแบรนด์นี้จะใช้สไตล์เดียวกัน เปลี่ยนทีหลังได้",
}: {
  packs: Array<{
    id: StylePackId;
    thaiLabel: string;
    tagline: string;
    palette: [string, string, string];
    sampleImage: string;
  }>;
  value: StylePackId | null;
  onChange: (id: StylePackId | null) => void;
  disabled?: boolean;
  /** The editor picks a style for ONE clip, so it says so instead of
   *  promising the creator that every clip of the brand will change. */
  title?: string;
  description?: string;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div
        role="radiogroup"
        aria-label={title}
        className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4"
      >
        {packs.map((pack) => {
          const selected = value === pack.id;
          return (
            <button
              key={pack.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              title={pack.tagline}
              onClick={() => onChange(pack.id)}
              className={cn(
                "group relative overflow-hidden rounded-xl border text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-violet-500 ring-1 ring-violet-500/45"
                  : "border-border hover:border-violet-500/45",
              )}
            >
              <div className="relative aspect-[9/14] max-h-[40dvh] bg-muted sm:max-h-none">
                {/* eslint-disable-next-line @next/next/no-img-element -- the
                    onError gradient fallback needs a plain <img>; next/image
                    cannot swap its own container's background from a load
                    failure the way this does. */}
                <img
                  src={pack.sampleImage}
                  alt={`ตัวอย่างสไตล์ ${pack.thaiLabel}`}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(event) => {
                    const image = event.currentTarget;
                    image.style.display = "none";
                    const container = image.parentElement;
                    if (container) {
                      container.style.background =
                        `linear-gradient(155deg, ${pack.palette[0]} 0%, ${pack.palette[1]} 55%, ${pack.palette[2]} 100%)`;
                    }
                  }}
                />
              </div>
              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 px-2.5 py-2",
                  selected ? "bg-violet-600 text-white" : "bg-black/70 text-white",
                )}
              >
                <p className="text-xs font-bold leading-4">{pack.thaiLabel}</p>
                <p className="mt-0.5 line-clamp-1 text-[10px] leading-4 text-white/75">{pack.tagline}</p>
              </div>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={cn(
            "flex aspect-[9/14] max-h-[40dvh] flex-col items-center justify-center gap-2 rounded-xl border text-center transition-colors sm:max-h-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
            "disabled:cursor-not-allowed disabled:opacity-50",
            value === null
              ? "border-violet-500 bg-violet-500/10 text-violet-600 ring-1 ring-violet-500/45"
              : "border-dashed border-border text-muted-foreground hover:border-violet-500/45 hover:text-violet-500",
          )}
        >
          <SlidersHorizontal className="h-5 w-5" />
          <span className="text-xs font-semibold">กำหนดเอง</span>
        </button>
      </div>
    </div>
  );
}
