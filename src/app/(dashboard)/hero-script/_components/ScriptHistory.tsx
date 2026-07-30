"use client";

// ScriptHistory — the Hero Script "สคริปต์ของฉัน" list: topic, วันที่, and a
// status chip (ร่าง / ส่งแล้ว). Clicking a row restores that script into step 4;
// the trash button deletes it behind a confirm dialog.
//
// Reads GET /api/scripts (own scripts, newest first, take 50) and re-fetches
// whenever `refreshKey` changes — the editor bumps it after every autosave.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
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
                className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: isActive ? VIOLET : "var(--ui-card-border)",
                  background: isActive ? "rgba(139,92,246,.08)" : "transparent",
                }}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onRestore(s)}>
                  <p className="truncate font-medium" style={{ color: "var(--ui-text-primary)" }}>{s.topic}</p>
                  <p style={{ color: "var(--ui-text-muted)" }}>{formatDate(s.createdAt)}</p>
                </button>
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                  style={{
                    background: sent ? "rgba(139,92,246,.15)" : "var(--ui-btn-bg)",
                    color: sent ? VIOLET : "var(--ui-text-muted)",
                  }}
                >
                  {sent ? "ส่งแล้ว" : "ร่าง"}
                </span>
                <button
                  onClick={() => setDeleteId(s.id)}
                  className="shrink-0 rounded p-1.5 hover:bg-black/5 dark:hover:bg-white/5"
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
            <AlertDialogCancel>ยกเลิก</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>ลบ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
