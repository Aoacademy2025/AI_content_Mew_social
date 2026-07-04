"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/layout/notification-bell";

const navLinks = [
  { title: "วิธีใช้งาน", href: "/docs" },
];

export function TopNav({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname();

  return (
    <div
      className="flex h-16 w-full shrink-0 items-center justify-between px-4 sm:px-8"
      style={{
        background: "var(--ui-nav-bg)",
        borderBottom: "1px solid var(--ui-nav-border)",
      }}
    >
      {/* Left — hamburger (mobile) + brand + links */}
      <div className="flex items-center gap-1">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            aria-label="เปิดเมนู"
            className="mr-2 flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-white/5 lg:hidden"
            style={{ color: "var(--ui-text-secondary)" }}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Link
          href="/dashboard"
          className="group flex items-center gap-2.5 mr-6 transition-opacity hover:opacity-90"
          aria-label="Hero AI Creator Studio"
        >
          <span
            className="relative flex h-8 w-8 items-center justify-center rounded-xl shrink-0 overflow-hidden text-[15px] font-semibold leading-none text-white"
            style={{
              background: "linear-gradient(180deg,#8B66F8,#6C4CF4)",
              boxShadow: "0 4px 14px rgba(108,76,244,0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
              fontFamily: "Kanit, sans-serif",
            }}
          >
            H
            <span
              aria-hidden
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.35), transparent 60%)" }}
            />
          </span>
          <span className="hidden sm:inline text-[15px] font-bold tracking-tight text-white leading-none">
            Hero AI Creator Studio
          </span>
          <span className="sm:hidden text-[13px] font-bold tracking-tight text-white leading-none">
            Hero AI
          </span>
        </Link>

        {navLinks.map(({ title, href }) => {
          const isActive = pathname === href || pathname.startsWith(href.split("?")[0]);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                isActive
                  ? "font-semibold"
                  : "hover:bg-black/5 dark:hover:bg-white/5"
              )}
              style={{ color: isActive ? "var(--ui-text-primary)" : "var(--ui-text-secondary)" }}
            >
              {title}
            </Link>
          );
        })}
      </div>

      {/* Right — actions. Account hub now lives in the sidebar user header;
          the dashboard topbar-right is the notification bell only. */}
      <div className="flex items-center gap-2">
        <NotificationBell />
      </div>
    </div>
  );
}
