"use client";

import { useState } from "react";
import Link from "next/link";
import { LockKeyhole, Plus, Trash2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BrandProfile } from "./types";

export function BrandList({
  profiles,
  cap,
  canCreate,
  creationRequiresResult,
  activeId,
  busy,
  onOpen,
  onArchive,
  onStartNew,
  onStartFromCurrentDefaults,
}: {
  profiles: BrandProfile[];
  cap: number | null;
  canCreate: boolean;
  creationRequiresResult: boolean;
  activeId: string | null;
  busy: boolean;
  onOpen: (profile: BrandProfile) => void;
  onArchive: (profile: BrandProfile) => void;
  onStartNew: () => void;
  onStartFromCurrentDefaults: () => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <Card className="h-fit p-3 lg:sticky lg:top-5">
      <div className="flex items-center justify-between px-1 pb-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          คลังแบรนด์
        </p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {profiles.length}/{cap ?? "∞"}
        </span>
      </div>

      {creationRequiresResult ? (
        <Button asChild variant="outline" className="mb-3 h-auto w-full whitespace-normal py-2.5 text-xs">
          <Link href="/video-editor">
            <WandSparkles className="h-4 w-4 shrink-0" />
            สร้างคลิปแรก แล้วบันทึกแนวภาพจากผลงานจริง
          </Link>
        </Button>
      ) : (
        <div className="mb-3 space-y-2">
          <Button
            type="button"
            onClick={onStartNew}
            disabled={!canCreate || busy}
            className="h-10 w-full bg-violet-600 text-white hover:bg-violet-600/90"
          >
            <Plus className="h-4 w-4" />
            สร้างแบรนด์ใหม่
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onStartFromCurrentDefaults}
            disabled={!canCreate || busy}
            className="h-10 w-full text-xs"
          >
            <WandSparkles className="h-4 w-4" />
            สร้างแบรนด์จากค่าที่ใช้อยู่
          </Button>
        </div>
      )}

      <div className="space-y-1">
        {profiles.map((profile) => {
          const active = activeId === profile.id;
          const confirming = confirmingId === profile.id;
          return (
            <div
              key={profile.id}
              className={cn(
                "overflow-hidden rounded-lg border transition-colors",
                active
                  ? "border-violet-500/50 bg-violet-500/10"
                  : "border-transparent hover:bg-accent",
              )}
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => onOpen(profile)}
                  aria-current={active ? "true" : undefined}
                  disabled={busy}
                  className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60 disabled:opacity-50"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm font-semibold leading-5",
                        active ? "text-violet-500" : "text-foreground",
                      )}
                    >
                      {profile.name}
                    </span>
                    {profile.frozen && (
                      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    รุ่น {profile.activeRevisionNumber || "—"}
                    {profile.niche ? ` · ${profile.niche}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`ลบแนวภาพ ${profile.name}`}
                  title="ลบออกจากคลังแบรนด์"
                  disabled={busy}
                  onClick={() => setConfirmingId(confirming ? null : profile.id)}
                  className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive/60 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {confirming && (
                <div className="border-t border-border px-3 py-2.5" role="alert">
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    ลบออกจากคลังสำหรับงานใหม่ คลิปเดิมและแนวภาพรุ่นเก่ายังอยู่
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmingId(null)}
                      className="h-8 flex-1 text-xs"
                    >
                      ยกเลิก
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setConfirmingId(null);
                        onArchive(profile);
                      }}
                      className="h-8 flex-1 text-xs"
                    >
                      ยืนยันลบ
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!profiles.length && (
          <p className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">
            ยังไม่มีแบรนด์ในคลัง
          </p>
        )}
      </div>
    </Card>
  );
}
