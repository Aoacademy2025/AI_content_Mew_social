"use client";

// ScriptLibrary v2 — owner-scoped server search and pagination using shadcn
// Select & DropdownMenu primitives (no native <select> dark-mode glitches or
// stuck <details> menus). Preserves all race guards & ownership boundaries.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, MoreHorizontal, Search, Trash2 } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HS_COLOR } from "./hero-script-tokens";

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
  editorProjectId: string | null;
  editorProjectAvailable: boolean;
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
  brandOptions: Array<{ id: string; name: string }>;
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
    && Array.isArray(page.brandOptions)
    && page.brandOptions.every((option) => (
      !!option
      && typeof option === "object"
      && typeof option.id === "string"
      && typeof option.name === "string"
    ))
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
  onOpenScript: (item: ScriptLibraryItem) => void;
  onOpenEditorProject?: (item: ScriptLibraryItem) => void;
  onCreateEditorProject?: (item: ScriptLibraryItem) => Promise<void>;
  handoffPending?: boolean;
  beforeDelete?: (item: ScriptLibraryItem) => Promise<boolean>;
  onDeleted?: (id: string) => void;
  onStartWriting?: () => void;
  activeScriptId: string | null;
  refreshKey: number;
  active?: boolean;
}

const LIBRARY_PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 300;
const BRAND_ALL_VALUE = "__all__";

