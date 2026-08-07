"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";

const steps = [
  { title: "ตั้งค่า", detail: "เลือกแบรนด์และความยาว" },
  { title: "หัวข้อ", detail: "พิมพ์เองหรือเลือกไอเดีย" },
  { title: "Hook", detail: "เลือกประโยคเปิดที่หยุดคนดู" },
  { title: "สคริปต์", detail: "ตรวจและแก้ทีละส่วน" },
  { title: "ตัดต่อ", detail: "ส่งเข้า Video Editor" },
] as const;

export function HeroScriptQuickStart() {
  const [open, setOpen] = useState(true);
  const mountedRef = useRef(false);

  useEffect(() => {
    trackEvent("hero_script_guide_viewed");
    mountedRef.current = true;
  }, []);

  return (
    <details
      className="group border-y"
      style={{ borderColor: "var(--ui-divider)" }}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (mountedRef.current && nextOpen) trackEvent("hero_script_guide_opened");
      }}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <span className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>เริ่มครั้งแรก? เดินตาม 5 ขั้นตอนนี้</span>
          <span className="ml-2 hidden text-xs sm:inline" style={{ color: "var(--ui-text-muted)" }}>ระบบบันทึกร่างให้อัตโนมัติ</span>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-180" style={{ color: "var(--ui-text-muted)" }} />
      </summary>

      <div className="pb-5 pt-2">
        <ol className="relative grid gap-0 md:grid-cols-5">
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex gap-3 pb-4 last:pb-0 md:block md:pb-0 md:pr-4">
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-[13px] top-7 w-px md:left-7 md:right-0 md:top-[13px] md:h-px md:w-auto"
                  style={{ background: "var(--ui-divider)" }}
                />
              )}
              <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-violet-50">
                {index + 1}
              </span>
              <div className="min-w-0 md:mt-3">
                <p className="text-xs font-semibold" style={{ color: "var(--ui-text-primary)" }}>{step.title}</p>
                <p className="mt-1 text-xs leading-5" style={{ color: "var(--ui-text-muted)" }}>{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        <Link
          href="/docs/hero-script"
          onClick={() => trackEvent("hero_script_guide_docs_clicked")}
          className="mt-5 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-violet-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
        >
          <BookOpen className="h-4 w-4" /> อ่านวิธีใช้และแนวทางเขียนให้ได้ผลดี
        </Link>
      </div>
    </details>
  );
}
