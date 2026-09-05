"use client";
import { useState } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VISUAL_FORMATS } from "@/lib/brand-visual-system";
import type { BrandProfile, LibraryResponse } from "./types";

export function BrandLibraryOverview({ library, busy, onNew, onOpen, onUse, onArchive }: {
  library: LibraryResponse; busy: boolean; onNew: () => void;
  onOpen: (profile: BrandProfile) => void; onUse: (profile: BrandProfile) => void; onArchive: (profile: BrandProfile) => void;
}) {
  const [archiveId, setArchiveId] = useState<string | null>(null);
  return <section className="min-w-0" aria-label="คลังแบรนด์">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{library.profiles.length} แบรนด์{library.cap !== null ? ` · บันทึกได้ ${library.cap} แบรนด์` : ""}</p>
      <Button type="button" variant="outline" onClick={onNew} disabled={busy || !library.canCreate} className="min-h-11"><Plus className="h-4 w-4" />สร้างแบรนด์ใหม่</Button>
    </div>
    {!library.canCreate && <p className="mb-4 text-sm text-muted-foreground">บันทึกครบตามแผนแล้ว เลือกใช้หรือแก้ไขแบรนด์ที่มีได้</p>}
    <div className="divide-y divide-border border-y border-border">
      {library.profiles.map((profile) => {
        const payload = profile.revisions.find((item) => item.version === profile.activeRevisionNumber)?.payload;
        const pack = library.stylePacks.find((item) => item.id === payload?.visual.stylePackId);
        const format = VISUAL_FORMATS.find((item) => item.id === payload?.visual.primaryVisualFormatId);
        const unavailable = profile.frozen || profile.legacyVisualFormat;
        return <article key={profile.id} className="py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1 basis-52"><h2 className="break-words text-lg font-semibold">{profile.name}</h2><p className="mt-1 text-sm text-muted-foreground">{pack?.thaiLabel ?? format?.label ?? "สไตล์ที่บันทึกไว้"}{unavailable ? " · อ่านอย่างเดียว" : ""}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpen(profile)} className="min-h-11">{unavailable ? "ดูรายละเอียด" : "แก้ไข"}</Button>
              <Button type="button" disabled={busy || unavailable} onClick={() => onUse(profile)} className="min-h-11 bg-violet-600 text-white hover:bg-violet-600/90">สร้างคลิป<ArrowRight className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setArchiveId(archiveId === profile.id ? null : profile.id)} aria-label={`ลบแบรนด์ ${profile.name}`} className="min-h-11 min-w-11 text-muted-foreground"><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
          {archiveId === profile.id && <div role="alert" className="mt-4 rounded-lg border border-border p-4 text-sm"><p>ลบออกจากคลังสำหรับงานใหม่ คลิปเดิมและเวอร์ชันเก่ายังอยู่</p><div className="mt-3 flex gap-2"><Button variant="outline" onClick={() => setArchiveId(null)}>ยกเลิก</Button><Button variant="destructive" disabled={busy} onClick={() => { setArchiveId(null); onArchive(profile); }}>ยืนยันลบ</Button></div></div>}
        </article>;
      })}
    </div>
  </section>;
}
