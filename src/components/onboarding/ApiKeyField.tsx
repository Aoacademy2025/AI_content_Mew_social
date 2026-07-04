"use client";

import { Input } from "@/components/ui/input";
import { CheckCircle2, XCircle, Loader2, Eye, EyeOff, FlaskConical, Trash2, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { KeyDef } from "@/lib/key-tiers";

export function ApiKeyField({
  def, value, isSaved, onChange, onTest, testResult, testing, onDelete,
}: {
  def: KeyDef;
  value: string;
  isSaved: boolean;
  onChange: (value: string) => void;
  onTest: () => Promise<void> | void;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
  onDelete?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <label htmlFor={def.id} className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>{def.label}</label>
          <a href={def.getUrl} target="_blank" rel="noopener noreferrer"
            className="transition-colors hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }}>
            <ExternalLink className="h-3 w-3" />
          </a>
          {def.free && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 bg-emerald-500/10">ฟรี</span>}
        </div>
        {isSaved && !testResult
          ? <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-400" style={{ background: "hsl(142 72% 29% / 0.15)", border: "1px solid hsl(142 72% 29% / 0.3)" }}>ตั้งแล้ว</span>
          : !isSaved && !testResult
          ? <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-slate-400 bg-white/5">ยังไม่ตั้ง</span>
          : null}
        {testResult?.ok && <span className="flex items-start gap-1 text-xs text-green-400"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="leading-snug">{testResult.message}</span></span>}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>{def.desc}</p>
      {def.skipNote && <p className="text-[11px] leading-relaxed text-amber-300/80">↪ {def.skipNote}</p>}
      {testResult && !testResult.ok && (
        <div className="flex items-start gap-1.5 text-xs text-red-400 px-2 py-1.5 rounded-lg bg-red-500/5 border border-red-500/20">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="leading-snug">{testResult.message}</span>
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={def.id}
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`วาง ${def.label}...`}
            className="border-0 pr-16 font-mono text-xs focus-visible:ring-1 focus-visible:ring-violet-500/50"
            style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-secondary)" }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "ซ่อน key" : "แสดง key"} className="transition-colors hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }}>
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            {isSaved && onDelete && (
              <button type="button" onClick={onDelete} aria-label="ลบ key" className="transition-colors hover:text-red-400" style={{ color: "var(--ui-text-muted)" }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <button type="button" disabled={!value || testing} onClick={() => onTest()}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all hover:opacity-80 disabled:opacity-30"
          style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)", color: "var(--ui-text-secondary)" }}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          ทดสอบ
        </button>
      </div>
    </div>
  );
}
