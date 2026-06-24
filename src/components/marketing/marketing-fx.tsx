/**
 * Animated page atmosphere: three violet light-beams that visibly drift + pulse,
 * over a faint grid that pans. Pure CSS (keyframes in globals.css) so it stays a
 * server component and auto-respects prefers-reduced-motion.
 */
export function SaleBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="sp-beam-1 absolute left-1/2 top-[-20vw] h-[60vw] w-[60vw] rounded-full blur-[120px]"
        style={{ background: "radial-gradient(circle,#7c3aed,transparent 60%)", opacity: 0.4 }}
      />
      <div
        className="sp-beam-2 absolute left-1/2 top-[22vw] h-[46vw] w-[46vw] rounded-full blur-[120px]"
        style={{ background: "radial-gradient(circle,#8b5cf6,transparent 60%)", opacity: 0.3 }}
      />
      <div
        className="sp-beam-3 absolute left-1/2 bottom-[-24vw] h-[52vw] w-[52vw] rounded-full blur-[120px]"
        style={{ background: "radial-gradient(circle,#a78bfa,transparent 60%)", opacity: 0.24 }}
      />
      <div
        className="sp-grid-anim absolute inset-0 opacity-[0.06]"
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
