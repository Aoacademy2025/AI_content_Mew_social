import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <div className="flex h-screen w-60 shrink-0 flex-col border-r border-white/5 p-3"
      style={{ background: "var(--ui-sidebar-bg, #0d0d18)" }}>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3 py-3 mb-3">
        <Skeleton className="h-7 w-7 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
      {/* Nav items */}
      <div className="flex flex-col gap-1">
        {[80, 52, 72, 96, 88, 60, 64, 56].map((w, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-lg px-3 py-2">
            <Skeleton className="h-4 w-4 rounded shrink-0" />
            <Skeleton className={`h-3.5 w-${w > 80 ? "[96px]" : w > 70 ? "[80px]" : w > 60 ? "[72px]" : "[56px]"}`} />
          </div>
        ))}
      </div>
      {/* Bottom user */}
      <div className="mt-auto border-t border-white/5 pt-3 px-3">
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex flex-col gap-1.5 flex-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-16" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen" style={{ background: "var(--ui-bg, #080810)" }}>
      <SidebarSkeleton />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
