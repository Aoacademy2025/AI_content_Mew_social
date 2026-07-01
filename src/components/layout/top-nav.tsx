"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser, useClerk } from "@clerk/nextjs";
import { LogOut, Menu, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { FadeSwap } from "@/components/ui/fade-swap";

const navLinks = [
  { title: "วิธีใช้งาน", href: "/docs" },
];

export function TopNav({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname();
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();

  const displayName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress?.split("@")[0] ?? "";
  const displayEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "U";

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
            className="mr-2 flex h-8 w-8 items-center justify-center rounded-lg transition-colors md:hidden"
            style={{ color: "var(--ui-text-secondary)" }}
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        <Link
          href="/dashboard"
          className="group flex items-center gap-2.5 mr-6 transition-opacity hover:opacity-90"
          aria-label="Hero AI Creator Studio"
        >
          <span
            className="relative flex h-8 w-8 items-center justify-center rounded-xl shrink-0 overflow-hidden"
            style={{
              background: "linear-gradient(135deg, hsl(220 100% 60%), hsl(252 83% 60%))",
              boxShadow: "0 4px 14px hsl(252 83% 60% / 0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
          >
            <Sparkles className="h-4 w-4 text-white" strokeWidth={2.5} />
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

      {/* Right — actions */}
      <div className="flex items-center gap-2">
        <NotificationBell />

        <FadeSwap
          ready={isLoaded}
          className="h-8 w-8 shrink-0"
          skeleton={<div className="h-8 w-8 rounded-full skeleton-wave" />}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white transition-opacity hover:opacity-80"
                style={{
                  background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 40%))",
                }}
              >
                {initials}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-56 border"
              style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}
              align="end"
            >
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-0.5">
                  <p className="text-sm font-medium leading-none" style={{ color: "var(--ui-text-primary)" }}>
                    {displayName}
                  </p>
                  <p className="text-xs leading-none" style={{ color: "var(--ui-text-muted)" }}>
                    {displayEmail}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator style={{ background: "var(--ui-divider)" }} />
              <DropdownMenuItem
                className="cursor-pointer text-red-500 focus:text-red-500 focus:bg-red-500/10"
                onClick={() => signOut({ redirectUrl: "/login" })}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </FadeSwap>
      </div>
    </div>
  );
}
