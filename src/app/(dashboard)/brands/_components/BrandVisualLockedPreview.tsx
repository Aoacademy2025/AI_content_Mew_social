"use client";

import Link from "next/link";
import { ArrowRight, Check, Layers3, SwatchBook } from "lucide-react";
import { useEffect } from "react";
import { trackEvent } from "@/lib/client-telemetry";

/** ADR 0059: this page appears only when the master switch is off or the account
 * is suspended. An unpaid or not-yet-rolled-out account sees the full library and
 * meets the gate on the image buttons instead. */
type Props = {
  reason: "feature_off" | "suspended";
};

export function BrandVisualLockedPreview({ reason }: Props) {
  useEffect(() => {
    trackEvent("locked_preview_viewed", {
      path: "/brands",
      properties: {
        feature: "brand_visual",
        accessMode: "preview",
        reason,
        surface: "brand_library",
      },
    });
  }, [reason]);

  const title = reason === "suspended"
    ? "บัญชีนี้ถูกระงับการใช้งานชั่วคราว"
    : "ระบบแบรนด์กำลังเตรียมเปิดใช้งาน";

  const description = reason === "suspended"
    ? "ติดต่อทีมดูแลบัญชีเพื่อตรวจสอบสถานะ ก่อนกลับมาใช้ฟีเจอร์สร้างสรรค์"
    : "ระบบยังไม่เปิดรับงานใหม่ในขณะนี้ งานและข้อมูลเดิมของคุณไม่ได้รับผลกระทบ";

  return (
    <main className="ve-no-padding relative flex min-h-[calc(100vh-4rem)] flex-1 overflow-hidden bg-background">
      <div aria-hidden="true" className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_18%_20%,rgba(124,58,237,.15),transparent_33%),radial-gradient(circle_at_82%_75%,rgba(245,158,11,.1),transparent_30%)]" />
      <div className="relative mx-auto grid w-full max-w-[1120px] items-center gap-10 px-5 py-12 lg:grid-cols-[1.05fr_.95fr] lg:px-8 lg:py-20">
        <section>
          <p className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-500">
            <SwatchBook className="h-4 w-4" /> แบรนด์ของฉัน
          </p>
          <h1 className="max-w-2xl text-4xl font-bold leading-[1.12] tracking-tight text-foreground sm:text-5xl">
            {title}
          </h1>
          <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base">{description}</p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/dashboard" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
              กลับ Dashboard <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        <aside className="relative overflow-hidden rounded-[28px] border border-border bg-card/90 p-6 shadow-xl sm:p-8">
          <div aria-hidden="true" className="absolute -right-12 -top-12 h-40 w-40 rotate-12 rounded-[36px] bg-violet-500/10" />
          <div className="relative">
            <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/12 text-violet-500">
              <Layers3 className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-bold text-foreground">สิ่งที่จะปลดล็อก</h2>
            <ul className="mt-5 space-y-4">
              {[
                "สร้างและเก็บโปรไฟล์ภาพของแต่ละแบรนด์",
                "คุมอารมณ์ภาพ สี และองค์ประกอบให้ต่อเนื่อง",
                "ใช้แนวภาพเดียวกันกับภาพ AI ประจำแบรนด์และตัวตัดต่อวิดีโอ",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-muted-foreground">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-300"><Check className="h-3.5 w-3.5" /></span>
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-7 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">
              การเข้าหน้านี้ไม่ใช้เครดิต ระบบคิดเครดิตเฉพาะเมื่อยืนยันสร้างภาพจริง และคืนเครดิตให้อัตโนมัติเมื่องานสร้างไม่สำเร็จ
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
