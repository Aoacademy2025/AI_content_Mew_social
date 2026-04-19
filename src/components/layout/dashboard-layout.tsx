"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Sidebar } from "./sidebar";
import { MobileSidebar } from "./mobile-sidebar";
import { TopNav } from "./top-nav";

interface DashboardLayoutProps {
  children: React.ReactNode;
  noPadding?: boolean;
}

export function DashboardLayout({ children, noPadding }: DashboardLayoutProps) {
  const { data: session, status } = useSession();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Persist collapsed state
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

  const user = session?.user;
  const role = (user as any)?.role as "ADMIN" | "USER" | undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Top Nav */}
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop Sidebar — collapsible */}
        <aside className="hidden md:block shrink-0">
          <Sidebar role={role} collapsed={collapsed} onToggle={toggleCollapsed} />
        </aside>

        {/* Mobile Sidebar — sheet overlay */}
        <MobileSidebar
          open={mobileMenuOpen}
          onOpenChange={setMobileMenuOpen}
          role={role}
        />

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden min-w-0">
          <main className={noPadding ? "flex-1 overflow-hidden flex flex-col" : "flex-1 overflow-y-auto p-4 md:p-6"}>
            {status === "loading" ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
              </div>
            ) : children}
          </main>
        </div>
      </div>
    </div>
  );
}
