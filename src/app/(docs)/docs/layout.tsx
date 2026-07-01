"use client";

import { useState } from "react";
import { DocsProvider } from "./_components/docs-context";
import { DocsTopbar } from "./_components/docs-topbar";
import { DocsSidebar } from "./_components/docs-sidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <DocsProvider>
      <div className="flex h-screen flex-col" style={{ background: "var(--ui-card-bg-3)" }}>
        <DocsTopbar onMenuClick={() => setDrawerOpen((v) => !v)} />
        <div className="flex flex-1 overflow-hidden">
          <DocsSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-5 py-8 md:px-8">{children}</div>
          </main>
        </div>
      </div>
    </DocsProvider>
  );
}
