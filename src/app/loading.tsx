import { Skeleton } from "@/components/ui/skeleton";

export default function RootLoading() {
  return (
    <div className="min-h-screen bg-[#080810] overflow-x-hidden">
      {/* Navbar skeleton */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
      </div>

      {/* Hero skeleton */}
      <div className="flex flex-col items-center justify-center px-6 pt-24 pb-20 text-center space-y-6">
        <Skeleton className="h-7 w-64 rounded-full" />
        <div className="space-y-3">
          <Skeleton className="h-14 w-80 mx-auto rounded-lg" />
          <Skeleton className="h-14 w-56 mx-auto rounded-lg" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-5 w-96 mx-auto" />
          <Skeleton className="h-5 w-72 mx-auto" />
        </div>
        <div className="flex gap-4 justify-center pt-2">
          <Skeleton className="h-12 w-40 rounded-full" />
          <Skeleton className="h-12 w-32 rounded-full" />
        </div>
      </div>

      {/* Features skeleton */}
      <div className="px-6 py-16 max-w-6xl mx-auto">
        <div className="flex flex-col items-center gap-3 mb-12">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-56" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/8 p-6 space-y-4">
              <Skeleton className="h-11 w-11 rounded-xl" />
              <Skeleton className="h-5 w-40" />
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing skeleton */}
      <div className="px-6 py-16 max-w-6xl mx-auto">
        <div className="flex flex-col items-center gap-3 mb-12">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/8 p-7 space-y-5">
              <div className="space-y-2">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-10 w-28" />
              </div>
              <div className="space-y-2.5">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="flex items-center gap-2">
                    <Skeleton className="h-4 w-4 rounded-sm shrink-0" />
                    <Skeleton className="h-3.5 w-full" />
                  </div>
                ))}
              </div>
              <Skeleton className="h-11 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
