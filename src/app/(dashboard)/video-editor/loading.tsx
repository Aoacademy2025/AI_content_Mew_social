export default function VideoEditorLoading() {
  return (
    <div className="ve-no-padding flex flex-col h-full w-full bg-[#0a0a14] overflow-hidden">
      <div className="flex flex-col h-full w-full overflow-hidden">
        {/* Top toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="h-7 w-32 rounded-lg skeleton-wave" />
            <div className="h-7 w-20 rounded-lg skeleton-wave" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-20 rounded-lg skeleton-wave" />
            <div className="h-8 w-28 rounded-lg skeleton-wave" />
          </div>
        </div>

        {/* Main body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Transcript */}
          <div className="w-80 border-r border-white/5 p-4 space-y-3">
            <div className="h-4 w-24 rounded skeleton-wave" />
            <div className="h-32 w-full rounded-lg skeleton-wave" />
            <div className="h-3 w-20 rounded skeleton-wave" />
            <div className="space-y-2">
              {[0, 1, 2].map(i => <div key={i} className="h-12 rounded-lg skeleton-wave" />)}
            </div>
          </div>

          {/* Center: Preview */}
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="aspect-[9/16] h-full max-h-[600px] rounded-2xl skeleton-wave" />
          </div>

          {/* Right: Settings */}
          <div className="w-72 border-l border-white/5 p-4 space-y-3">
            <div className="h-4 w-20 rounded skeleton-wave" />
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map(i => <div key={i} className="h-9 rounded-lg skeleton-wave" />)}
            </div>
            <div className="h-3 w-16 rounded skeleton-wave mt-4" />
            <div className="h-10 rounded-lg skeleton-wave" />
            <div className="h-3 w-14 rounded skeleton-wave mt-4" />
            <div className="h-24 rounded-lg skeleton-wave" />
          </div>
        </div>

        {/* Timeline */}
        <div className="h-44 border-t border-white/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-3 w-16 rounded skeleton-wave" />
            <div className="h-6 w-20 rounded skeleton-wave" />
          </div>
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-3 w-12 rounded skeleton-wave shrink-0" />
              <div className="h-8 flex-1 rounded skeleton-wave" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
