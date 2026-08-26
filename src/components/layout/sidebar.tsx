"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { fetchMe } from "@/lib/use-me";
import { trackEvent } from "@/lib/client-telemetry";
import { deriveFirstClipState, shouldShowFirstClipHero } from "@/lib/first-clip-dashboard";
import {
  Settings, Users, Shield, Lock,
  LayoutDashboard, Video, HelpCircle, ChevronLeft, ChevronRight, ChevronDown, LogOut, Ticket, Clapperboard, CreditCard, Activity, Megaphone, BookOpen, Handshake, WandSparkles, NotebookPen, SwatchBook,
} from "lucide-react";
import { SupportModal } from "@/components/ui/support-modal";
import { FadeSwap } from "@/components/ui/fade-swap";
import { UserAvatar } from "@/components/layout/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SidebarProps {
  role?: "ADMIN" | "USER";
  collapsed?: boolean;
  onToggle?: () => void;
  initialPlan?: string;
  initialName?: string;
  sessionLoaded?: boolean;
  /** Mobile drawer rendering: bump nav row height to a ≥44px touch target. */
  touchTargets?: boolean;
}

type SidebarNavItem = {
  title: string;
  href: string;
  icon: React.ElementType;
  locked?: boolean;
  /** Active only on an EXACT pathname match. Used for "/admin" so it doesn't
   *  also light up on every /admin/* sub-route (e.g. /admin/users). */
  exact?: boolean;
  badge?: number;
  /** Small text pill (e.g. "ใหม่") instead of the numeric unread-count badge. */
  badgeText?: string;
};

// USER (non-admin) — one lean list, no section labels.
// Legacy items (Styles /style, Content /content, Video Creator /video-creator)
// are intentionally removed from nav; their routes/pages still work if visited directly.
const userNavItems: SidebarNavItem[] = [
  { title: "Dashboard",    href: "/dashboard",     icon: LayoutDashboard },
  // Writing comes before editing in the user flow — kept directly above Video Editor.
  { title: "เขียนสคริปต์ AI", href: "/hero-script", icon: NotebookPen, badgeText: "ใหม่" },
  { title: "แบรนด์ของฉัน", href: "/brands", icon: SwatchBook, badgeText: "ใหม่" },
  { title: "Video Editor", href: "/video-editor",  icon: Clapperboard },
  { title: "AI Studio",    href: "/ai-studio",     icon: WandSparkles },
  { title: "Gallery",      href: "/videos",        icon: Video },
  { title: "วิธีใช้งาน",    href: "/docs",          icon: BookOpen },
  { title: "อัปเดต",       href: "/updates",       icon: Megaphone },
  { title: "Pricing",      href: "/pricing",       icon: CreditCard },
  { title: "Settings",     href: "/settings",      icon: Settings },
];

// ADMIN — two labeled groups. Admins reach Docs via the topbar link and Pricing
// directly, so those are omitted here (matches the approved mockup).
const adminStudioItems: SidebarNavItem[] = [
  { title: "Dashboard",    href: "/dashboard",     icon: LayoutDashboard },
  // Writing comes before editing in the user flow — kept directly above Video Editor
  // (same placement as userNavItems; admins are allowlist-gated too, see internalItemsOnly).
  { title: "เขียนสคริปต์ AI", href: "/hero-script", icon: NotebookPen, badgeText: "ใหม่" },
  { title: "แบรนด์ของฉัน", href: "/brands", icon: SwatchBook, badgeText: "ใหม่" },
  { title: "Video Editor", href: "/video-editor",  icon: Clapperboard },
  { title: "AI Studio",    href: "/ai-studio",     icon: WandSparkles },
  { title: "Gallery",      href: "/videos",        icon: Video },
  { title: "Settings",     href: "/settings",      icon: Settings },
];
const adminAdminItems: SidebarNavItem[] = [
  { title: "Admin",        href: "/admin",          icon: Shield, exact: true },
  { title: "Insights",     href: "/admin/insights", icon: Activity },
  { title: "จัดการผู้ใช้",  href: "/admin/users",    icon: Users },
  { title: "คูปอง",         href: "/admin/coupons",  icon: Ticket },
  { title: "Updates",      href: "/admin/updates",  icon: Megaphone },
];

