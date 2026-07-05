"use client";

import { X } from "lucide-react";
import { Sidebar } from "./sidebar";

interface MobileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MobileSidebar({ open, onOpenChange }: MobileSidebarProps) {
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        onClick={() => onOpenChange(false)}
      />
      {/* Drawer */}
      <div
        className="fixed left-0 top-0 bottom-0 z-50 flex flex-col lg:hidden"
        style={{ width: 224 }}
      >
        {/* Close button inside drawer */}
        <button
          onClick={() => onOpenChange(false)}
          aria-label="ปิดเมนู"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:brightness-125"
          style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-secondary)" }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <Sidebar touchTargets />
      </div>
    </>
  );
}
