"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { Settings, CreditCard, Handshake, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FadeSwap } from "@/components/ui/fade-swap";
import { UserAvatar } from "@/components/layout/user-avatar";
import { fetchMe } from "@/lib/use-me";

/**
 * Shared account control — real-photo avatar trigger + dropdown
 * (user label + Settings · Billing · Logout). Identity comes from fetchMe() (DB
 * name + uploaded avatar) so the editor topbar matches the sidebar instead of
 * showing the Clerk-only initials. Sign-out stays on Clerk.
 *
 * `extraItems` renders optional DropdownMenuItems ABOVE the Settings/Billing/Logout
 * block (used by the editor topbar to fold desktop-only links — วิธีใช้งาน / ?ui=v1
 * — into the menu on mobile).
 */
export function AccountMenu({ extraItems }: { extraItems?: React.ReactNode }) {
  const { signOut } = useClerk();
  const [me, setMe] = useState<{ name?: string; email?: string; avatar?: string | null } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetchMe()
      .then((d) => {
        if (!active) return;
        setMe(d ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const displayName = me?.name ?? "";
  const displayEmail = me?.email ?? "";
  const avatar = me?.avatar ?? null;

  return (
    <FadeSwap
      ready={loaded}
      className="h-8 w-8 shrink-0"
      skeleton={<div className="h-8 w-8 rounded-full skeleton-wave" />}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="บัญชีผู้ใช้"
            className="block h-8 w-8 shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[#8B5CF6]/60"
          >
            <UserAvatar name={displayName} avatar={avatar} size={32} />
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
                {displayName || "User"}
              </p>
              {displayEmail && (
                <p className="text-xs leading-none" style={{ color: "var(--ui-text-muted)" }}>
                  {displayEmail}
                </p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator style={{ background: "var(--ui-divider)" }} />
          {extraItems}
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link href="/settings">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link href="/settings?tab=billing">
              <CreditCard className="mr-2 h-4 w-4" />
              Billing
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="cursor-pointer">
            <a href="https://affiliate.heroaiengine.com/affiliate-program" target="_blank" rel="noopener noreferrer">
              <Handshake className="mr-2 h-4 w-4" />
              Affiliate — รับค่าคอม 25%
            </a>
          </DropdownMenuItem>
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
  );
}