/** Small uppercase group label (admin sections). Collapses to a subtle divider. */
function SectionLabel({
  collapsed,
  withDivider,
  children,
}: {
  collapsed: boolean;
  withDivider?: boolean;
  children: React.ReactNode;
}) {
  if (collapsed) {
    // No room for text when collapsed — separate groups with a faint divider.
    if (!withDivider) return null;
    return <div className="mx-auto my-2 h-px w-6" style={{ background: "var(--ui-divider)" }} />;
  }
  return (
    <div
      className={cn(
        "px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider",
        withDivider ? "pt-4" : "pt-1",
      )}
      style={{ color: "var(--ui-text-muted)" }}
    >
      {children}
    </div>
  );
}

export function Sidebar({ role: roleProp = "USER", collapsed = false, onToggle, touchTargets = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useClerk();
  const prefetchedRef = useRef<Set<string>>(new Set());

  function prefetchOnce(href: string) {
    if (prefetchedRef.current.has(href)) return;
    prefetchedRef.current.add(href);
    router.prefetch(href);
  }

  const [plan, setPlan] = useState<string>("FREE");
  const [userName, setUserName] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);
  const [role, setRole] = useState<"ADMIN" | "USER">(roleProp);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [usageCount, setUsageCount] = useState<number>(0);
  const [usageLimit, setUsageLimit] = useState<number>(2);
  // Minute-quota mode (MINUTE_QUOTA flag): show นาที instead of คลิป
  const [minuteQuota, setMinuteQuota] = useState(false);
  const [minutesUsed, setMinutesUsed] = useState<number>(0);
  const [minutesLimit, setMinutesLimit] = useState<number>(0);
  const [updatesUnread, setUpdatesUnread] = useState(0);
  const [currentVersion, setCurrentVersion] = useState("v0.1.0");
  const [internalAiTester, setInternalAiTester] = useState(false);
  const [heroScriptAllowed, setHeroScriptAllowed] = useState(false);
  const [heroScriptPreview, setHeroScriptPreview] = useState(false);
  const [brandVisualAllowed, setBrandVisualAllowed] = useState(false);
  const [brandVisualCohort, setBrandVisualCohort] = useState<string>("off");
  const [firstClipPath, setFirstClipPath] = useState(false);
  const [firstClipReason, setFirstClipReason] = useState<string | null>(null);
  const [firstClipActiveRender, setFirstClipActiveRender] = useState(false);
  const [firstClipRenderedClip, setFirstClipRenderedClip] = useState(false);

  useEffect(() => {
    fetchMe()
      .then(data => {
        if (!data) { setSessionLoaded(true); return; }
        const effectivePlan = data.effectivePlan ?? data.plan;
        if (effectivePlan) setPlan(effectivePlan);
        if (data.name) setUserName(data.name);
        if (data.email) setUserEmail(data.email);
        setAvatar(data.avatar ?? null);
        setTrialEndsAt(typeof data.trialEndsAt === "string" ? data.trialEndsAt : null);
        if (data.role) setRole(data.role as "ADMIN" | "USER");
        if (typeof data.usageCount === "number") setUsageCount(data.usageCount);
        if (typeof data.usageLimit === "number") setUsageLimit(data.usageLimit);
        if (data.minuteQuota === true) setMinuteQuota(true);
        if (typeof data.minutesUsed === "number") setMinutesUsed(data.minutesUsed);
        if (typeof data.minutesLimit === "number") setMinutesLimit(data.minutesLimit);
        setInternalAiTester(data.internalAiTester === true);
        setHeroScriptAllowed(data.heroScriptAllowed === true);
        setHeroScriptPreview(data.heroScriptPreview === true);
        setBrandVisualAllowed(data.brandVisualAllowed === true);
        setBrandVisualCohort(data.brandVisualCohort ?? "off");
        setFirstClipPath(data.firstClipPath === true);
        setFirstClipReason(typeof data.firstClipPathReason === "string" ? data.firstClipPathReason : null);
        setFirstClipActiveRender(data.firstClipProgress?.activeRender === true);
        setFirstClipRenderedClip(data.firstClipProgress?.renderedClip === true);
        setSessionLoaded(true);
      })
      .catch(() => setSessionLoaded(true));
  }, []);

  // Unified usage figures: minutes when minute-quota is on, else clips
  const usedNow = minuteQuota ? minutesUsed : usageCount;
  const limitNow = minuteQuota ? minutesLimit : usageLimit;
  const usageUnitLabel = minuteQuota ? "นาที" : "คลิป";

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
  const isActiveTrial = Boolean(trialEndsAt && new Date(trialEndsAt).getTime() > Date.now());
  const planLabel = isActiveTrial ? "ทดลอง PRO" : isBusiness ? "Business Plan" : isPro ? "Pro Plan" : "Free Plan";
  const planColor = isBusiness ? "hsl(252 83% 65%)" : isPro ? "#8B5CF6" : "var(--ui-text-muted)";

  // State-aware bottom CTA (#305): before the first export the only ask is
  // "make the clip"; a trial that already exported is the one worth converting;
  // a real paying PRO keeps today's Business upsell.
  const firstClipState = deriveFirstClipState({
    hasExport: firstClipReason === "has_completed_video",
    renderedClip: firstClipRenderedClip,
    activeRender: firstClipActiveRender,
  });
  const onFirstClipJourney = role !== "ADMIN"
    && shouldShowFirstClipHero({ onPath: firstClipPath, state: firstClipState });

  // Attach the unread-updates badge to the user "/updates" item (admins use /admin/updates,
  // which has no unread badge — the helper is a no-op there).
  const withUpdatesBadge = (items: SidebarNavItem[]): SidebarNavItem[] =>
    items.map((item) => item.href === "/updates"
      ? { ...item, title: updatesUnread > 0 ? "อัปเดตใหม่" : "อัปเดต", badge: updatesUnread }
      : item);

  const internalItemsOnly = (items: SidebarNavItem[]) =>
    items
      .filter((item) => item.href !== "/ai-studio" || internalAiTester)
      // First-Clip Path chooses the default onboarding rail; it must not revoke
      // the paid Hero Script entrypoint or the Trial locked preview.
      .filter((item) => item.href !== "/hero-script" || heroScriptAllowed || heroScriptPreview)
      .filter((item) => item.href !== "/brands" || !firstClipPath)
      .map((item) => item.href === "/hero-script" && !heroScriptAllowed
        ? { ...item, badgeText: "PRO" }
        : item.href === "/brands" && !brandVisualAllowed
          ? { ...item, badgeText: brandVisualCohort === "rollout-wait" ? "รอเปิด" : "PRO" }
          : item);
  const userItems = internalItemsOnly(withUpdatesBadge(userNavItems));
  const adminItems = internalItemsOnly(adminStudioItems);

  function renderNavItem(item: SidebarNavItem) {
    const Icon = item.icon;
    // While session loads, don't show lock icon — assume unlocked to avoid flash
    const isLocked = sessionLoaded && !isPaid && (item as { locked?: boolean }).locked;
    const isActive = !isLocked && (item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(item.href + "/"));

    if (isLocked) {
      return (
        <div key={item.href} title={collapsed ? `${item.title} (Pro)` : undefined}
          className={cn(
            "relative flex items-center rounded-lg cursor-not-allowed opacity-40",
            collapsed ? "justify-center px-2 py-2.5" : cn("gap-3 px-3 py-2 text-sm", touchTargets && "min-h-[44px]"),
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
        onClick={() => {
          if (item.href === "/hero-script") {
            trackEvent("hero_script_menu_clicked", {
              properties: { access: heroScriptAllowed ? "full" : "preview" },
            });
          }
          if (item.href === "/brands") {
            trackEvent("brand_library_menu_clicked", { properties: { access: brandVisualAllowed ? "full" : brandVisualCohort === "rollout-wait" ? "rollout_wait" : "preview" } });
          }
        }}
        className={cn(
          "relative flex items-center rounded-lg border-0 outline-none transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]/60",
          collapsed ? "justify-center px-2 py-2.5" : cn("gap-3 px-3 py-2 text-sm", touchTargets && "min-h-[44px]"),
          isActive ? "font-medium" : "hover:bg-black/5 dark:hover:bg-white/5"
        )}
        style={{
          background: isActive ? "rgba(139,92,246,.10)" : undefined,
          color: isActive ? "var(--ui-text-primary)" : "var(--ui-text-secondary)",
        }}
      >
        {isActive && (
          <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full"
            style={{ background: "#8B5CF6" }} />
        )}
        <Icon
          className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")}
          style={{ color: isActive ? "#8B5CF6" : "var(--ui-text-muted)" }}
        />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {(item.badge ?? 0) > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-500 px-1.5 text-[10px] font-bold leading-none text-white">
                {(item.badge ?? 0) > 9 ? "9+" : item.badge}
              </span>
            )}
            {item.badgeText && (
              <span className="flex h-5 items-center justify-center rounded-full bg-violet-500 px-1.5 text-[10px] font-bold leading-none text-white">
                {item.badgeText}
              </span>
            )}
          </>
        )}
        {collapsed && ((item.badge ?? 0) > 0 || item.badgeText) && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-violet-400" />
        )}
      </Link>
    );
  }

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

      {/* User section — clickable account hub (Settings · Billing · Logout) */}
      <div className="border-b" style={{ borderColor: "var(--ui-divider)" }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="บัญชีผู้ใช้"
              className={cn(
                "flex w-full items-center gap-3 outline-none transition-colors hover:bg-black/5 dark:hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8B5CF6]/60",
                collapsed ? "px-2.5 py-4 justify-center" : "px-4 py-4",
              )}
            >
              <FadeSwap
                ready={sessionLoaded}
                className="h-9 w-9 shrink-0"
                skeleton={<div className="h-9 w-9 rounded-full skeleton-wave" />}
              >
                <UserAvatar name={userName} avatar={avatar} size={36} />
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
                  <div className="min-w-0 text-left">
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
              {!collapsed && (
                <ChevronDown className="h-4 w-4 shrink-0" style={{ color: "var(--ui-text-muted)" }} />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-56 border"
            style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}
            align="start"
            side="bottom"
          >
            <DropdownMenuLabel>
              <div className="flex flex-col space-y-0.5">
                <p className="text-sm font-medium leading-none" style={{ color: "var(--ui-text-primary)" }}>
                  {userName || "User"}
                </p>
                {userEmail && (
                  <p className="text-xs leading-none" style={{ color: "var(--ui-text-muted)" }}>
                    {userEmail}
                  </p>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator style={{ background: "var(--ui-divider)" }} />
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
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 overflow-y-auto py-3 space-y-0.5", collapsed ? "px-1.5" : "px-2")}>
        {role === "ADMIN" ? (
          <>
            <SectionLabel collapsed={collapsed}>Studio</SectionLabel>
            {adminItems.map(renderNavItem)}
            <SectionLabel collapsed={collapsed} withDivider>Admin</SectionLabel>
            {adminAdminItems.map(renderNavItem)}
          </>
        ) : (
          userItems.map(renderNavItem)
        )}
      </nav>

      {/* Bottom */}
      {!collapsed && (
        <div className="p-3 space-y-2 border-t" style={{ borderColor: "var(--ui-divider)" }}>
          <FadeSwap
            ready={sessionLoaded}
            skeleton={<div className="h-8 w-full rounded-xl skeleton-wave" />}
          >
            {onFirstClipJourney ? (
              <Link href="/video-editor" prefetch={true}
                onClick={() => trackEvent("first_clip_cta_clicked", {
                  step: firstClipState,
                  properties: { step: firstClipState, surface: "sidebar" },
                })}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-bold text-white transition-all hover:brightness-110"
                style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", boxShadow: "0 2px 12px rgba(109,40,217,0.5)" }}>
                <span>⚡</span>
                <span>สร้างคลิปแรก</span>
              </Link>
            ) : isActiveTrial ? (
              <Link href="/pricing?source=sidebar" prefetch={true}
                className="flex w-full items-center justify-center rounded-xl py-2 text-xs font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
                สมัคร PRO
              </Link>
            ) : !isPaid ? (
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
                      {usedNow}/{limitNow} {usageUnitLabel}
                    </span>
                  </div>
                  {/* progress bar */}
                  <div className="h-0.75 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, limitNow > 0 ? (usedNow / limitNow) * 100 : 0)}%`,
                        background: usedNow >= limitNow
                          ? "linear-gradient(90deg, hsl(0 80% 55%), hsl(20 90% 55%))"
                          : "linear-gradient(90deg, #8B66F8, #6C4CF4)",
                        boxShadow: usedNow >= limitNow ? "0 0 8px rgba(239,68,68,0.6)" : "0 0 8px rgba(139,92,246,0.8)",
                      }} />
                  </div>
                  {/* cta */}
                  <div className="flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-[11px] font-bold text-white transition-all group-hover:brightness-110"
                    style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", boxShadow: "0 2px 12px rgba(109,40,217,0.5)" }}>
                    <span>⚡</span>
                    <span>Upgrade to Pro</span>
                  </div>
                </div>
              </Link>
            ) : isPro ? (
              <Link href="/settings?tab=billing"
                className="flex w-full items-center justify-center rounded-xl py-2 text-xs font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
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
