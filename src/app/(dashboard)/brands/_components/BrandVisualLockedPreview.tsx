"use client";

import Link from "next/link";
import { ArrowRight, Check, Clock3, Layers3, SwatchBook } from "lucide-react";
import { useEffect } from "react";
import { trackEvent } from "@/lib/client-telemetry";

type Props = {
  reason: "feature_off" | "payment_required" | "rollout_wait" | "suspended";
  source: string;
};

export function BrandVisualLockedPreview({ reason, source }: Props) {
  const waitingForRollout = reason === "rollout_wait";
  const canUpgrade = reason === "payment_required";

  useEffect(() => {
    trackEvent("locked_preview_viewed", {
      path: "/brands",
      properties: {
        feature: "brand_visual",
        accessMode: waitingForRollout ? "rollout_wait" : "preview",
        source,
        surface: "brand_library",
      },
    });
  }, [source, waitingForRollout]);

  const title = waitingForRollout
    ? "Brand Visual กำลังทยอยเปิดให้บัญชีนี้"
    : reason === "feature_off"
      ? "Brand Visual กำลังเตรียมเปิดใช้งาน"
      : reason === "suspended"
        ? "บัญชีนี้ถูกระงับการใช้งานชั่วคราว"
        : "ทำให้ทุกคลิปจำลายมือของแบรนด์คุณ";

  const description = waitingForRollout
    ? "คุณมีสิทธิ์สมาชิกแล้วและไม่ต้องซื้อซ้ำ ระบบกำลังเปิดแบบเป็นรอบเพื่อดูคุณภาพและความเสถียร บัญชีนี้จะได้รับสิทธิ์ในรอบถัดไป"
    : reason === "feature_off"
      ? "ระบบยังไม่เปิดรับงานใหม่ในขณะนี้ งานและข้อมูลเดิมของคุณไม่ได้รับผลกระทบ"
      : reason === "suspended"
        ? "ติดต่อทีมดูแลบัญชีเพื่อตรวจสอบสถานะ ก่อนกลับมาใช้ฟีเจอร์สร้างสรรค์"
        : "บันทึกสี อารมณ์ภาพ และวิธีเล่าเรื่องไว้ครั้งเดียว แล้วนำแนวเดียวกันไปใช้ต่อใน Hero AI Image และ Video Editor";

  return (
    <main className="ve-no-padding relative flex min-h-[calc(100vh-4rem)] flex-1 overflow-hidden bg-background">
      <div aria-hidden="true" className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_18%_20%,rgba(124,58,237,.15),transparent_33%),radial-gradient(circle_at_82%_75%,rgba(245,158,11,.1),transparent_30%)]" />
      <div className="relative mx-auto grid w-full max-w-[1120px] items-center gap-10 px-5 py-12 lg:grid-cols-[1.05fr_.95fr] lg:px-8 lg:py-20">
        <section>
          <p className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-500">
            <SwatchBook className="h-4 w-4" /> Brand Visual
          </p>
          <h1 className="max-w-2xl text-4xl font-bold leading-[1.12] tracking-tight text-foreground sm:text-5xl">
            {title}
          </h1>
          <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base">{description}</p>

          <div className="mt-8 flex flex-wrap gap-3">
            {canUpgrade && (
              <Link
                href="/pricing?source=brand_visual_preview"
                onClick={() => trackEvent("pricing_cta_clicked", {
                  path: "/brands",
                  properties: { feature: "brand_visual", accessMode: "preview", source, surface: "brand_library" },
                })}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                ดูแผนรายเดือน / รายปี <ArrowRight className="h-4 w-4" />
              </Link>
            )}
            {waitingForRollout && (
              <div className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-700 dark:text-amber-200">
                <Clock3 className="h-4 w-4" /> ไม่เสียสิทธิ์และไม่ต้องซื้อซ้ำ
              </div>
            )}
            {!canUpgrade && !waitingForRollout && (
              <Link href="/dashboard" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                กลับ Dashboard <ArrowRight className="h-4 w-4" />
              </Link>
            )}
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
                "ใช้แนวภาพเดียวกันกับ Hero AI Image และ Video Editor",
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
