"use client";

/**
 * Presentational atoms for the mobile (CapCut-style) video editor layout.
 * Pure/stateless — all state lives in the parent `/video-editor/page.tsx`,
 * which renders these only on small viewports. Single accent = brand violet.
 */

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function MChip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-9 shrink-0 rounded-full px-4 text-[12.5px] font-semibold transition-colors",
        active
          ? "bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-[0_4px_12px_-2px_rgba(139,92,246,0.5)]"
          : "border border-[#2a2a36] bg-[#1a1a22] text-slate-400 active:bg-[#22222c]"
      )}
    >
      {children}
    </button>
  );
}

export function MSwatch({ color, active, onClick }: { color: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      aria-label={`สี ${color}`}
      onClick={onClick}
      className={cn(
        "h-9 w-9 shrink-0 rounded-full border border-white/15 transition-shadow",
        active && "ring-2 ring-violet-500 ring-offset-2 ring-offset-[#16161c]"
      )}
      style={{ background: color }}
    />
  );
}

export function MField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-500">{label}</div>
      {children}
    </div>
  );
}

export function MTool({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-14.5 w-full flex-col items-center justify-center gap-1 active:bg-[#1e1e28]",
        active && "bg-[#1e1e28]"
      )}
    >
      <Icon className={cn("h-5 w-5", active ? "text-violet-300" : "text-slate-300")} />
      <span className={cn("max-w-full truncate px-0.5 text-[9.5px] font-semibold", active ? "text-violet-300" : "text-slate-500")}>{label}</span>
    </button>
  );
}

export function MToggleRow({ label, sub, on, onClick }: { label: string; sub?: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between rounded-xl border border-[#2a2a36] bg-[#1a1a22] p-3 text-left">
      <div>
        <div className="text-[13px] font-semibold text-slate-100">{label}</div>
        {sub && <div className="mt-0.5 text-[10.5px] text-slate-500">{sub}</div>}
      </div>
      <span className={cn("relative h-6 w-[42px] shrink-0 rounded-full transition-colors", on ? "bg-violet-500" : "bg-[#3a3a44]")}>
        <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", on ? "left-[20px]" : "left-0.5")} />
      </span>
    </button>
  );
}

export function MBottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div
        onClick={onClose}
        className={cn("absolute inset-0 z-40 bg-black/50 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-50 flex max-h-[78%] flex-col rounded-t-[18px] border-t border-[#2f2f3b] bg-[#16161c] shadow-[0_-16px_40px_-16px_rgba(0,0,0,0.6)] transition-transform duration-[260ms]",
          open ? "translate-y-0" : "translate-y-full"
        )}
        style={{ transitionTimingFunction: "cubic-bezier(.22,1,.36,1)" }}
      >
        <div className="mx-auto mb-1 mt-2.5 h-1 w-9 rounded-full bg-[#2f2f3b]" />
        <div className="flex items-center justify-between border-b border-[#22222c] px-4 pb-3 pt-1.5">
          <h3 className="m-0 text-[14.5px] font-bold text-slate-100">{title}</h3>
          <button onClick={onClose} className="h-[30px] rounded-[9px] border border-violet-500/40 bg-violet-500/15 px-3.5 text-[12px] font-bold text-violet-300">เสร็จ</button>
        </div>
        <div className="overflow-y-auto px-4 pb-7 pt-4">{children}</div>
      </div>
    </>
  );
}
