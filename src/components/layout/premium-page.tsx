"use client";

/**
 * Shared premium "sci-fi / neon" page chrome.
 *
 * One source of truth for the look first shipped on /dashboard and /docs:
 *   - <PremiumBackdrop>  full-page animated grid + floating orbs
 *   - <PremiumCard>      glass card with animated neon border + corner brackets
 *   - <CornerBrackets>   cyberpunk corner ticks
 *   - <PremiumEyebrow>   small uppercase label with pulsing dot
 *   - <PremiumPage>      convenience wrapper: scroll container + backdrop + centered content
 *
 * The actual CSS lives in globals.css under the `pp-*` prefix so it's
 * loaded once and works in both light and dark mode.
 */

import { cn } from "@/lib/utils";

type Accent = "cyan" | "violet" | "amber" | "emerald";

const ACCENT_BORDER: Record<Accent, string> = {
  cyan: "border-cyan-400/40",
  violet: "border-violet-400/40",
  amber: "border-amber-400/40",
  emerald: "border-emerald-400/40",
};

/** Cyberpunk corner ticks — purely decorative. */
export function CornerBrackets({ color = "cyan" }: { color?: Accent }) {
  const C = `absolute h-3 w-3 ${ACCENT_BORDER[color]} pointer-events-none`;
  return (
    <>
      <span aria-hidden className={`${C} top-2 left-2 border-t border-l rounded-tl-sm`} />
      <span aria-hidden className={`${C} top-2 right-2 border-t border-r rounded-tr-sm`} />
      <span aria-hidden className={`${C} bottom-2 left-2 border-b border-l rounded-bl-sm`} />
      <span aria-hidden className={`${C} bottom-2 right-2 border-b border-r rounded-br-sm`} />
    </>
  );
}

/**
 * Full-page animated backdrop: drifting grid + 5 floating gradient orbs.
 * Render once near the top of a page, behind the content (it's fixed + z-0).
 */
export function PremiumBackdrop() {
  return (
    <>
      <div aria-hidden className="pp-grid-bg pointer-events-none fixed inset-0 z-0" />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div
          className="pp-orb-1 absolute -top-32 left-[15%] h-112 w-md rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)" }}
        />
        <div
          className="pp-orb-2 absolute -top-20 right-[10%] h-96 w-96 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)" }}
        />
        <div
          className="pp-orb-3 absolute top-[40%] left-1/2 -translate-x-1/2 h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(285 70% 60%), transparent)" }}
        />
        <div
          className="pp-orb-1 absolute bottom-[15%] right-[8%] h-96 w-96 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)", animationDelay: "-7s" }}
        />
        <div
          className="pp-orb-2 absolute bottom-[5%] left-[10%] h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)", animationDelay: "-12s" }}
        />
      </div>
    </>
  );
}

/**
 * Glass card with animated neon border + corner brackets.
 * Set `interactive` for the hover lift + faster border spin (use on links/buttons).
 */
export function PremiumCard({
  children,
  className,
  interactive,
  brackets = true,
  bracketColor = "cyan",
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  brackets?: boolean;
  bracketColor?: Accent;
}) {
  return (
    <div
      className={cn(
        "pp-card overflow-hidden relative",
        interactive && "pp-card-interactive",
        className
      )}
      {...rest}
    >
      <span aria-hidden className="pp-card-border" />
      {brackets && <CornerBrackets color={bracketColor} />}
      {children}
    </div>
  );
}

/** Small uppercase eyebrow label with a leading rule + pulsing dot. */
export function PremiumEyebrow({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/70",
        className
      )}
      style={style}
    >
      <span className="h-px w-6 bg-linear-to-r from-transparent to-cyan-400/50" />
      {children}
    </div>
  );
}

/**
 * Convenience page shell: marks the route as full-bleed (.ve-no-padding),
 * mounts the backdrop, and provides a centered, max-width content column.
 * Pages that need a custom layout can compose <PremiumBackdrop> directly instead.
 */
export function PremiumPage({
  children,
  className,
  maxWidth = "max-w-6xl",
}: {
  children: React.ReactNode;
  className?: string;
  maxWidth?: string;
}) {
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <PremiumBackdrop />
      <div className={cn("relative z-10 mx-auto px-4 md:px-6 pt-3 md:pt-4 pb-12", maxWidth, className)}>
        {children}
      </div>
    </div>
  );
}
