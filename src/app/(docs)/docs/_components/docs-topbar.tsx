"use client";

import Link from "next/link";
import { Sparkles, ArrowLeft, Menu } from "lucide-react";
import { DocsSearch } from "./docs-search";

export function DocsTopbar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-6"
      style={{ background: "var(--ui-nav-bg)", borderBottom: "1px solid var(--ui-nav-border)" }}>
      <button onClick={onMenuClick} aria-label="เมนู"
        className="flex h-8 w-8 items-center justify-center rounded-lg md:hidden"
        style={{ color: "var(--ui-text-secondary)" }}>
        <Menu className="h-4 w-4" />
      </button>

      <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5" aria-label="Hero AI Creator Studio">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{ background: "linear-gradient(135deg, hsl(262 83% 60%), hsl(252 83% 55%))" }}>
          <Sparkles className="h-4 w-4 text-white" strokeWidth={2.5} />
        </span>
        <span className="hidden flex-col leading-none sm:flex">
          <span className="text-[14px] font-bold tracking-tight text-white">วิธีใช้งาน</span>
          <span className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>Hero AI Creator Studio</span>
        </span>
      </Link>

      <div className="flex flex-1 justify-center px-2">
        <DocsSearch />
      </div>

      <Link href="/dashboard"
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium"
        style={{ color: "var(--ui-text-secondary)", background: "hsl(0 0% 100% / 0.04)", border: "1px solid var(--ui-divider)" }}>
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">กลับแอป</span>
      </Link>
    </header>
  );
}
