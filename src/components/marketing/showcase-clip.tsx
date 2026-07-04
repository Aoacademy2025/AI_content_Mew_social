"use client";

import { useState } from "react";
import { Play } from "lucide-react";

// Click-to-play native showcase clip (real system output, self-hosted).
// Ships only a poster image until clicked, so the marketing page stays light.
export function ShowcaseClip({ src, poster, title }: { src: string; poster: string; title: string }) {
  const [active, setActive] = useState(false);
  return (
    <div className="group relative aspect-[9/16] w-full overflow-hidden rounded-[18px] border border-violet-400/20 bg-black/40 shadow-[0_18px_60px_-22px_rgba(139,92,246,.5)]">
      {active ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={src}
          poster={poster}
          className="absolute inset-0 h-full w-full object-cover"
          controls
          autoPlay
          playsInline
        />
      ) : (
        <button
          type="button"
          onClick={() => setActive(true)}
          aria-label={`เล่นคลิป: ${title}`}
          className="absolute inset-0 h-full w-full cursor-pointer"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={poster}
            alt={title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03] group-hover:brightness-110"
          />
          <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/5 to-black/20" aria-hidden />
          <span
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white transition duration-300 group-hover:scale-110"
            style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", boxShadow: "0 0 34px rgba(139,92,246,.55)" }}
            aria-hidden
          >
            <Play className="ml-0.5 h-6 w-6 fill-current" strokeWidth={0} />
          </span>
        </button>
      )}
    </div>
  );
}
