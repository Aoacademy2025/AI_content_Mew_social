export function ColorDots({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {colors.map(c => (
        <button key={c} onClick={() => onChange(c)}
          className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 flex-shrink-0"
          style={{ background: c, borderColor: value === c ? "#fff" : "transparent", boxShadow: value === c ? "0 0 0 1px #7c3aed" : "none" }} />
      ))}
      <button className="w-5 h-5 rounded-full border border-dashed border-slate-600 flex items-center justify-center text-slate-500 hover:border-slate-400 text-xs">+</button>
    </div>
  );
}
