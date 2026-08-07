"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Megaphone, X } from "lucide-react";
import { cn } from "@/lib/utils";

type UpdateImportance = "SILENT" | "BANNER" | "MODAL";

type AttentionUpdate = {
  id: string;
  version: string;
  title: string;
  summary: string;
  importance: UpdateImportance;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  publishedAt: string;
  unread: boolean;
};

type UpdatesSummary = {
  unreadCount: number;
  attentionUpdate: AttentionUpdate | null;
};

function shouldSurface(pathname: string, update: AttentionUpdate) {
  // This component only mounts inside the authenticated dashboard layout.
  // Untargeted announcements therefore reach every product surface, while a
  // targetPath can still narrow a contextual update to one feature.
  if (pathname === "/updates" || pathname.startsWith("/admin")) return false;
  if (pathname === "/dashboard") return true;
  if (!update.targetPath) return true;
  return pathname === update.targetPath || pathname.startsWith(`${update.targetPath}/`);
}

export function ProductUpdateBanner() {
  const pathname = usePathname();
  const [update, setUpdate] = useState<AttentionUpdate | null>(null);
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const [spotlightOpen, setSpotlightOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/updates?summary=1", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: UpdatesSummary) => {
        if (cancelled) return;
        const next = data.attentionUpdate ?? null;
        setUpdate(next);
        setSpotlightOpen(next?.importance === "MODAL");
      })
      .catch(() => {
        if (!cancelled) setUpdate(null);
      });

    return () => { cancelled = true; };
  }, [pathname]);

  const visible = useMemo(() => {
    if (!update || update.id === hiddenId || !update.unread || update.importance === "SILENT") return false;
    return shouldSurface(pathname, update);
  }, [hiddenId, pathname, update]);

  if (!visible || !update) return null;

  async function dismiss() {
    if (!update) return;
    setHiddenId(update.id);
    setSpotlightOpen(false);
    window.dispatchEvent(new CustomEvent("product-updates-read"));
    await fetch("/api/updates", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updateId: update.id }),
    }).catch(() => {});
  }

  const targetHref = update.ctaHref || update.targetPath || "/updates";
  const targetIsCurrentPage = pathname === targetHref || pathname.startsWith(`${targetHref}/`);

  return (
    <>
      <div className="shrink-0 border-b border-amber-300/15 bg-[#101015] px-3 py-2 text-slate-100 md:px-5">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-amber-300/25 bg-amber-300/10 text-amber-200">
              <Megaphone className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[11px] font-bold text-amber-100">
                  อัปเดตใหม่
                </span>
                <span className="text-[11px] font-semibold text-slate-500">{update.version}</span>
              </div>
              <p className="mt-1 text-sm font-semibold leading-snug text-white">{update.title}</p>
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{update.summary}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
            <Link
              href="/updates"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
            >
              ดูรายละเอียด
              <ArrowRight className="h-4 w-4" />
            </Link>
            {!targetIsCurrentPage && (
              <Link
                href={targetHref}
                className="hidden h-9 items-center rounded-md border border-white/10 px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10 md:inline-flex"
              >
                {update.ctaLabel || "ไปใช้งาน"}
              </Link>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label="ปิดประกาศ"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {spotlightOpen && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-lg border border-white/10 bg-[#111118] p-5 text-slate-100 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs font-bold text-amber-100">
                  อัปเดตสำคัญ
                </span>
                <h2 className="mt-3 text-xl font-semibold tracking-normal text-white">{update.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{update.summary}</p>
              </div>
              <button
                type="button"
                onClick={() => setSpotlightOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 text-slate-400 transition hover:bg-white/10 hover:text-white"
                aria-label="ปิดประกาศสำคัญ"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <Link
                href="/updates"
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
              >
                ดูรายละเอียด
                <ArrowRight className="h-4 w-4" />
              </Link>
              <button
                type="button"
                onClick={dismiss}
                className={cn(
                  "inline-flex h-10 flex-1 items-center justify-center rounded-md border border-white/10 px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10",
                )}
              >
                รับทราบแล้ว
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
