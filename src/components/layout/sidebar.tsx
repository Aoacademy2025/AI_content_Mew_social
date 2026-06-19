"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Palette, FileText, Settings, Users, Film, Shield, Lock,
  LayoutDashboard, Video, HelpCircle, ChevronLeft, ChevronRight, Ticket, Clapperboard, CreditCard, Activity, Megaphone, Languages,
} from "lucide-react";
import { SupportModal } from "@/components/ui/support-modal";
import { FadeSwap } from "@/components/ui/fade-swap";

interface SidebarProps {
  role?: "ADMIN" | "USER";
  collapsed?: boolean;
  onToggle?: () => void;
  initialPlan?: string;
  initialName?: string;
  sessionLoaded?: boolean;
}

type SidebarNavItem = {
  title: string;
  href: string;
  icon: React.ElementType;
  locked?: boolean;
  adminOnly?: boolean;
  proOnly?: boolean;
  badge?: number;
};

const adminNavItems: SidebarNavItem[] = [
  { title: "Admin",       href: "/admin",         icon: Shield,  proOnly: false },
  { title: "Insights",    href: "/admin/insights", icon: Activity, proOnly: false },
  { title: "Updates",     href: "/admin/updates", icon: Megaphone, proOnly: false },
  { title: "จัดการผู้ใช้", href: "/admin/users",  icon: Users,   proOnly: false },
  { title: "คูปอง",        href: "/admin/coupons", icon: Ticket,  proOnly: false },
  { title: "คำตัดซับ",     href: "/admin/loanwords", icon: Languages, proOnly: false },
];

const userNavItems: SidebarNavItem[] = [
  { title: "Dashboard",     href: "/dashboard",  icon: LayoutDashboard },
  { title: "Styles",        href: "/style",       icon: Palette, adminOnly: true },
  { title: "Content",       href: "/content",     icon: FileText, adminOnly: true },
  { title: "Video Creator", href: "/video-creator", icon: Film,   adminOnly: true },
  { title: "Video Editor",  href: "/video-editor",  icon: Clapperboard },
  { title: "Gallery",       href: "/videos",      icon: Video },
  { title: "อัปเดต",       href: "/updates",     icon: Megaphone },
  { title: "Pricing",       href: "/pricing",     icon: CreditCard },
  { title: "Settings",      href: "/settings",    icon: Settings },
];

