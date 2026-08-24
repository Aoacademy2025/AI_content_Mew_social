/** Editorial backdrop for the public sale page. The product and copy stay in
 * focus; the backdrop only adds depth and a faint studio-grid reference.
 */
export function SaleBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="sale-v2-orb absolute -top-[28rem] left-[43%] h-[52rem] w-[52rem] rounded-full blur-[100px]"
        style={{ background: "radial-gradient(circle,rgba(139,92,246,.28),rgba(94,54,160,.1) 42%,transparent 70%)" }}
      />
      <div
        className="sp-beam-1 absolute left-1/2 top-[-16rem] h-[36rem] w-[76rem] rounded-[50%] blur-[90px]"
        style={{ background: "radial-gradient(ellipse,rgba(139,92,246,.30),rgba(104,68,239,.09) 48%,transparent 72%)" }}
      />
      <div
        className="sp-beam-2 absolute left-[65%] top-[8rem] h-[28rem] w-[52rem] rounded-[50%] blur-[100px]"
        style={{ background: "radial-gradient(ellipse,rgba(190,160,255,.18),transparent 70%)" }}
      />
      <div
        className="sp-beam-3 absolute left-[28%] top-[40rem] h-[24rem] w-[46rem] rounded-[50%] blur-[110px]"
        style={{ background: "radial-gradient(ellipse,rgba(120,87,246,.17),transparent 68%)" }}
      />
      <div
        className="absolute -left-72 top-[48rem] h-[38rem] w-[38rem] rounded-full opacity-30 blur-[120px]"
        style={{ background: "radial-gradient(circle,rgba(139,92,246,.32),transparent 68%)" }}
      />
      <div
        className="sale-v2-grid sp-grid-anim absolute inset-x-0 top-0 h-[58rem] opacity-35"
      />
      <span className="absolute left-[8%] top-0 h-[42rem] w-px bg-gradient-to-b from-violet-300/12 via-white/[0.025] to-transparent" />
      <span className="absolute right-[8%] top-0 h-[42rem] w-px bg-gradient-to-b from-violet-300/10 via-white/[0.02] to-transparent" />
    </div>
  );
}
