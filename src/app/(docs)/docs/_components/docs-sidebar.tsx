"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { docsByCategory } from "../_content/registry";

export function DocsSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          "z-40 w-64 shrink-0 overflow-y-auto",
          "fixed inset-y-0 left-0 top-16 transition-transform md:static md:top-0 md:translate-x-0 md:block",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        style={{ background: "var(--ui-sidebar-bg)", borderRight: "1px solid var(--ui-divider)" }}>
        <nav className="space-y-5 px-3 py-5">
          {docsByCategory.map((cat) => (
            <div key={cat.name}>
              <p className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>{cat.name}</p>
              <div className="space-y-0.5">
                {cat.items.map((m) => {
                  const href = `/docs/${m.slug}`;
                  const active = pathname === href;
                  return (
                    <Link key={m.slug} href={href} onClick={onClose}
                      className={cn("block rounded-lg px-2 py-1.5 text-[13px] transition-colors", active ? "font-semibold" : "hover:bg-white/5")}
                      style={{
                        background: active ? "hsl(262 83% 58% / 0.12)" : undefined,
                        color: active ? "var(--ui-text-primary)" : "var(--ui-text-secondary)",
                      }}>
                      {m.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
