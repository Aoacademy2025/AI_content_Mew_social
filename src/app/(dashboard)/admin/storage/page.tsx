"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminCleanupFailureMessage,
  adminCleanupSelectionsEqual,
  createAdminCleanupReviewCoordinator,
  type AdminCleanupSelection,
} from "@/lib/admin-cleanup-review";
import {
  Loader2, ArrowRight, Trash2, HardDrive, ShieldCheck, AlertTriangle, ClipboardCheck,
} from "lucide-react";
import { toast } from "sonner";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

interface CleanupInfo {
  renders: {
    total: { count: number; sizeMb: number };
    older1d: { count: number; sizeMb: number };
    older3d: { count: number; sizeMb: number };
    older7d: { count: number; sizeMb: number };
  };
  stocks: { older1d: { count: number; sizeMb: number } };
  tmp: { sizeMb: number; count: number };
  protectedCount: number;
  generatedAt: string;
  manifestSha256: string;
  graphErrorCount: number;
  selected: {
    olderThanDays: number;
    includeStocks: boolean;
    includeTmp: boolean;
    renders: { count: number; sizeMb: number };
    stocks: { count: number; sizeMb: number };
    tmp: { count: number; sizeMb: number };
    total: { count: number; sizeMb: number };
  };
  candidates: Array<{
    key: string;
    sizeBytes: number;
    effectiveExpiresAt: string | null;
    reason: "all_references_expired" | "unreferenced_14d";
    fingerprint: string;
  }>;
}

function cleanupReviewMatches(
  review: CleanupInfo,
  selection: AdminCleanupSelection,
) {
  return adminCleanupSelectionsEqual(review.selected, selection);
}

interface StorageHealth {
  checkedAt: string;
  status: "ok" | "warning" | "high" | "critical";
  thresholds: { warning: number; high: number; critical: number };
  disk: {
    mount: string;
    filesystem: string;
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPercent: number;
  };
  directories: Array<{
    key: string;
    label: string;
    path: string;
    exists: boolean;
    sizeMb: number;
    sizeGb: number;
  }>;
}

