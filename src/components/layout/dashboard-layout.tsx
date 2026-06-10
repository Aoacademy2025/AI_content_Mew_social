"use client";

import { useState, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { MobileSidebar } from "./mobile-sidebar";
import { TopNav } from "./top-nav";
import { TrialBanner } from "./trial-banner";
import { ProductUpdateBanner } from "./product-update-banner";

interface DashboardLayoutProps {
  children: React.ReactNode;
  /** @deprecated padding is now controlled per-page via the .ve-no-padding marker */
  noPadding?: boolean;
}

export function DashboardLayout({ children, noPadding }: DashboardLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed(p => {
      localStorage.setItem("sidebar-collapsed", String(!p));
      return !p;
    });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />
      <TrialBanner />

      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden md:block shrink-0">
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        </aside>

        <MobileSidebar
          open={mobileMenuOpen}
          onOpenChange={setMobileMenuOpen}
        />

        <div className="flex flex-1 flex-col overflow-hidden min-w-0">
          <ProductUpdateBanner />
          <main className={
            noPadding
              ? "flex-1 overflow-hidden flex flex-col"
              : "flex-1 overflow-y-auto p-4 md:p-6 has-[.ve-no-padding]:p-0 has-[.ve-no-padding]:overflow-hidden has-[.ve-no-padding]:flex has-[.ve-no-padding]:flex-col"
          }>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
