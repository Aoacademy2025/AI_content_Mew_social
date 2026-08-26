"use client";

import { CheckCircle2, Circle, KeyRound, ArrowRight } from "lucide-react";
import type { KeyStatus } from "@/lib/key-tiers";

function Row({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" /> : <Circle className="h-4 w-4 text-slate-500 shrink-0" />}
      <span className={done ? "text-slate-400 line-through" : "text-slate-200"}>{label}</span>
    </div>
  );
}

export function KeySetupChecklist({
  status,
  onSetup,
  managed = false,
  managedStock = false,
}: { status: KeyStatus; onSetup: () => void; managed?: boolean; managedStock?: boolean }) {
  if (status.tier1Complete) return null;
  const stockDone = status.pexels || status.pixabay;
  // When managed, Gemini is handled server-side — only count/show the stock key requirement.
  // With MANAGED_STOCK on (#297) the stock key stops being a requirement too: the system
  // searches its own Pexels/Pixabay for trial/FREE accounts, so this card must not present
  // a blocker that no longer exists.
  const stockRequired = !managedStock;
  const totalRequired = (managed ? 0 : 1) + (stockRequired ? 1 : 0);
  const doneCount = ((!managed && status.gemini) ? 1 : 0) + ((stockRequired && stockDone) ? 1 : 0);
  if (totalRequired === 0 || doneCount >= totalRequired) return null;

  return (
    <div className="rounded-xl border border-violet-400/25 bg-gradient-to-r from-violet-500/10 to-transparent p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-violet-300" />
          <span className="text-sm font-semibold text-white">ตั้งค่าให้พร้อมสร้างวิดีโอ ({doneCount}/{totalRequired})</span>
        </div>
        <button type="button" onClick={onSetup}
          className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/15">
          ตั้งค่า <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        {!managed && <Row done={status.gemini} label="Gemini key (จำเป็น)" />}
        <Row done={stockDone} label={stockRequired ? "Pexels หรือ Pixabay — B-roll (จำเป็น)" : "Pexels หรือ Pixabay — B-roll (ไม่บังคับ)"} />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">ขั้นสูง (ไม่บังคับ): ElevenLabs · HeyGen — ไม่ใส่ก็ใช้งานได้</p>
    </div>
  );
}
