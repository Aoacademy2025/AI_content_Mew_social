"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Menu, LogOut, Bell } from "lucide-react";

interface HeaderProps {
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string;
    plan?: string;
    avatar?: string | null;
  };
  onMenuClick?: () => void;
}

export function Header({ user, onMenuClick }: HeaderProps) {
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  return (
    <header
      className="flex h-14 items-center justify-between px-6"
      style={{ background: "hsl(221 39% 8%)", borderBottom: "1px solid hsl(220 30% 14%)" }}
    >
      {/* Left — mobile menu */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden text-white/50 hover:text-white hover:bg-white/5"
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
        </Button>
      </div>

      {/* Right — actions + user */}
      <div className="flex items-center gap-2 ml-auto">
        {/* Notification bell */}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white/80"
          style={{ background: "hsl(220 30% 14%)" }}
        >
          <Bell className="h-4 w-4" />
        </button>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-80"
              style={{ background: "hsl(220 30% 18%)" }}>
              <Avatar className="h-9 w-9">
                {user?.avatar && (
                  <AvatarImage src={user.avatar} alt={user.name || ""} className="object-cover" />
                )}
                <AvatarFallback
                  className="text-xs font-bold text-white rounded-full"
                  style={{ background: "hsl(220 30% 22%)" }}
                >
                  {initials}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-56 border"
            style={{ background: "hsl(221 39% 10%)", borderColor: "hsl(220 30% 18%)" }}
            align="end"
          >
            <DropdownMenuLabel>
              <div className="flex flex-col space-y-0.5">
                <p className="text-sm font-medium text-white leading-none">{user?.name}</p>
                <p className="text-xs leading-none text-white/40">{user?.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator style={{ background: "hsl(220 30% 16%)" }} />
            <DropdownMenuItem
              className="cursor-pointer text-red-400 focus:text-red-400 focus:bg-red-500/10"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
