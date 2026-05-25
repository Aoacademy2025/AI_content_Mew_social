import { Skeleton } from "@/components/ui/skeleton";

/**
 * Generic page-content skeleton — content only (DashboardLayout wraps from
 * (dashboard)/layout.tsx so sidebar/topnav stay mounted across navigations).
 */
type Variant = "cards" | "list" | "grid" | "detail" | "form";

interface PageSkeletonProps {
  title?: string;
  subtitle?: string;
  variant?: Variant;
  /** Number of skeleton items to show (defaults vary by variant) */
  count?: number;
}

export function PageSkeleton({ title, subtitle, variant = "cards", count }: PageSkeletonProps) {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
        {/* Header — title + subtitle */}
        <div className="space-y-2">
          {title ? (
            <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>{title}</h1>
          ) : (
            <Skeleton className="h-7 w-40" />
          )}
          {subtitle ? (
            <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>{subtitle}</p>
          ) : (
            <Skeleton className="h-4 w-72" />
          )}
        </div>

        {variant === "cards" && <CardsSkeleton count={count ?? 3} />}
        {variant === "list"  && <ListSkeleton count={count ?? 6} />}
        {variant === "grid"  && <GridSkeleton count={count ?? 8} />}
        {variant === "detail" && <DetailSkeleton />}
        {variant === "form"  && <FormSkeleton count={count ?? 5} />}
    </div>
  );
}

function CardsSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-3 sm:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-white/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="h-9 w-32" />
          <div className="space-y-2 pt-2">
            {[100, 85, 70, 55].map((w, j) => (
              <div key={j} className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <Skeleton className="h-3" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function ListSkeleton({ count }: { count: number }) {
  return (
    <div className="rounded-xl border border-white/5 overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-b-0">
          <Skeleton className="h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5" style={{ width: `${60 + (i * 7) % 35}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${40 + (i * 11) % 25}%` }} />
          </div>
          <Skeleton className="h-7 w-16 rounded-md shrink-0" />
        </div>
      ))}
    </div>
  );
}

function GridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-4 md:grid-cols-3 sm:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-white/5 overflow-hidden">
          <Skeleton className="aspect-video w-full" />
          <div className="p-3 space-y-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/5 p-6 space-y-4">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3.5 w-1/3" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map(i => (
          <div key={i} className="rounded-xl border border-white/5 p-5 space-y-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FormSkeleton({ count }: { count: number }) {
  return (
    <div className="rounded-xl border border-white/5 p-6 space-y-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ))}
      <div className="flex justify-end pt-2">
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>
    </div>
  );
}
