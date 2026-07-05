"use client";

import { useState } from "react";
import { Play } from "lucide-react";

type Props = {
  /** YouTube video id (works for both normal videos and Shorts) */
  id: string;
  title: string;
  /** 9:16 vertical frame for Shorts; defaults to 16:9 landscape */
  vertical?: boolean;
  /** show the title burned over the thumbnail (good standalone; off for grids with a caption below) */
  overlayTitle?: boolean;
  className?: string;
};

// Click-to-load YouTube embed: ships only a thumbnail + play button until the
// user clicks, so the marketing page loads no YouTube iframe/JS up front (keeps
// it fast + privacy-friendly via youtube-nocookie). Matches the page's glass look.
export function YouTubeLite({ id, title, vertical = false, overlayTitle = true, className = "" }: Props) {
  const [active, setActive] = useState(false);
  const aspect = vertical ? "aspect-[9/16]" : "aspect-video";
  // Shorts: oardefault is the true 9:16 frame (maxresdefault is 16:9 → pillarboxed/black when cropped).
  const thumb = vertical
    ? `https://i.ytimg.com/vi/${id}/oardefault.jpg`
    : `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;

  return (
    <div
      className={`group relative ${aspect} w-full overflow-hidden rounded-[18px] border border-white/10 bg-black/40 shadow-[0_10px_40px_rgba(0,0,0,0.45)] ${className}`}
    >
      {active ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
          title={title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setActive(true)}
          aria-label={`เล่นวิดีโอ: ${title}`}
          className="absolute inset-0 h-full w-full cursor-pointer"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumb}
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (!img.dataset.fallback) {
                img.dataset.fallback = "1";
                img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
              }
            }}
            alt={title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03] group-hover:brightness-110"
          />
          {/* scrim for play-button + title contrast */}
          <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-black/25" aria-hidden />
          {/* play button — house gradient + glow, matching the page CTAs */}
          <span
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white transition duration-300 group-hover:scale-110"
            style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", boxShadow: "0 0 34px rgba(139,92,246,.55)" }}
            aria-hidden
          >
            <Play className="ml-0.5 h-6 w-6 fill-current" strokeWidth={0} />
          </span>
          {/* title */}
          {overlayTitle && (
            <span
              className="absolute inset-x-0 bottom-0 p-4 text-left text-sm font-semibold text-white"
              style={{ fontFamily: "'Bai Jamjuree', sans-serif" }}
            >
              {title}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
