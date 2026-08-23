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
        className="absolute -left-72 top-[48rem] h-[38rem] w-[38rem] rounded-full opacity-30 blur-[120px]"
        style={{ background: "radial-gradient(circle,rgba(139,92,246,.32),transparent 68%)" }}
      />
      <div
        className="sale-v2-grid absolute inset-x-0 top-0 h-[52rem] opacity-35"
      />
      <span className="absolute left-[8%] top-0 h-[42rem] w-px bg-gradient-to-b from-violet-300/12 via-white/[0.025] to-transparent" />
      <span className="absolute right-[8%] top-0 h-[42rem] w-px bg-gradient-to-b from-violet-300/10 via-white/[0.02] to-transparent" />
    </div>
  );
}