export function Sidebar({ role: roleProp = "USER", collapsed = false, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const prefetchedRef = useRef<Set<string>>(new Set());

  function prefetchOnce(href: string) {
    if (prefetchedRef.current.has(href)) return;
    prefetchedRef.current.add(href);
    router.prefetch(href);
  }

  const [plan, setPlan] = useState<string>("FREE");
  const [userName, setUserName] = useState<string>("");
  const [role, setRole] = useState<"ADMIN" | "USER">(roleProp);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [usageCount, setUsageCount] = useState<number>(0);
  const [usageLimit, setUsageLimit] = useState<number>(2);
  const [updatesUnread, setUpdatesUnread] = useState(0);
  const [currentVersion, setCurrentVersion] = useState("v0.1.0");

  useEffect(() => {
    fetch("/api/user/me")
      .then(r => r.json())
      .then(data => {
        if (data.plan) setPlan(data.plan);
        if (data.name) setUserName(data.name);
        if (data.role) setRole(data.role);
        if (typeof data.usageCount === "number") setUsageCount(data.usageCount);
        if (typeof data.usageLimit === "number") setUsageLimit(data.usageLimit);
        setSessionLoaded(true);
      })
      .catch(() => setSessionLoaded(true));
  }, []);

  useEffect(() => {
    if (!sessionLoaded) return;
    let cancelled = false;

    function loadUpdatesSummary() {
      fetch("/api/updates?summary=1", { cache: "no-store" })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          if (typeof data.currentVersion === "string") setCurrentVersion(data.currentVersion);
          if (typeof data.unreadCount === "number") setUpdatesUnread(data.unreadCount);
        })
        .catch(() => {});
    }

    loadUpdatesSummary();
    window.addEventListener("product-updates-read", loadUpdatesSummary);
    return () => {
      cancelled = true;
      window.removeEventListener("product-updates-read", loadUpdatesSummary);
    };
  }, [sessionLoaded, pathname]);

  const isBusiness = plan === "BUSINESS";
  const isPro = plan === "PRO";
  const isPaid = isPro || isBusiness;
  const planLabel = isBusiness ? "Business Plan" : isPro ? "Pro Plan" : "Free Plan";
  const planColor = isBusiness ? "hsl(252 83% 65%)" : isPro ? "hsl(190 100% 50%)" : "var(--ui-text-muted)";

  const visibleUserItems = role === "ADMIN"
    ? userNavItems
    : userNavItems.filter(item => !item.adminOnly);
  const navItems: SidebarNavItem[] = role === "ADMIN"
    ? [...adminNavItems, ...visibleUserItems]
    : visibleUserItems;
  const navItemsWithBadges: SidebarNavItem[] = navItems.map((item) => item.href === "/updates"
    ? { ...item, title: updatesUnread > 0 ? "อัปเดตใหม่" : "อัปเดต", badge: updatesUnread }
    : item);

  const initials = userName
    ? userName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : "U";

  return (
    <div
      className={cn("relative flex h-full flex-col transition-all duration-200", collapsed ? "w-14" : "w-64")}
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
        <FadeSwap
          ready={sessionLoaded}
          className="h-9 w-9 shrink-0"
          skeleton={<div className="h-9 w-9 rounded-full skeleton-wave" />}
        >
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white"
            style={{ background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 40%))" }}
          >
            {initials}
          </div>
        </FadeSwap>
        {!collapsed && (
          <FadeSwap
            ready={sessionLoaded}
            className="min-w-0 flex-1"
            skeleton={
              <div className="space-y-1.5">
                <div className="h-3.5 w-20 rounded skeleton-wave" />
                <div className="h-2.5 w-12 rounded skeleton-wave" />
              </div>
            }
          >
            <div>
              <p className="text-sm font-semibold truncate leading-tight" style={{ color: "var(--ui-text-primary)" }}>
                {userName || "User"}
              </p>
              <span className="text-[10px] font-semibold"
                style={{ color: planColor }}>
                {planLabel}
              </span>
            </div>
          </FadeSwap>
        )}
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 overflow-y-auto py-3 space-y-0.5", collapsed ? "px-1.5" : "px-2")}>
        {navItemsWithBadges.map((item) => {
          const Icon = item.icon;
          // While session loads, don't show lock icon — assume unlocked to avoid flash
          const isLocked = sessionLoaded && !isPaid && (item as { locked?: boolean }).locked;
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
              prefetch={true}
              onMouseEnter={() => prefetchOnce(item.href)}
              className={cn(
                "relative flex items-center rounded-lg border-0 outline-none transition-colors duration-150",
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
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {(item.badge ?? 0) > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1.5 text-[10px] font-bold leading-none text-white">
                      {(item.badge ?? 0) > 9 ? "9+" : item.badge}
                    </span>
                  )}
                </>
              )}
              {collapsed && (item.badge ?? 0) > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-sky-400" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      {!collapsed && (
        <div className="p-3 space-y-2 border-t" style={{ borderColor: "var(--ui-divider)" }}>
          <FadeSwap
            ready={sessionLoaded}
            skeleton={<div className="h-8 w-full rounded-xl skeleton-wave" />}
          >
            {!isPaid ? (
              <Link href="/settings?tab=billing" className="block w-full rounded-2xl overflow-hidden relative group"
                style={{ background: "linear-gradient(145deg, #0f0f18, #16102a)", border: "1px solid rgba(139,92,246,0.25)", boxShadow: "0 0 24px rgba(109,40,217,0.15)" }}>
                {/* glow top */}
                <div className="absolute inset-x-0 top-0 h-px" style={{ background: "linear-gradient(90deg, transparent, rgba(167,139,250,0.6), transparent)" }} />
                <div className="p-3 space-y-1.5">
                  {/* header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: "rgba(167,139,250,0.7)" }}>Free Plan</span>
                    </div>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: "rgba(139,92,246,0.15)", color: "rgba(167,139,250,0.9)", border: "1px solid rgba(139,92,246,0.3)" }}>
                      {usageCount}/{usageLimit} คลิป
                    </span>
                  </div>
                  {/* progress bar */}
                  <div className="h-0.75 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, (usageCount / usageLimit) * 100)}%`,
                        background: usageCount >= usageLimit
                          ? "linear-gradient(90deg, hsl(0 80% 55%), hsl(20 90% 55%))"
                          : "linear-gradient(90deg, hsl(252 83% 65%), hsl(190 100% 55%))",
                        boxShadow: usageCount >= usageLimit ? "0 0 8px rgba(239,68,68,0.6)" : "0 0 8px rgba(139,92,246,0.8)",
                      }} />
                  </div>
                  {/* cta */}
                  <div className="flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-[11px] font-bold text-white transition-all group-hover:brightness-110"
                    style={{ background: "linear-gradient(135deg, hsl(252 83% 58%), hsl(220 90% 62%))", boxShadow: "0 2px 12px rgba(109,40,217,0.5)" }}>
                    <span>⚡</span>
                    <span>Upgrade to Pro</span>
                  </div>
                </div>
              </Link>
            ) : isPro ? (
              <Link href="/settings?tab=billing"
                className="flex w-full items-center justify-center rounded-xl py-2 text-xs font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, hsl(252 83% 50%), hsl(280 80% 55%))" }}>
                Upgrade to Business
              </Link>
            ) : <div />}
          </FadeSwap>
          <button
            onClick={() => setSupportOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: "var(--ui-text-muted)" }}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            Support
          </button>
          <Link
            href="/updates"
            className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            style={{ color: "var(--ui-text-muted)" }}
          >
            <span>{updatesUnread > 0 ? "มีอัปเดตใหม่" : "HeroAI Studio"}</span>
            <span className="font-semibold" style={{ color: "var(--ui-text-secondary)" }}>{currentVersion}</span>
          </Link>
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
