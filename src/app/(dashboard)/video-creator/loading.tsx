export default function VideoCreatorLoading() {
  return (
    <div className="ve-no-padding flex flex-col h-full w-full bg-[#0a0a14] overflow-hidden">
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <div className="h-7 w-40 rounded-lg skeleton-wave" />
          <div className="h-8 w-28 rounded-lg skeleton-wave" />
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-80 border-r border-white/5 p-4 space-y-3">
            <div className="h-4 w-20 rounded skeleton-wave" />
            <div className="h-40 w-full rounded-lg skeleton-wave" />
            <div className="h-9 w-full rounded-lg skeleton-wave" />
          </div>
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="aspect-[9/16] h-full max-h-[600px] rounded-2xl skeleton-wave" />
          </div>
          <div className="w-72 border-l border-white/5 p-4 space-y-3">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-16 rounded skeleton-wave" />
                <div className="h-9 rounded-lg skeleton-wave" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
