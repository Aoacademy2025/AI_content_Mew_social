"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Clapperboard, Video, Settings, NotebookPen } from "lucide-react";

/**
 * Mobile bottom-tab bar (native-app IA). Visible only below `lg`; the desktop
 * sidebar owns navigation at `lg`+. The five tabs follow the core creation
 * journey; AI Studio and secondary/admin links remain in the drawer.
 *
 * House look: `--ui-nav-*` surface, single violet accent (#8B5CF6) for the active
 * tab + a short top indicator. Each tab ≥44px tall with `safe-area-inset-bottom`
 * padding so it clears the iOS home indicator.
 */
const tabs = [
  { title: "Dashboard", href: "/dashboard",    icon: LayoutDashboard, featured: false },
  { title: "สคริปต์",    href: "/hero-script",  icon: NotebookPen,     featured: false },
  { title: "สร้างคลิป",  href: "/video-editor", icon: Clapperboard,    featured: true },
  { title: "Gallery",   href: "/videos",       icon: Video,           featured: false },
  { title: "ตั้งค่า",    href: "/settings",     icon: Settings,        featured: false },
] as const;

const ACCENT = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";

export function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 grid lg:hidden"
      aria-label="เมนูหลัก"
      style={{
        background: "var(--ui-nav-bg)",
        borderTop: "1px solid var(--ui-nav-border)",
        paddingBottom: "env(safe-area-inset-bottom)",
        gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
      }}
    >
      {tabs.map(({ title, href, icon: Icon, featured }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
        if (featured) {
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              aria-current={isActive ? "page" : undefined}
              className="relative flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-1.5 transition-transform active:scale-95"
              style={{ color: isActive ? ACCENT : "var(--ui-text-primary)" }}
            >
              <span
                className="flex h-8 w-12 items-center justify-center rounded-full text-white"
                style={{
                  background: VIOLET_GRAD,
                  boxShadow: isActive
                    ? "0 4px 16px rgba(108,76,244,0.55)"
                    : "0 2px 10px rgba(108,76,244,0.38)",
                }}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={2.4} />
              </span>
              <span className="text-[10px] font-semibold leading-none">{title}</span>
            </Link>
          );
        }
        return (
          <Link
            key={href}
            href={href}
            prefetch={true}
            aria-current={isActive ? "page" : undefined}
            className="relative flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 transition-colors"
            style={{ color: isActive ? ACCENT : "var(--ui-text-muted)" }}
          >
            {isActive && (
              <span
                aria-hidden
                className="absolute top-0 h-0.5 w-8 rounded-full"
                style={{ background: ACCENT }}
              />
            )}
            <Icon className="h-5 w-5 shrink-0" strokeWidth={isActive ? 2.4 : 2} />
            <span className="text-[10px] font-medium leading-none">{title}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default BottomTabs;