export function ScriptLibrary({
  onOpenScript,
  onOpenEditorProject,
  onCreateEditorProject,
  handoffPending = false,
  beforeDelete,
  onDeleted,
  onStartWriting,
  activeScriptId,
  refreshKey,
  active = true,
}: ScriptLibraryProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<ScriptLibraryQuery["status"]>("all");
  const [brandProfileId, setBrandProfileId] = useState<string | "none" | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ScriptLibraryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [deleteItem, setDeleteItem] = useState<ScriptLibraryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setDebouncedSearch(search.trim());
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!active) return;
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
      setError(null);
      setData(outcome.data);
      if (outcome.data.items.length === 0 && outcome.data.total > 0 && page > 1) {
        setLoading(true);
        setPage(Math.ceil(outcome.data.total / LIBRARY_PAGE_SIZE));
      }
    });
  }, [active, brandProfileId, debouncedSearch, page, refreshKey, retryKey, status]);

  const brandOptions = data?.brandOptions ?? [];

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
      if (beforeDelete && !(await beforeDelete(deleteItem))) return;
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
      onDeleted?.(deleteItem.id);
      toast.success("ลบสคริปต์แล้ว");
      setRetryKey((key) => key + 1);
    } catch {
      toast.error("ลบสคริปต์ไม่สำเร็จ");
    } finally {
      setDeleting(false);
      setDeleteItem(null);
    }
  }

  async function createEditorProject(item: ScriptLibraryItem) {
    if (creatingId || handoffPending || !onCreateEditorProject) return;
    setCreatingId(item.id);
    try {
      await onCreateEditorProject(item);
    } finally {
      setCreatingId(null);
    }
  }

  const hasFilters = !!debouncedSearch || status !== "all" || brandProfileId !== null;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / LIBRARY_PAGE_SIZE));
  const selectedBrandLabel = brandProfileId === null
    ? "ทุกแบรนด์"
    : brandProfileId === "none"
      ? "ไม่ใช้โปรไฟล์"
      : brandOptions.find((option) => option.id === brandProfileId)?.name ?? "ทุกแบรนด์";
  const selectedStatusLabel = status === "draft" ? "ร่าง" : status === "sent" ? "ส่งแล้ว" : "ทั้งหมด";

  return (
    <section
      className="min-w-0 rounded-2xl p-4 sm:p-5"
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_13rem_10rem] lg:items-end">
        <div className="relative">
          <label htmlFor="script-library-search" className="mb-1.5 block text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            ค้นหาสคริปต์
          </label>
          <Search aria-hidden="true" className="pointer-events-none absolute bottom-3 left-3 h-4 w-4" style={{ color: "var(--ui-text-muted)" }} />
          <input
            id="script-library-search"
            type="search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setLoading(true); setError(null); }}
            className="min-h-11 w-full rounded-xl border py-2 pl-9 pr-3 text-base outline-none focus:ring-2"
            style={{
              borderColor: "var(--ui-card-border)",
              background: "var(--ui-input-bg)",
              color: "var(--ui-text-primary)",
              "--tw-ring-color": HS_COLOR.violet,
            } as React.CSSProperties}
            placeholder="ค้นหาจากหัวข้อ"
            maxLength={200}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            โปรไฟล์แบรนด์
          </span>
          <Select
            value={brandProfileId ?? BRAND_ALL_VALUE}
            onValueChange={(value) => {
              setBrandProfileId(value === BRAND_ALL_VALUE ? null : value);
              setPage(1);
              setLoading(true);
              setError(null);
            }}
          >
            <SelectTrigger aria-label="กรองตามโปรไฟล์แบรนด์" className="min-h-11 rounded-xl text-sm">
              <SelectValue>{selectedBrandLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BRAND_ALL_VALUE}>ทุกแบรนด์</SelectItem>
              <SelectItem value="none">ไม่ใช้โปรไฟล์</SelectItem>
              {brandOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            สถานะ
          </span>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as ScriptLibraryQuery["status"]);
              setPage(1);
              setLoading(true);
              setError(null);
            }}
          >
            <SelectTrigger aria-label="กรองตามสถานะสคริปต์" className="min-h-11 rounded-xl text-sm">
              <SelectValue>{selectedStatusLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ทั้งหมด</SelectItem>
              <SelectItem value="draft">ร่าง</SelectItem>
              <SelectItem value="sent">ส่งแล้ว</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm" style={{ borderColor: "var(--ui-danger, #ef4444)", color: "var(--ui-text-primary)" }}>
          <span>โหลดคลังสคริปต์ไม่สำเร็จ</span>
          <button type="button" onClick={() => { setLoading(true); setError(null); setRetryKey((key) => key + 1); }} className="min-h-10 rounded-lg px-3 font-medium" style={{ color: HS_COLOR.violet }}>
            ลองอีกครั้ง
          </button>
        </div>
      )}

      {!error && (loading && !data ? (
        <div className="flex min-h-24 items-center justify-center gap-2 text-sm" style={{ color: "var(--ui-text-muted)" }}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> กำลังโหลดคลังสคริปต์...
        </div>
      ) : data && data.total === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>
            {hasFilters ? "ไม่พบสคริปต์ที่ตรงกับการค้นหา" : "ยังไม่มีสคริปต์"}
          </p>
          {hasFilters ? (
            <button type="button" onClick={clearFilters} className="min-h-11 rounded-xl px-4 text-sm font-semibold" style={{ color: HS_COLOR.violet }}>
              ล้างตัวกรอง
            </button>
          ) : (
            <button type="button" onClick={onStartWriting} className="flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-white" style={{ background: HS_COLOR.violetGradient }}>
              เริ่มเขียนสคริปต์
            </button>
          )}
        </div>
      ) : data ? (
        <>
          <div className="mb-2 flex min-h-6 items-center justify-between gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
            <span>พบ {data.total.toLocaleString("th-TH")} สคริปต์</span>
            {loading && <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> กำลังอัปเดต...</span>}
          </div>
          <div className="divide-y" style={{ borderColor: "var(--ui-divider)" }}>
            {data.items.map((item) => {
              const isCurrent = item.id === activeScriptId;
              const sent = item.status === "sent";
              return (
                <article key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <button
                    type="button"
                    onClick={() => {
                      trackEvent("hero_script_script_opened", {
                        properties: { source: "library", status: item.status, durationSec: item.durationSec },
                      });
                      onOpenScript(item);
                    }}
                    className="min-h-11 min-w-0 rounded-xl px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-black/5 focus:ring-2 dark:hover:bg-white/5"
                    style={{ background: isCurrent ? HS_COLOR.violetSoft : "transparent", "--tw-ring-color": HS_COLOR.violet } as React.CSSProperties}
                  >
                    <span className="line-clamp-2 break-words text-base font-medium" style={{ color: "var(--ui-text-primary)" }}>{item.topic}</span>
                    <span className="mt-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>
                      {item.brandName ?? "ไม่ใช้โปรไฟล์"} · {item.durationSec} วินาที · {formatDate(item.updatedAt)}
                    </span>
                  </button>

                  <span
                    className="shrink-0 self-start rounded-full px-2.5 py-1 text-xs font-medium sm:self-auto"
                    style={{
                      background: sent ? HS_COLOR.ctaBg : "var(--ui-badge-neutral-bg)",
                      color: sent ? HS_COLOR.cta : "var(--ui-text-muted)",
                    }}
                  >
                    {sent ? "ส่งแล้ว" : "ร่าง"}
                  </span>

                  <div className="col-span-2 flex flex-wrap items-center justify-end gap-1 sm:col-span-1 sm:flex-nowrap">
                    {sent && item.editorProjectAvailable && item.editorProjectId ? (
                      <button
                        type="button"
                        onClick={() => onOpenEditorProject?.(item)}
                        className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ color: HS_COLOR.violet }}
                      >
                        เปิดงานตัดต่อเดิม <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : sent ? (
                      <span className="px-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>งานตัดต่อเดิมไม่พร้อมใช้งาน</span>
                    ) : null}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`ตัวเลือก ${item.topic}`}
                          className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 dark:hover:bg-white/5"
                          style={{ color: "var(--ui-text-secondary)", "--tw-ring-color": HS_COLOR.violet } as React.CSSProperties}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-48 border"
                        style={{ background: "var(--ui-card-bg)", borderColor: "var(--ui-card-border)" }}
                      >
                        <DropdownMenuItem
                          disabled={creatingId !== null || handoffPending || !onCreateEditorProject}
                          onSelect={() => { void createEditorProject(item); }}
                          className="min-h-10 cursor-pointer text-sm"
                        >
                          {creatingId === item.id ? "กำลังสร้าง…" : "สร้างงานตัดต่อใหม่"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setDeleteItem(item)}
                          className="min-h-10 cursor-pointer text-sm text-red-500 focus:text-red-500"
                        >
                          <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> ลบสคริปต์
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </article>
              );
            })}
          </div>

          <nav aria-label="หน้าคลังสคริปต์" className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--ui-divider)" }}>
            <button type="button" disabled={page <= 1 || loading} onClick={() => { setLoading(true); setError(null); setPage((value) => Math.max(1, value - 1)); }} className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> ก่อนหน้า
            </button>
            <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>หน้า {page} จาก {pageCount}</span>
            <button type="button" disabled={!data.hasNextPage || loading} onClick={() => { setLoading(true); setError(null); setPage((value) => value + 1); }} className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm disabled:opacity-40">
              ถัดไป <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </nav>
        </>
      ) : null)}

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
