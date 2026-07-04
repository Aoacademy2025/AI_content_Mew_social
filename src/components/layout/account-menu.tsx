"use client";

import { useUser, useClerk } from "@clerk/nextjs";
import { LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FadeSwap } from "@/components/ui/fade-swap";

/**
 * Shared account control — gradient-initials avatar trigger + dropdown
 * (user label + Logout). Extracted verbatim from the TopNav inline block so the
 * top nav AND the full-screen editor topbar share ONE Clerk-backed account menu.
 *
 * `extraItems` renders optional DropdownMenuItems ABOVE Logout (used by the editor
 * topbar to fold desktop-only links — วิธีใช้งาน / ?ui=v1 — into the menu on mobile).
 * With no extraItems the output is byte-identical to the original TopNav menu.
 */
export function AccountMenu({ extraItems }: { extraItems?: React.ReactNode }) {
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
              background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(258 90% 55%))",
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
          {extraItems}
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
  );
}
