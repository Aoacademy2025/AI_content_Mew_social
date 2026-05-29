"use client";

export function SliderRow({ value, min, max, onChange, unit = "" }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  const pct = ((value - min) / (max - min)) * 100;

  const setFromClientX = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onChange(Math.round(min + ratio * (max - min)));
  };

  return (
    <div className="flex items-center gap-2">
      {/* Wider hit area (h-5) so clicks/drags land easily; track sits centered inside */}
      <div
        className="flex-1 relative h-5 cursor-pointer flex items-center touch-none select-none"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromClientX(e.clientX, e.currentTarget);
        }}
        onPointerMove={e => {
          if (e.buttons !== 1) return;
          setFromClientX(e.clientX, e.currentTarget);
        }}
      >
        <div className="relative w-full h-1 rounded bg-slate-700 pointer-events-none">
          <div className="absolute left-0 top-0 h-full rounded bg-violet-500" style={{ width: `${pct}%` }} />
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.5)]"
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
      <span className="text-[11px] text-slate-500 min-w-[36px] text-right tabular-nums">{value}{unit}</span>
    </div>
  );
}
