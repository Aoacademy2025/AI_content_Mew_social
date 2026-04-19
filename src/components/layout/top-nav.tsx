"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { LogOut, Menu, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "@/components/layout/notification-bell";

const navLinks = [
  { title: "Docs", href: "/docs" },
];

export function TopNav({ onMenuClick }: { onMenuClick?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [initials, setInitials] = useState("U");
  const [displayName, setDisplayName] = useState("");
  const [displayEmail, setDisplayEmail] = useState("");

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (session?.user?.name) {
      setInitials(session.user.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2));
      setDisplayName(session.user.name);
    }
    if (session?.user?.email) setDisplayEmail(session.user.email);
  }, [session?.user?.name, session?.user?.email]);

  return (
    <div
      className="flex h-16 w-full shrink-0 items-center justify-between px-8"
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
        <span
          className="text-lg font-bold tracking-tight mr-6"
          style={{ color: "hsl(190 100% 50%)" }}
        >
          Mew Social
        </span>

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
        {/* Theme toggle */}
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
          style={{
            border: "1px solid var(--ui-btn-border)",
            color: "var(--ui-text-secondary)",
          }}
          suppressHydrationWarning
        >
          {mounted && resolvedTheme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>

        {/* Bell */}
        <NotificationBell />

        {/* User avatar with dropdown */}
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
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
