"use client";

import Link from "next/link";
import { LockKeyhole, Plus, WandSparkles } from "lucide-react";
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
  onStartNew: () => void;
  onStartFromCurrentDefaults: () => void;
}) {
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
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => onOpen(profile)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
                active
                  ? "border-violet-500/50 bg-violet-500/10"
                  : "border-transparent hover:bg-accent",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span
                  className={cn(
                    "text-sm font-semibold leading-5",
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
