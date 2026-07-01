"use client";

import { AlertTriangle, Info, CheckCircle2, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

/** การ์ดหัวข้อย่อยภายในหน้า — สะอาด ใช้ token */
export function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="premium-card p-5 md:p-6">
      <div className="mb-3 flex items-center gap-2.5">
        {icon && (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "hsl(262 83% 58% / 0.12)", border: "1px solid hsl(262 83% 58% / 0.28)" }}>
            {icon}
          </span>
        )}
        <h2 className="text-[16px] font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>{title}</h2>
      </div>
      <div className="space-y-3 text-[13.5px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>{children}</div>
    </section>
  );
}

export function Step({ num, title, children }: { num: number | string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-violet-200"
        style={{ background: "hsl(262 83% 58% / 0.14)", border: "1px solid hsl(262 83% 58% / 0.30)" }}>{num}</span>
      <div className="flex-1 pt-0.5">
        <h3 className="mb-1 text-[13.5px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{title}</h3>
        <div className="space-y-1.5 text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>{children}</div>
      </div>
    </div>
  );
}

export function PipelineRow({ num, name, desc }: { num: number; name: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-bold text-violet-300"
        style={{ background: "hsl(262 83% 58% / 0.10)", border: "1px solid hsl(262 83% 58% / 0.25)" }}>{String(num).padStart(2, "0")}</span>
      <div className="min-w-0 pt-0.5">
        <p className="text-[13px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{name}</p>
        <p className="mt-0.5 text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
      </div>
    </div>
  );
}

export function ApiRow({ name, required, desc, link, linkLabel }: { name: string; required?: boolean; desc: string; link?: string; linkLabel?: string }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-divider)" }}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <p className="text-[13px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{name}</p>
        <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          required ? "text-violet-200" : "")}
          style={required
            ? { background: "hsl(262 83% 58% / 0.15)", border: "1px solid hsl(262 83% 58% / 0.35)" }
            : { background: "hsl(0 0% 100% / 0.05)", border: "1px solid var(--ui-divider)", color: "var(--ui-text-muted)" }}>
          {required ? "จำเป็น" : "ตัวเลือก"}
        </span>
      </div>
      <p className="text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{desc}</p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-300 hover:text-violet-200">
          → {linkLabel ?? link}
        </a>
      )}
    </div>
  );
}

type CalloutKind = "warn" | "info" | "tip";
const CALLOUT: Record<CalloutKind, { icon: React.ElementType; fg: string; bg: string; bd: string }> = {
  warn: { icon: AlertTriangle, fg: "hsl(35 95% 75%)", bg: "hsl(35 100% 50% / 0.08)", bd: "hsl(35 100% 50% / 0.30)" },
  info: { icon: Info,          fg: "hsl(262 83% 80%)", bg: "hsl(262 83% 58% / 0.08)", bd: "hsl(262 83% 58% / 0.28)" },
  tip:  { icon: Lightbulb,     fg: "hsl(160 70% 72%)", bg: "hsl(160 70% 45% / 0.08)", bd: "hsl(160 70% 45% / 0.28)" },
};
export function Callout({ kind = "info", children }: { kind?: CalloutKind; children: React.ReactNode }) {
  const c = CALLOUT[kind];
  const Icon = c.icon;
  return (
    <div className="flex gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px]" style={{ background: c.bg, border: `1px solid ${c.bd}` }}>
      <Icon className="mt-px h-4 w-4 shrink-0" style={{ color: c.fg }} />
      <div className="leading-relaxed" style={{ color: c.fg }}>{children}</div>
    </div>
  );
}

/** ลิงก์ไปตั้งค่า key ที่ /settings (in-app) */
export function KeyLink({ children = "ไปที่ Settings → API Keys" }: { children?: React.ReactNode }) {
  return (
    <a href="/settings?tab=keys" className="font-semibold text-violet-300 underline-offset-2 hover:underline">{children}</a>
  );
}

export function Tips({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2">{children}</ul>;
}
export function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" strokeWidth={2.5} />
      <span className="text-[13px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>{children}</span>
    </li>
  );
}
