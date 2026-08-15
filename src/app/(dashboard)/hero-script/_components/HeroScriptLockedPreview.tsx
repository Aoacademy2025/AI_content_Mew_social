"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ArrowRight, BookOpen, Check, LockKeyhole, NotebookPen, Sparkles, Video } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";

export function HeroScriptLockedPreview({ entitlementSource, isTrial }: { entitlementSource: string; isTrial: boolean }) {
  useEffect(() => {
    trackEvent("hero_script_preview_viewed", {
      path: "/hero-script",
      properties: { feature: "hero_script", accessMode: "preview", source: entitlementSource, surface: "locked_preview" },
    });
  }, [entitlementSource]);

  function trackUpgrade() {
    trackEvent("hero_script_upgrade_clicked", {
      path: "/hero-script",
      step: "locked_preview",
      properties: { feature: "hero_script", accessMode: "preview", source: entitlementSource, surface: "locked_preview" },
    });
  }

  return (
    <div className="relative flex-1 overflow-y-auto px-4 py-8 md:px-8 md:py-12">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border border-violet-400/20 bg-[radial-gradient(circle_at_top_right,rgba(139,92,246,.22),transparent_42%),var(--ui-card-bg)] p-6 shadow-2xl shadow-violet-950/10 md:p-10">
        <div className="grid gap-9 lg:grid-cols-[1.08fr_.92fr] lg:items-center">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-300">
              <Sparkles className="h-3.5 w-3.5" /> ฟีเจอร์พรีเมียมสำหรับสมาชิก
            </div>
            <h1 className="max-w-xl text-3xl font-bold leading-tight tracking-tight text-[var(--ui-text-primary)] md:text-5xl">
              เปลี่ยนไอเดียให้เป็นสคริปต์ที่พร้อมถ่ายและพร้อมตัดต่อ
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-[var(--ui-text-secondary)] md:text-base">
              Hero Script ช่วยคิดหัวข้อ เลือก Hook เขียนสคริปต์ภาษาไทย และส่งเข้า Video Editor ได้ในคลิกเดียว
            </p>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/pricing?source=hero_script_preview"
                onClick={trackUpgrade}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white transition hover:bg-violet-500"
              >
                ดูแผนรายเดือน / รายปี
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/docs/hero-script"
                onClick={() => trackEvent("hero_script_guide_docs_clicked", { properties: { surface: "preview" } })}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[var(--ui-card-border)] px-5 text-sm font-semibold text-[var(--ui-text-secondary)] transition-colors hover:bg-white/5"
              >
                <BookOpen className="h-4 w-4" /> อ่านวิธีใช้งาน
              </Link>
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-[var(--ui-text-muted)]">
              <LockKeyhole className="h-3.5 w-3.5" />
              {isTrial
                ? "ฟีเจอร์พรีเมียมนี้ไม่รวมในช่วงทดลอง — อัปเกรดเพื่อปลดล็อกทันที"
                : "สมัคร PRO/BUSINESS เพื่อเขียนและส่งสคริปต์เข้า Editor"}
            </p>
          </div>

          <div className="rounded-2xl border border-violet-400/15 bg-black/15 p-5 backdrop-blur-sm md:p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
                <NotebookPen className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--ui-text-primary)]">Hero Script</p>
                <p className="text-xs text-[var(--ui-text-muted)]">จากหัวข้อถึงวิดีโอใน flow เดียว</p>
              </div>
            </div>
            <div className="space-y-3">
              {[
                "สร้าง 8 ไอเดียตามนิชและกลุ่มเป้าหมาย",
                "เลือก Hook จากสูตรไวรัล 10 รูปแบบ",
                "แก้ Hook เนื้อหา และ CTA แยกส่วนได้",
                "ส่งสคริปต์เข้า Video Editor พร้อมใช้งาน",
              ].map((item) => (
                <div key={item} className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[.025] px-3.5 py-3 text-sm text-[var(--ui-text-secondary)]">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" /> {item}
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center gap-2 rounded-xl bg-violet-500/10 px-4 py-3 text-xs text-violet-200">
              <Video className="h-4 w-4" /> เป้าหมายคือให้คุณไปถึงคลิปแรกได้เร็วขึ้น
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
