"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Bug,
  CheckCheck,
  Clock3,
  Loader2,
  Megaphone,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

type UpdateCategory = "FEATURE" | "IMPROVEMENT" | "FIX" | "PATCH" | "KNOWN_ISSUE" | "IN_PROGRESS";

type ProductUpdate = {
  id: string;
  version: string;
  title: string;
  summary: string;
  body: string | null;
  category: UpdateCategory;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  publishedAt: string;
  readAt: string | null;
  unread: boolean;
};

type UpdatesResponse = {
  currentVersion: string;
  unreadCount: number;
  total: number;
  updates: ProductUpdate[];
};

const filters: { key: "ALL" | UpdateCategory; label: string }[] = [
  { key: "ALL", label: "ทั้งหมด" },
  { key: "FEATURE", label: "ฟีเจอร์ใหม่" },
  { key: "IMPROVEMENT", label: "ปรับปรุง" },
  { key: "FIX", label: "แก้บัค" },
  { key: "PATCH", label: "Patch" },
  { key: "KNOWN_ISSUE", label: "กำลังติดตาม" },
  { key: "IN_PROGRESS", label: "กำลังแก้" },
];

const categoryMeta: Record<UpdateCategory, {
  label: string;
  icon: React.ElementType;
  tone: string;
}> = {
  FEATURE: {
    label: "Feature",
    icon: Sparkles,
    tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  },
  IMPROVEMENT: {
    label: "Improvement",
    icon: Rocket,
    tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  },
  FIX: {
    label: "Fix",
    icon: Bug,
    tone: "border-rose-400/25 bg-rose-400/10 text-rose-200",
  },
  PATCH: {
    label: "Patch",
    icon: ShieldCheck,
    tone: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  },
  KNOWN_ISSUE: {
    label: "Known issue",
    icon: AlertCircle,
    tone: "border-orange-400/25 bg-orange-400/10 text-orange-200",
  },
  IN_PROGRESS: {
    label: "In progress",
    icon: Wrench,
    tone: "border-violet-400/25 bg-violet-400/10 text-violet-200",
  },
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function UpdateBadge({ category }: { category: UpdateCategory }) {
  const meta = categoryMeta[category];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold", meta.tone)}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

export default function UpdatesPage() {
  const [data, setData] = useState<UpdatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | UpdateCategory>("ALL");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch("/api/updates", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "โหลดอัปเดตไม่ได้");
        return body as UpdatesResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        if (body.unreadCount > 0) {
          void fetch("/api/updates", { method: "PATCH", body: JSON.stringify({ all: true }) }).catch(() => {});
          setData({
            ...body,
            unreadCount: 0,
            updates: body.updates.map((update) => ({ ...update, unread: false, readAt: update.readAt ?? new Date().toISOString() })),
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const visibleUpdates = useMemo(() => {
    const updates = data?.updates ?? [];
    const q = query.trim().toLowerCase();
    return updates.filter((update) => {
      if (filter !== "ALL" && update.category !== filter) return false;
      if (!q) return true;
      return [update.version, update.title, update.summary, update.body ?? ""]
        .some((text) => text.toLowerCase().includes(q));
    });
  }, [data?.updates, filter, query]);

  const latestUpdate = data?.updates?.[0] ?? null;

  return (
    <main className="min-h-screen bg-[#0a0d12] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="border-b border-white/10 pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-semibold text-slate-300">
                <Megaphone className="h-3.5 w-3.5 text-sky-300" />
                Product Updates
              </div>
              <h1 className="text-2xl font-semibold tracking-normal text-white sm:text-3xl">อัปเดต HeroAI Studio</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
                ดูว่า version ล่าสุดคืออะไร แก้อะไรแล้ว และเรื่องไหนที่ทีมกำลังติดตามอยู่
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[360px]">
              <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                <div className="text-xs font-medium text-slate-500">Current version</div>
                <div className="mt-1 flex items-center gap-2 text-xl font-semibold text-white">
                  <BadgeCheck className="h-5 w-5 text-emerald-300" />
                  {data?.currentVersion ?? "-"}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                <div className="text-xs font-medium text-slate-500">Latest update</div>
                <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-white">
                  <Clock3 className="h-4 w-4 text-sky-300" />
                  {latestUpdate ? formatDate(latestUpdate.publishedAt) : "-"}
                </div>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-3 lg:grid-cols-[1fr_280px] lg:items-center">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {filters.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={cn(
                  "whitespace-nowrap rounded-md border px-3 py-2 text-sm font-semibold transition",
                  filter === item.key
                    ? "border-white/30 bg-white text-slate-950"
                    : "border-white/10 bg-white/[0.035] text-slate-400 hover:bg-white/[0.07] hover:text-white",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ค้นหา update"
              className="h-10 w-full rounded-md border border-white/10 bg-white/[0.035] pl-9 pr-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-sky-400/50 focus:bg-white/[0.06]"
            />
          </label>
        </section>

        {loading && (
          <div className="flex h-64 items-center justify-center rounded-lg border border-white/10 bg-white/[0.025]">
            <Loader2 className="h-6 w-6 animate-spin text-sky-300" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
            {error}
          </div>
        )}

        {!loading && !error && data && data.updates.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-8 text-center">
            <Megaphone className="mx-auto h-9 w-9 text-slate-600" />
            <h2 className="mt-4 text-lg font-semibold text-white">ยังไม่มี update ที่เผยแพร่</h2>
            <p className="mt-2 text-sm text-slate-500">เมื่อทีมประกาศ patch หรือฟีเจอร์ใหม่ รายการจะขึ้นที่นี่</p>
          </div>
        )}

        {!loading && !error && data && data.updates.length > 0 && (
          <section className="relative">
            <div className="absolute bottom-0 left-[15px] top-0 hidden w-px bg-white/10 sm:block" />
            <div className="space-y-4">
              {visibleUpdates.map((update) => (
                <article key={update.id} className="relative grid gap-3 sm:grid-cols-[32px_1fr]">
                  <div className="hidden sm:flex">
                    <div className={cn(
                      "relative z-10 mt-5 flex h-8 w-8 items-center justify-center rounded-full border",
                      update.isPinned ? "border-amber-300/40 bg-amber-300/15" : "border-white/10 bg-[#0a0d12]",
                    )}>
                      <CheckCheck className={cn("h-4 w-4", update.isPinned ? "text-amber-200" : "text-slate-500")} />
                    </div>
                  </div>

                  <div className={cn(
                    "rounded-lg border p-4 sm:p-5",
                    update.isPinned ? "border-amber-300/25 bg-amber-300/[0.055]" : "border-white/10 bg-white/[0.03]",
                  )}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <UpdateBadge category={update.category} />
                          <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs font-semibold text-slate-300">
                            {update.version}
                          </span>
                          {update.isPinned && (
                            <span className="rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs font-semibold text-amber-200">
                              สำคัญ
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 text-lg font-semibold tracking-normal text-white">{update.title}</h2>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">{update.summary}</p>
                      </div>
                      <time className="shrink-0 text-xs text-slate-500">{formatDate(update.publishedAt)}</time>
                    </div>

                    {update.body && (
                      <div className="mt-4 whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-relaxed text-slate-300">
                        {update.body}
                      </div>
                    )}

                    {(update.ctaHref || update.targetPath) && (
                      <div className="mt-4">
                        <Link
                          href={update.ctaHref ?? update.targetPath ?? "/dashboard"}
                          className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
                        >
                          {update.ctaLabel ?? "ไปใช้งาน"}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {visibleUpdates.length === 0 && (
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-8 text-center text-sm text-slate-500">
                ไม่พบ update ตาม filter นี้
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
