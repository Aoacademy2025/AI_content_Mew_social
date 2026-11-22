"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { Sidebar } from "./sidebar";

interface MobileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MobileSidebar({ open, onOpenChange }: MobileSidebarProps) {
  const pathname = usePathname();
  const prevPathnameRef = useRef(pathname);

  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      if (open) onOpenChange(false);
    }
  }, [pathname, open, onOpenChange]);

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
        style={{ width: 256 }}
      >
        {/* Close button inside drawer — 44x44px touch target */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="ปิดเมนู"
          className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]/60"
          style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)", color: "var(--ui-text-secondary)" }}
        >
          <X className="h-4 w-4" />
        </button>
        <Sidebar touchTargets onNavigate={() => onOpenChange(false)} />
      </div>
    </>
  );
}
