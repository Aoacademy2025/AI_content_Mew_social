import { Skeleton } from "@/components/ui/skeleton";

export default function AuthLoading() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#080810]">
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

      {/* Background glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 h-96 w-96 rounded-full bg-violet-600/5 blur-[120px]" />
      </div>

      {/* Card skeleton */}
      <div className="flex flex-1 items-center justify-center py-12 px-4">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 space-y-6">
          {/* Icon + title */}
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-14 w-14 rounded-full" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-52" />
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ))}
          </div>

          {/* Button */}
          <Skeleton className="h-10 w-full rounded-md" />

          {/* Divider + link */}
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
    </div>
  );
}