export default function AdminStoragePage() {
  const [cleanupInfo, setCleanupInfo] = useState<CleanupInfo | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanDays, setCleanDays] = useState(3);
  const [includeStocks, setIncludeStocks] = useState(false);
  const [includeTmp, setIncludeTmp] = useState(false);
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const cleanupReviewCoordinator = useRef(createAdminCleanupReviewCoordinator({
    olderThanDays: 3,
    includeStocks: false,
    includeTmp: false,
  }));
  const cleanupSelection = { olderThanDays: cleanDays, includeStocks, includeTmp };
  cleanupReviewCoordinator.current.setSelection(cleanupSelection);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);

  const loadCleanupInfo = useCallback(async () => {
    setCleanupLoading(true);
    setCleanupError(null);
    const request = await cleanupReviewCoordinator.current.request(async (selection) => {
      const params = new URLSearchParams({
        olderThanDays: String(selection.olderThanDays),
        includeStocks: selection.includeStocks ? "1" : "0",
        includeTmp: selection.includeTmp ? "1" : "0",
      });
      const response = await fetch(`/api/admin/cleanup?${params.toString()}`, { cache: "no-store" });
      return { response, data: await response.json() };
    });
    if (!request.current) return;
    setCleanupLoading(false);
    if (!request.ok) {
      setCleanupInfo(null);
      setCleanupError("เชื่อมต่อระบบตรวจสอบไฟล์ไม่สำเร็จ กรุณาลองใหม่");
      return;
    }
    if (!request.value.response.ok) {
      setCleanupInfo(null);
      setCleanupError(adminCleanupFailureMessage(request.value.data));
      return;
    }
    setCleanupError(null);
    setCleanupInfo(request.value.data);
  }, []);

  // B1: `force` defaults false so the mount call below hits the cache; only the
  // refresh button passes `true` (?refresh=1) to force a fresh disk walk.
  function loadStorageHealth(force = false) {
    setStorageLoading(true);
    fetch(`/api/admin/storage${force ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (!d.error) setStorageHealth(d);
      })
      .catch(() => {})
      .finally(() => setStorageLoading(false));
  }

  function refreshStorageInfo() {
    loadStorageHealth(true);
    loadCleanupInfo();
  }

  async function runCleanup() {
    const review = cleanupInfo;
    const selected = cleanupReviewCoordinator.current.getSelection();
    if (!review || !cleanupReviewMatches(review, selected)) {
      setCleanupInfo(null);
      setShowCleanConfirm(false);
      toast.error("ตัวเลือกเปลี่ยนแล้ว กรุณาตรวจสอบรายการใหม่");
      await loadCleanupInfo();
      return;
    }
    setCleaning(true);
    setShowCleanConfirm(false);
    try {
      const res = await fetch("/api/admin/cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apply: true,
          manifestSha256: review.manifestSha256,
          olderThanDays: review.selected.olderThanDays,
          includeStocks: review.selected.includeStocks,
          includeTmp: review.selected.includeTmp,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        const quarantined = d.result?.quarantined?.count ?? 0;
        const skipped = d.result?.skipped?.count ?? 0;
        const tmpDeleted = d.tmpResult?.deleted ?? 0;
        toast.success(`กักกัน ${quarantined} ไฟล์ · ข้าม ${skipped} · ล้าง tmp ${tmpDeleted}`);
        refreshStorageInfo();
      } else if (res.status === 409) {
        setCleanupInfo(null);
        toast.error("รายการตรวจสอบเปลี่ยนแล้ว กรุณาตรวจสอบและยืนยันใหม่");
        await loadCleanupInfo();
      } else {
        toast.error(d.error ?? "กักกันไฟล์ไม่สำเร็จ");
      }
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    loadStorageHealth();
  }, []);

  useEffect(() => {
    setCleanupInfo(null);
    setShowCleanConfirm(false);
    void loadCleanupInfo();
    return () => {
      cleanupReviewCoordinator.current.invalidate();
    };
  }, [cleanDays, includeStocks, includeTmp, loadCleanupInfo]);

  const storageTone = {
    ok: {
      label: "ปกติ",
      text: "text-green-300",
      border: "border-green-500/25",
      bg: "bg-green-500/8",
      bar: "bg-green-400",
    },
    warning: {
      label: "เฝ้าระวัง",
      text: "text-yellow-300",
      border: "border-yellow-500/30",
      bg: "bg-yellow-500/10",
      bar: "bg-yellow-400",
    },
    high: {
      label: "สูง",
      text: "text-orange-300",
      border: "border-orange-500/35",
      bg: "bg-orange-500/10",
      bar: "bg-orange-400",
    },
    critical: {
      label: "วิกฤต",
      text: "text-red-300",
      border: "border-red-500/40",
      bg: "bg-red-500/12",
      bar: "bg-red-400",
    },
  }[storageHealth?.status ?? "ok"];
  const cleanupReviewCurrent = cleanupInfo
    ? cleanupReviewMatches(cleanupInfo, cleanupSelection)
    : false;
  const cleanupReviewCount = cleanupReviewCurrent ? cleanupInfo?.selected.total.count ?? 0 : 0;

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--ui-text-primary)" }}>
              <HardDrive className="h-5 w-5" style={{ color: VIOLET }} />
              จัดการพื้นที่ดิสก์
            </h2>
            <button onClick={refreshStorageInfo} disabled={cleanupLoading || storageLoading}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1">
              {cleanupLoading || storageLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 -rotate-90" />}
              รีเฟรช
            </button>
          </div>

          {storageHealth && (
            <div className={`mb-4 rounded-2xl border ${storageTone.border} ${storageTone.bg} p-5`}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <HardDrive className={`h-4 w-4 ${storageTone.text}`} />
                    <span className={`text-sm font-semibold ${storageTone.text}`}>Disk Status: {storageTone.label}</span>
                    <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ background: "var(--ui-badge-neutral-bg)", borderColor: "var(--ui-badge-neutral-border)", color: "var(--ui-text-muted)" }}>
                      alert {storageHealth.thresholds.warning}/{storageHealth.thresholds.high}/{storageHealth.thresholds.critical}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-black/30">
                    <div
                      className={`h-full rounded-full ${storageTone.bar}`}
                      style={{ width: `${Math.min(100, storageHealth.disk.usedPercent)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    ใช้ไป {storageHealth.disk.usedGb}GB จาก {storageHealth.disk.totalGb}GB · เหลือ {storageHealth.disk.availableGb}GB · mount {storageHealth.disk.mount}
                  </p>
                </div>

                <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[520px]">
                  {storageHealth.directories.map(dir => (
                    <div key={dir.key} className="rounded-xl px-3 py-2" style={cardStyle}>
                      <p className="truncate text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{dir.label}</p>
                      <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>{dir.sizeGb >= 1 ? `${dir.sizeGb}GB` : `${dir.sizeMb}MB`}</p>
                    </div>
                  ))}
                </div>
              </div>

              {storageHealth.status !== "ok" && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
                  <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${storageTone.text}`} />
                  <p className={`text-xs ${storageTone.text}`}>
                    พื้นที่ดิสก์เกิน threshold แล้ว ควรตรวจ orphan media, stock cache และไฟล์ render ที่โตผิดปกติก่อนปล่อยให้เกิน 90%
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="rounded-2xl p-5 space-y-5" style={cardStyle}>
            {/* Stats row */}
            {/* /renders stats */}
            <div>
              <p className="text-xs mb-2 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>/renders (วิดีโอ render)</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "ทั้งหมด", val: cleanupInfo?.renders.total, color: "zinc" },
                  { label: "เกิน 1 วัน", val: cleanupInfo?.renders.older1d, color: "yellow" },
                  { label: "เกิน 3 วัน", val: cleanupInfo?.renders.older3d, color: "orange" },
                  { label: "เกิน 7 วัน", val: cleanupInfo?.renders.older7d, color: "red" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="rounded-xl p-3 text-center" style={cardStyle}>
                    <p className="text-xs mb-1" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                    {cleanupLoading ? null : (
                      <>
                        <p className={`text-xl font-bold ${color === "red" ? "text-red-400" : color === "orange" ? "text-orange-400" : color === "yellow" ? "text-yellow-400" : "text-zinc-300"}`}>
                          {val?.sizeMb ?? 0} MB
                        </p>
                        <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{val?.count ?? 0} ไฟล์</p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* /tmp stats */}
            <div>
              <p className="text-xs mb-2 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>/tmp (Remotion temp files)</p>
              <div className="rounded-xl p-3 flex items-center gap-4" style={cardStyle}>
                {cleanupLoading ? null : (
                  <>
                    <div>
                      <p className={`text-2xl font-bold ${(cleanupInfo?.tmp.sizeMb ?? 0) > 1000 ? "text-red-400" : (cleanupInfo?.tmp.sizeMb ?? 0) > 500 ? "text-orange-400" : "text-zinc-300"}`}>
                        {cleanupInfo?.tmp.sizeMb ?? 0} MB
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{cleanupInfo?.tmp.count ?? 0} temp folders</p>
                    </div>
                    <p className="text-xs flex-1" style={{ color: "var(--ui-text-muted)" }}>
                      remotion-webpack-bundle, react-motion-render, puppeteer_dev_chrome_profile
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Reference-graph protection notice */}
            {cleanupError && (
              <div className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
                style={{ background: "hsl(38 92% 50% / 0.08)", border: "1px solid hsl(38 92% 50% / 0.28)" }}>
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <span className="leading-relaxed text-amber-300">{cleanupError}</span>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: "hsl(140 60% 50% / 0.06)", border: "1px solid hsl(140 60% 50% / 0.2)" }}>
              <ShieldCheck className="h-4 w-4 text-green-400 shrink-0" />
              <span className="text-green-400/80">
                ไฟล์ที่ยังมี reference หรือยังไม่หมดอายุจะ<strong className="text-green-400"> ถูกปกป้อง</strong>
                {cleanupInfo && ` (ปกป้องอยู่ ${cleanupInfo.protectedCount} ไฟล์)`}
              </span>
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">เกณฑ์อายุ /tmp</span>
                <div className="flex gap-1">
                  {[1, 3, 7].map(d => (
                    <button key={d} onClick={() => {
                      cleanupReviewCoordinator.current.setSelection({
                        olderThanDays: d,
                        includeStocks,
                        includeTmp,
                      });
                      setCleanupInfo(null);
                      setShowCleanConfirm(false);
                      setCleanDays(d);
                    }}
                      className="px-3 py-1 rounded-lg text-xs font-semibold transition-all border"
                      style={cleanDays === d
                        ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT, borderColor: VIOLET_TILE_BORDER }
                        : { background: "var(--ui-btn-bg)", color: "var(--ui-text-muted)", borderColor: "var(--ui-btn-border)" }}>
                      {d} วัน
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={includeStocks} onChange={e => {
                  cleanupReviewCoordinator.current.setSelection({
                    olderThanDays: cleanDays,
                    includeStocks: e.target.checked,
                    includeTmp,
                  });
                  setCleanupInfo(null);
                  setShowCleanConfirm(false);
                  setIncludeStocks(e.target.checked);
                }}
                  className="accent-[#8B5CF6] h-3.5 w-3.5" />
                <span className="text-xs text-zinc-400">รวม /stocks (stock video cache)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={includeTmp} onChange={e => {
                  cleanupReviewCoordinator.current.setSelection({
                    olderThanDays: cleanDays,
                    includeStocks,
                    includeTmp: e.target.checked,
                  });
                  setCleanupInfo(null);
                  setShowCleanConfirm(false);
                  setIncludeTmp(e.target.checked);
                }}
                  className="accent-red-500 h-3.5 w-3.5" />
                <span className="text-xs text-zinc-400">
                  รวม /tmp Remotion temp
                  {cleanupInfo?.tmp.sizeMb ? <span className="text-red-400 font-semibold ml-1">({cleanupInfo.tmp.sizeMb} MB)</span> : ""}
                </span>
              </label>
            </div>

            {cleanupReviewCurrent && cleanupInfo && (
              <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-violet-200">
                  <ClipboardCheck className="h-4 w-4" />
                  <span>ตรวจสอบแล้ว {cleanupReviewCount} รายการ · {cleanupInfo.selected.total.sizeMb} MB</span>
                  <code className="rounded bg-black/25 px-2 py-0.5 text-[10px] text-violet-300">
                    {cleanupInfo.manifestSha256.slice(0, 12)}…
                  </code>
                </div>
                {cleanupInfo.candidates.length > 0 && (
                  <div className="mt-2 space-y-1 text-[10px] text-zinc-500">
                    {cleanupInfo.candidates.slice(0, 5).map(candidate => (
                      <p key={candidate.fingerprint} className="truncate">
                        {candidate.key} · {candidate.reason === "all_references_expired" ? "references หมดอายุ" : "ไม่มี reference เกิน 14 วัน"}
                      </p>
                    ))}
                    {cleanupInfo.candidates.length > 5 && <p>+ อีก {cleanupInfo.candidates.length - 5} รายการ</p>}
                  </div>
                )}
              </div>
            )}

            {/* Reviewed quarantine confirmation */}
            {!showCleanConfirm ? (
              <button onClick={() => {
                if (cleanupReviewCurrent) setShowCleanConfirm(true);
                else void loadCleanupInfo();
              }} disabled={cleaning || cleanupLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:brightness-110"
                style={{ background: "hsl(0 75% 55% / 0.2)", border: "1px solid hsl(0 75% 60% / 0.45)" }}>
                <ClipboardCheck className="h-4 w-4" />
                {cleanupReviewCurrent ? "ตรวจสอบก่อนกักกัน" : "สร้างรายการตรวจสอบ"}
              </button>
            ) : cleanupReviewCurrent && cleanupInfo ? (
              <div className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{ background: "hsl(14 90% 50% / 0.1)", border: "1px solid hsl(14 90% 50% / 0.3)" }}>
                <AlertTriangle className="h-4 w-4 text-orange-400 shrink-0" />
                <p className="text-xs text-orange-300 flex-1">
                  ยืนยันกักกันไฟล์ customer media {cleanupInfo.candidates.length} รายการตาม hash ที่ตรวจสอบแล้ว
                  {includeTmp ? ` และล้าง tmp ${cleanupInfo.selected.tmp.count} รายการแบบถาวร` : ""} ?
                </p>
                <button onClick={runCleanup} disabled={cleaning}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500/80 hover:bg-red-500 transition-all flex items-center gap-1.5">
                  {cleaning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  ยืนยันกักกัน
                </button>
                <button onClick={() => setShowCleanConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                  ยกเลิก
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
