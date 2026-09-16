"use client";

// ScriptHistory — the Hero Script "สคริปต์ของฉัน" list: topic, วันที่, and a
// status chip (ร่าง / ส่งแล้ว). Clicking a row restores that script into step 4;
// the trash button deletes it behind a confirm dialog.
//
// Reads GET /api/scripts (own scripts, newest first, take 50) and re-fetches
// whenever `refreshKey` changes — the editor bumps it after every autosave.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Search, Trash2 } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const VIOLET = "#8B5CF6";

export interface SavedScript {
  id: string;
  topic: string;
  durationSec: number;
  hookFormula: string | null;
  structure: string | null;
  hookText: string;
  bodyText: string;
  ctaText: string;
  status: string;
  brandProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

export interface ScriptLibraryItem {
  id: string;
  topic: string;
  brandProfileId: string | null;
  brandName: string | null;
  durationSec: number;
  status: string;
  editorProjectId: string | null;
  editorProjectAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptLibraryPage {
  items: ScriptLibraryItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface ScriptLibraryQuery {
  q: string;
  status: "all" | "draft" | "sent";
  brandProfileId: string | "none" | null;
  page: number;
  pageSize: number;
}

type RequestCounter = { current: number };
type LibraryFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type LibraryLoadOutcome =
  | { status: "applied"; data: ScriptLibraryPage }
  | { status: "stale" }
  | { status: "error"; message: string };

function isLibraryPage(value: unknown): value is ScriptLibraryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<ScriptLibraryPage>;
  return Array.isArray(page.items)
    && Number.isSafeInteger(page.total)
    && Number.isSafeInteger(page.page)
    && Number.isSafeInteger(page.pageSize)
    && typeof page.hasNextPage === "boolean";
}

/** The request counter is the observable race boundary: only the latest list
 * response may become UI state, including when an older request fails later. */
export async function loadLatestScriptLibraryPage(
  query: ScriptLibraryQuery,
  latestRequest: RequestCounter,
  fetcher: LibraryFetcher = authenticatedFetch,
): Promise<LibraryLoadOutcome> {
  const requestId = ++latestRequest.current;
  const params = new URLSearchParams({
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q) params.set("q", query.q);
  if (query.brandProfileId) params.set("brandProfileId", query.brandProfileId);

  try {
    const response = await fetcher(`/api/scripts/library?${params}`);
    const payload = await response.json().catch(() => null);
    if (requestId !== latestRequest.current) return { status: "stale" };
    if (!response.ok) {
      return {
        status: "error",
        message: typeof payload?.error === "string" ? payload.error : "โหลดคลังสคริปต์ไม่สำเร็จ",
      };
    }
    if (!isLibraryPage(payload)) return { status: "error", message: "โหลดคลังสคริปต์ไม่สำเร็จ" };
    return { status: "applied", data: payload };
  } catch {
    return requestId === latestRequest.current
      ? { status: "error", message: "โหลดคลังสคริปต์ไม่สำเร็จ" }
      : { status: "stale" };
  }
}

interface ScriptLibraryProps {
  onOpenScript: (id: string) => void;
  activeScriptId: string | null;
  refreshKey: number;
}

const LIBRARY_PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 300;

export function ScriptLibrary({ onOpenScript, activeScriptId, refreshKey }: ScriptLibraryProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<ScriptLibraryQuery["status"]>("all");
  const [brandProfileId, setBrandProfileId] = useState<string | "none" | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ScriptLibraryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [deleteItem, setDeleteItem] = useState<ScriptLibraryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const latestRequest = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setDebouncedSearch(search.trim());
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let current = true;
    void authenticatedFetch("/api/brand-profiles")
      .then((response) => response.ok ? response.json() : [])
      .then((value: unknown) => {
        if (!current || !Array.isArray(value)) return;
        setProfiles(value.flatMap((profile) => {
          if (!profile || typeof profile !== "object") return [];
          const row = profile as { id?: unknown; name?: unknown };
          return typeof row.id === "string" && typeof row.name === "string"
            ? [{ id: row.id, name: row.name }]
            : [];
        }));
      })
      .catch(() => {});
    return () => { current = false; };
  }, []);

