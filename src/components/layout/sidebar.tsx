"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Palette, FileText, Settings, Users, Film, Shield, Lock,
  LayoutDashboard, Video, HelpCircle, ChevronLeft, ChevronRight, Ticket,
} from "lucide-react";
import { SupportModal } from "@/components/ui/support-modal";

interface SidebarProps {
  role?: "ADMIN" | "USER";
  collapsed?: boolean;
  onToggle?: () => void;
}

const adminNavItems = [
  { title: "Admin",       href: "/admin",         icon: Shield,  proOnly: false },
  { title: "จัดการผู้ใช้", href: "/admin/users",  icon: Users,   proOnly: false },
  { title: "คูปอง",        href: "/admin/coupons", icon: Ticket,  proOnly: false },
];

const userNavItems: { title: string; href: string; icon: React.ElementType; locked?: boolean; adminOnly?: boolean }[] = [
  { title: "Dashboard",     href: "/dashboard",  icon: LayoutDashboard },
  { title: "Styles",        href: "/style",       icon: Palette, adminOnly: true },
  { title: "Content",       href: "/content",     icon: FileText, adminOnly: true },
  { title: "Video Creator", href: "/video-creator", icon: Film,   locked: true },
  { title: "Gallery",       href: "/videos",      icon: Video },
  { title: "Settings",      href: "/settings",    icon: Settings },
];

export function Sidebar({ role = "USER", collapsed = false, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const [plan, setPlan] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [supportOpen, setSupportOpen] = useState(false);

  useEffect(() => {
    fetch("/api/user/stats").then(r => r.json()).then(d => {
      if (d.plan) setPlan(d.plan);
    }).catch(() => { setPlan("FREE"); });
    fetch("/api/user/me").then(r => r.json()).then(d => {
      if (d.name) setUserName(d.name);
    }).catch(() => {});
  }, []);

  const isPro = plan === "PRO";
  const planLoaded = plan !== null;

  const visibleUserItems = role === "ADMIN"
    ? userNavItems
    : userNavItems.filter(item => !item.adminOnly);
  const navItems = role === "ADMIN"
    ? [...adminNavItems, ...visibleUserItems]
    : visibleUserItems;

  const initials = userName
    ? userName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : "U";

  return (
    <div
      className={cn("relative flex h-full flex-col transition-all duration-200", collapsed ? "w-14" : "w-56")}
      style={{ background: "var(--ui-sidebar-bg)", borderRight: "1px solid var(--ui-sidebar-border)" }}
    >
      {/* Toggle */}
      {onToggle && (
        <button onClick={onToggle}
          className="absolute -right-3 top-5 z-10 flex h-6 w-6 items-center justify-center rounded-full transition-colors"
          style={{
            background: "var(--ui-card-bg)",
            border: "1px solid var(--ui-btn-border)",
            color: "var(--ui-text-secondary)",
          }}>
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      )}

      {/* User section */}
      <div
        className={cn("flex items-center gap-3 border-b", collapsed ? "px-2.5 py-4 justify-center" : "px-4 py-4")}
        style={{ borderColor: "var(--ui-divider)" }}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 40%))" }}
        >
          {initials}
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate leading-tight" style={{ color: "var(--ui-text-primary)" }}>
              {userName || "User"}
            </p>
            {planLoaded && (
              <span className="text-[10px] font-semibold"
                style={{ color: isPro ? "hsl(190 100% 50%)" : "var(--ui-text-muted)" }}>
                {isPro ? "Pro Plan" : "Free Plan"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 overflow-y-auto py-3 space-y-0.5", collapsed ? "px-1.5" : "px-2")}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isLocked = planLoaded && !isPro && (item as { locked?: boolean }).locked;
          const isActive = !isLocked && (pathname === item.href || pathname.startsWith(item.href + "/"));

          if (isLocked) {
            return (
              <div key={item.href} title={collapsed ? `${item.title} (Pro)` : undefined}
                className={cn(
                  "relative flex items-center rounded-lg cursor-not-allowed opacity-40",
                  collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2 text-sm",
                )}
                style={{ color: "var(--ui-text-muted)" }}
              >
                <Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")} />
                {!collapsed && (
                  <>
                    <span className="flex-1">{item.title}</span>
                    <Lock className="h-3 w-3" />
                  </>
                )}
              </div>
            );
          }

          return (
            <Link key={item.href} href={item.href} title={collapsed ? item.title : undefined}
              className={cn(
                "relative flex items-center rounded-lg transition-all border-0 outline-none",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2 text-sm",
                isActive ? "font-medium" : "hover:bg-black/5 dark:hover:bg-white/5"
              )}
              style={{
                background: isActive ? "hsl(190 100% 50% / 0.08)" : undefined,
                color: isActive ? "var(--ui-text-primary)" : "var(--ui-text-secondary)",
              }}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full"
                  style={{ background: "hsl(190 100% 50%)" }} />
              )}
              <Icon
                className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")}
                style={{ color: isActive ? "hsl(190 100% 50%)" : "var(--ui-text-muted)" }}
              />
              {!collapsed && item.title}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      {!collapsed && (
        <div className="p-3 space-y-2 border-t" style={{ borderColor: "var(--ui-divider)" }}>
          {planLoaded && !isPro && (
            <Link href="/settings?tab=billing"
              className="flex w-full items-center justify-center rounded-xl py-2 text-xs font-semibold text-white transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
              Upgrade to Pro
            </Link>
          )}
          <button
            onClick={() => setSupportOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: "var(--ui-text-muted)" }}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            Support
          </button>
        </div>
      )}

      {collapsed && (
        <div className="p-2 border-t flex justify-center" style={{ borderColor: "var(--ui-divider)" }}>
          <button
            onClick={() => setSupportOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: "var(--ui-text-muted)" }}
            title="Support"
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  );
}
