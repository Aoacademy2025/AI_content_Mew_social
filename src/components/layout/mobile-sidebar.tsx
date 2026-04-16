"use client";

import { X } from "lucide-react";
import { Sidebar } from "./sidebar";

interface MobileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: "ADMIN" | "USER";
}

export function MobileSidebar({ open, onOpenChange, role }: MobileSidebarProps) {
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
        onClick={() => onOpenChange(false)}
      />
      {/* Drawer */}
      <div
        className="fixed left-0 top-0 bottom-0 z-50 flex flex-col md:hidden"
        style={{ width: 224 }}
      >
        {/* Close button inside drawer */}
        <button
          onClick={() => onOpenChange(false)}
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full text-white/50 hover:text-white transition-colors"
          style={{ background: "hsl(221 39% 14%)", border: "1px solid hsl(220 30% 20%)" }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <Sidebar role={role} />
      </div>
    </>
  );
}