  useEffect(() => {
    void loadLatestScriptLibraryPage({
      q: debouncedSearch,
      status,
      brandProfileId,
      page,
      pageSize: LIBRARY_PAGE_SIZE,
    }, latestRequest).then((outcome) => {
      if (outcome.status === "stale") return;
      setLoading(false);
      if (outcome.status === "error") {
        setError(outcome.message);
        return;
      }
      setData(outcome.data);
      if (outcome.data.items.length === 0 && outcome.data.total > 0 && page > 1) {
        setLoading(true);
        setPage(Math.ceil(outcome.data.total / LIBRARY_PAGE_SIZE));
      }
    });
  }, [brandProfileId, debouncedSearch, page, refreshKey, retryKey, status]);

  const brandOptions = useMemo(() => {
    const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
    for (const item of data?.items ?? []) {
      if (item.brandProfileId && item.brandName) names.set(item.brandProfileId, item.brandName);
    }
    return [...names].sort((a, b) => a[1].localeCompare(b[1], "th"));
  }, [data?.items, profiles]);

  function clearFilters() {
    setLoading(true);
    setError(null);
    setSearch("");
    setDebouncedSearch("");
    setStatus("all");
    setBrandProfileId(null);
    setPage(1);
  }

  async function confirmDelete() {
    if (!deleteItem) return;
    setDeleting(true);
    try {
      const response = await authenticatedFetch(`/api/scripts/${encodeURIComponent(deleteItem.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error || "ลบสคริปต์ไม่สำเร็จ");
        return;
      }
      latestRequest.current += 1;
      setData((current) => current ? {
        ...current,
        total: Math.max(0, current.total - 1),
        items: current.items.filter((item) => item.id !== deleteItem.id),
      } : current);
      toast.success("ลบสคริปต์แล้ว");
      setRetryKey((key) => key + 1);
    } catch {
      toast.error("ลบสคริปต์ไม่สำเร็จ");
    } finally {
      setDeleting(false);
      setDeleteItem(null);
    }
  }

  const hasFilters = !!debouncedSearch || status !== "all" || brandProfileId !== null;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / LIBRARY_PAGE_SIZE));

  return (
    <section className="min-w-0 rounded-2xl p-4 sm:p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <div className="mb-4 flex flex-col gap-3">
        <div className="relative">
          <label htmlFor="script-library-search" className="mb-1.5 block text-sm font-medium" style={{ color: "var(--ui-text-primary)" }}>
            ค้นหาสคริปต์
          </label>
          <Search aria-hidden="true" className="pointer-events-none absolute bottom-3 left-3 h-4 w-4" style={{ color: "var(--ui-text-muted)" }} />
          <input
            id="script-library-search"
            type="search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setLoading(true); setError(null); }}
            className="min-h-11 w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-base outline-none focus:ring-2"
            style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-primary)", "--tw-ring-color": VIOLET } as React.CSSProperties}
            placeholder="ค้นหาจากหัวข้อ"
            maxLength={200}
          />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
            โปรไฟล์แบรนด์
            <select
              value={brandProfileId ?? ""}
              onChange={(event) => { setBrandProfileId(event.target.value || null); setPage(1); setLoading(true); setError(null); }}
              className="mt-1 min-h-11 w-full rounded-lg border bg-transparent px-3 text-base sm:text-sm"
              style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-primary)" }}
            >
              <option value="">ทุกแบรนด์</option>
              <option value="none">ไม่ใช้โปรไฟล์</option>
              {brandOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
            สถานะ
            <select
              value={status}
              onChange={(event) => { setStatus(event.target.value as ScriptLibraryQuery["status"]); setPage(1); setLoading(true); setError(null); }}
              className="mt-1 min-h-11 w-full rounded-lg border bg-transparent px-3 text-base sm:text-sm"
              style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-primary)" }}
            >
              <option value="all">ทั้งหมด</option>
              <option value="draft">ร่าง</option>
              <option value="sent">ส่งแล้ว</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ui-danger, #ef4444)", color: "var(--ui-text-primary)" }}>
          <span>โหลดคลังสคริปต์ไม่สำเร็จ</span>
          <button type="button" onClick={() => { setLoading(true); setError(null); setRetryKey((key) => key + 1); }} className="min-h-11 rounded-lg px-3 font-medium" style={{ color: VIOLET }}>
            ลองอีกครั้ง
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="flex min-h-24 items-center justify-center gap-2 text-sm" style={{ color: "var(--ui-text-muted)" }}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> กำลังโหลดคลังสคริปต์...
        </div>
      ) : data && data.total === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>
            {hasFilters ? "ไม่พบสคริปต์ที่ตรงกับการค้นหา" : "ยังไม่มีสคริปต์"}
          </p>
          {hasFilters ? (
            <button type="button" onClick={clearFilters} className="min-h-11 rounded-lg px-4 text-sm font-medium" style={{ color: VIOLET }}>
              ล้างตัวกรอง
            </button>
          ) : (
            <a href="/hero-script" className="flex min-h-11 items-center rounded-lg px-4 text-sm font-medium" style={{ color: VIOLET }}>
              เริ่มเขียนสคริปต์
            </a>
          )}
        </div>
      ) : data ? (
        <>
          <div className="mb-2 flex min-h-6 items-center justify-between gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
            <span>พบ {data.total.toLocaleString("th-TH")} สคริปต์</span>
            {loading && <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> กำลังอัปเดต...</span>}
          </div>
          <div className="divide-y" style={{ borderColor: "var(--ui-card-border)" }}>
            {data.items.map((item) => {
              const active = item.id === activeScriptId;
              const sent = item.status === "sent";
              return (
                <article key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <button
                    type="button"
                    onClick={() => onOpenScript(item.id)}
                    className="min-h-11 min-w-0 rounded-lg px-2 text-left outline-none focus:ring-2"
                    style={{ background: active ? "rgba(139,92,246,.08)" : "transparent", "--tw-ring-color": VIOLET } as React.CSSProperties}
                  >
                    <span className="line-clamp-2 break-words text-base font-medium" style={{ color: "var(--ui-text-primary)" }}>{item.topic}</span>
                    <span className="mt-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>
                      {item.brandName ?? "ไม่ใช้โปรไฟล์"} · {item.durationSec} วินาที · {formatDate(item.updatedAt)}
                    </span>
                  </button>
                  <span className="shrink-0 self-start rounded-full px-2 py-1 text-xs sm:self-auto" style={{ background: sent ? "rgba(139,92,246,.15)" : "var(--ui-btn-bg)", color: sent ? VIOLET : "var(--ui-text-muted)" }}>
                    {sent ? "ส่งแล้ว" : "ร่าง"}
                  </span>
                  <div className="col-span-2 flex flex-wrap items-center justify-end gap-1 sm:col-span-1 sm:flex-nowrap">
                    {sent && item.editorProjectAvailable && item.editorProjectId ? (
                      <Link
                        href={`/video-editor?projectId=${encodeURIComponent(item.editorProjectId)}`}
                        className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-medium"
                        style={{ color: VIOLET }}
                      >
                        เปิดงานตัดต่อเดิม <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    ) : sent ? (
                      <span className="px-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>งานตัดต่อเดิมไม่พร้อมใช้งาน</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setDeleteItem(item)}
                      className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-black/5 focus:ring-2 dark:hover:bg-white/5"
                      aria-label={`ลบ ${item.topic}`}
                      style={{ "--tw-ring-color": VIOLET } as React.CSSProperties}
                    >
                      <Trash2 className="h-4 w-4" style={{ color: "var(--ui-text-muted)" }} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <nav aria-label="หน้าคลังสคริปต์" className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--ui-card-border)" }}>
            <button type="button" disabled={page <= 1 || loading} onClick={() => { setLoading(true); setError(null); setPage((value) => Math.max(1, value - 1)); }} className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> ก่อนหน้า
            </button>
            <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>หน้า {page} จาก {pageCount}</span>
            <button type="button" disabled={!data.hasNextPage || loading} onClick={() => { setLoading(true); setError(null); setPage((value) => value + 1); }} className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm disabled:opacity-40">
              ถัดไป <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </nav>
        </>
      ) : null}

      <AlertDialog open={!!deleteItem} onOpenChange={(open) => !open && setDeleteItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ลบสคริปต์นี้?</AlertDialogTitle>
            <AlertDialogDescription>การลบไม่สามารถย้อนกลับได้</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={confirmDelete} disabled={deleting}>ลบ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

interface ScriptHistoryProps {
  /** Bump to re-fetch the list (after a save). */
  refreshKey: number;
  activeScriptId: string | null;
  onRestore: (script: SavedScript) => void;
  onDeleted?: (id: string) => void;
}

export function ScriptHistory({ refreshKey, activeScriptId, onRestore, onDeleted }: ScriptHistoryProps) {
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchScripts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/scripts");
      if (res.ok) {
        const data = await res.json();
        setScripts(Array.isArray(data) ? data : []);
      }
    } catch {
      toast.error("โหลดสคริปต์ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  // This temporary legacy export stays byte-for-byte operational until Task 3
  // switches the page to ScriptLibrary and removes it.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchScripts(); }, [fetchScripts, refreshKey]);

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/scripts/${deleteId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || "ลบสคริปต์ไม่สำเร็จ");
        return;
      }
      toast.success("ลบสคริปต์แล้ว");
      onDeleted?.(deleteId);
      await fetchScripts();
    } catch {
      toast.error("ลบสคริปต์ไม่สำเร็จ");
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สคริปต์ของฉัน</h2>

      {loading ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังโหลด...
        </div>
      ) : scripts.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีสคริปต์</p>
      ) : (
        <div className="space-y-2">
          {scripts.map((s) => {
            const isActive = activeScriptId === s.id;
            const sent = s.status === "sent";
            return (
              <div
                key={s.id}
                // items-start (not center): the topic can now wrap to 2 lines
                // (line-clamp-2 below), so the chip/delete button must anchor to
                // the top of the row instead of the vertical middle of two lines.
                className="flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: isActive ? VIOLET : "var(--ui-card-border)",
                  background: isActive ? "rgba(139,92,246,.08)" : "transparent",
                }}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onRestore(s)}>
                  {/* line-clamp-2 (was truncate/1-line) — a long topic no longer
                      collapses to a few unreadable characters + ellipsis. */}
                  <p className="line-clamp-2 font-medium" style={{ color: "var(--ui-text-primary)" }}>{s.topic}</p>
                  <p className="mt-0.5" style={{ color: "var(--ui-text-muted)" }}>{formatDate(s.createdAt)}</p>
                </button>
                <span
                  className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                  style={{
                    background: sent ? "rgba(139,92,246,.15)" : "var(--ui-btn-bg)",
                    color: sent ? VIOLET : "var(--ui-text-muted)",
                  }}
                >
                  {sent ? "ส่งแล้ว" : "ร่าง"}
                </span>
                {/* 44x44 hit area (was p-1.5 ≈ 26px) */}
                <button
                  onClick={() => setDeleteId(s.id)}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5"
                  aria-label="ลบ"
                >
                  <Trash2 className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ลบสคริปต์นี้?</AlertDialogTitle>
            <AlertDialogDescription>การลบไม่สามารถย้อนกลับได้</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={confirmDelete} disabled={deleting}>ลบ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
