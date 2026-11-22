"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Plus } from "lucide-react";
import { NotificationBell } from "@/components/layout/notification-bell";

export function TopNav({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname();
  const isOnVideoEditor = pathname === "/video-editor" || pathname.startsWith("/video-editor/");

  return (
    <div
      className="flex h-16 w-full shrink-0 items-center justify-between px-4 sm:px-8"
      style={{
        background: "var(--ui-nav-bg)",
        borderBottom: "1px solid var(--ui-nav-border)",
      }}
    >
      {/* Left — hamburger (mobile) + brand */}
      <div className="flex items-center gap-1">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="เปิดเมนู"
            className="-ml-1.5 mr-1 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-white/5 lg:hidden"
            style={{ color: "var(--ui-text-secondary)" }}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Link
          href="/dashboard"
          className="group flex items-center gap-2.5 mr-4 transition-opacity hover:opacity-90"
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
      </div>

      {/* Right — primary creation CTA + notification bell */}
      <div className="flex items-center gap-2 sm:gap-3">
        {!isOnVideoEditor && (
          <Link
            href="/video-editor"
            prefetch={true}
            className="inline-flex min-h-[36px] sm:min-h-[38px] items-center justify-center gap-1.5 rounded-xl px-3 sm:px-3.5 text-xs sm:text-[13px] font-semibold text-white transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]/60"
            style={{
              background: "linear-gradient(180deg,#8B66F8,#6C4CF4)",
              boxShadow: "0 2px 12px rgba(108,76,244,0.35)",
            }}
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>สร้างคลิปใหม่</span>
          </Link>
        )}
        <NotificationBell />
      </div>
    </div>
  );
}
