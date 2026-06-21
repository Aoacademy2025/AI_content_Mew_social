import { cn } from "@/lib/utils";

/**
 * Animated page atmosphere: two slowly-drifting violet beams + a faint grid that
 * pans. Pure CSS (keyframes in globals.css) so it stays a server component and
 * auto-respects prefers-reduced-motion. Replaces the old static glow layer.
 */
export function SaleBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="sp-beam-1 absolute left-1/2 top-[-18vw] h-[64vw] w-[64vw] rounded-full blur-[130px]"
        style={{ background: "radial-gradient(circle,#6d28d9,transparent 60%)" }}
      />
      <div
        className="sp-beam-2 absolute left-1/2 bottom-[-24vw] h-[52vw] w-[52vw] rounded-full blur-[130px]"
        style={{ background: "radial-gradient(circle,#8b5cf6,transparent 60%)" }}
      />
      <div
        className="sp-grid-anim absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg,#ffffff 1px, transparent 1px)",
          backgroundSize: "68px 68px",
          maskImage: "radial-gradient(ellipse 80% 55% at 50% 0%, #000 30%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 55% at 50% 0%, #000 30%, transparent 78%)",
        }}
      />
    </div>
  );
}

/**
 * A light comet that travels around the parent's rounded border (magicui-style).
 * Drop inside any `position:relative; rounded-*` box. Pure CSS — keyframe
 * `sp-border-beam` lives in globals.css.
 */
export function BorderBeam({
  size = 60,
  duration = 7,
  delay = 0,
  className,
}: {
  size?: number;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
      style={{
        border: "1px solid transparent",
        maskClip: "padding-box, border-box",
        WebkitMaskClip: "padding-box, border-box",
        maskComposite: "intersect",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(transparent, transparent), linear-gradient(#000, #000)",
        WebkitMask: "linear-gradient(transparent, transparent), linear-gradient(#000, #000)",
      }}
    >
      <div
        className={cn("absolute aspect-square", className)}
        style={{
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          background: "linear-gradient(to left, #c4b5fd, #8b5cf6, transparent)",
          animation: `sp-border-beam ${duration}s linear ${delay}s infinite`,
        }}
      />
    </div>
  );
}
