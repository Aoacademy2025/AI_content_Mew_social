"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { MobileSidebar } from "./mobile-sidebar";
import { BottomTabs } from "./bottom-tabs";
import { TopNav } from "./top-nav";
import { TrialBanner } from "./trial-banner";
import { ProductUpdateBanner } from "./product-update-banner";

interface DashboardLayoutProps {
  children: React.ReactNode;
  /** @deprecated padding is now controlled per-page via the .ve-no-padding marker */
  noPadding?: boolean;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function DashboardLayout({ children, noPadding }: DashboardLayoutProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = browserStorage()?.getItem("sidebar-collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed(p => {
      browserStorage()?.setItem("sidebar-collapsed", String(!p));
      return !p;
    });
  }

  // Full-screen focused workspace: the editor owns its whole viewport with its own
  // single topbar (EditorV2Shell / legacy editor both root at h-screen or flex-1).
  // Suppress the shared dashboard chrome — TopNav, Sidebar/MobileSidebar, banners,
  // <main> padding — ONLY on this route. Every other path renders unchanged below.
  if (pathname === "/video-editor") {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden bg-background">
        {/* Overlay keeps the editor's h-screen geometry unchanged while ensuring
            users who work only in the editor still receive launch announcements. */}
        <div className="absolute inset-x-0 top-0 z-[300]">
          <ProductUpdateBanner />
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />
      <TrialBanner />

      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden lg:block shrink-0">
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        </aside>

        <MobileSidebar
          open={mobileMenuOpen}
          onOpenChange={setMobileMenuOpen}
        />

        <div className="flex flex-1 flex-col overflow-hidden min-w-0">
          <ProductUpdateBanner />
          {/* Mobile (<lg) reserves bottom room for <BottomTabs>; the bar self-hides at lg.
              Directional padding (px/pt + pb-[calc]) is used so the pb clearance survives the
              `has-[.ve-no-padding]:p-0` reset on pages whose inner div owns the scroll. */}
          <main className={
            noPadding
              ? "flex-1 overflow-hidden flex flex-col"
              : "flex-1 overflow-y-auto px-4 pt-4 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-6 md:pt-6 lg:pb-6 has-[.ve-no-padding]:p-0 has-[.ve-no-padding]:pb-[calc(64px+env(safe-area-inset-bottom))] has-[.ve-no-padding]:lg:pb-0 has-[.ve-no-padding]:overflow-hidden has-[.ve-no-padding]:flex has-[.ve-no-padding]:flex-col"
          }>
            {children}
          </main>
        </div>
      </div>

      {!mobileMenuOpen && <BottomTabs />}
    </div>
  );
}
