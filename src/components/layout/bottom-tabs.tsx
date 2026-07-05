"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Clapperboard, Video, Settings } from "lucide-react";

/**
 * Mobile bottom-tab bar (native-app IA). Visible only below `lg`; the desktop
 * sidebar owns navigation at `lg`+. Four primary destinations, role-agnostic —
 * secondary/admin links live in the hamburger → MobileSidebar drawer.
 *
 * House look: `--ui-nav-*` surface, single violet accent (#8B5CF6) for the active
 * tab + a short top indicator. Each tab ≥44px tall with `safe-area-inset-bottom`
 * padding so it clears the iOS home indicator.
 */
const tabs = [
  { title: "Dashboard", href: "/dashboard",    icon: LayoutDashboard },
  { title: "Editor",    href: "/video-editor", icon: Clapperboard },
  { title: "Gallery",   href: "/videos",       icon: Video },
  { title: "Settings",  href: "/settings",     icon: Settings },
] as const;

const ACCENT = "#8B5CF6";

export function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 lg:hidden"
      aria-label="เมนูหลัก"
      style={{
        background: "var(--ui-nav-bg)",
        borderTop: "1px solid var(--ui-nav-border)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {tabs.map(({ title, href, icon: Icon }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
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
