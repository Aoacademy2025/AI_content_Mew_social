export function SliderRow({ value, min, max, onChange, unit = "" }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 relative h-1 rounded bg-slate-700 cursor-pointer"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onChange(Math.round(min + ((e.clientX - r.left) / r.width) * (max - min))); }}>
        <div className="absolute left-0 top-0 h-full rounded bg-violet-500" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.5)]" style={{ left: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-slate-500 min-w-[36px] text-right tabular-nums">{value}{unit}</span>
    </div>
  );
}
