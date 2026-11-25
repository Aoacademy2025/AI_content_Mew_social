"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, Check, Clock, Film, LockKeyhole, NotebookPen, Sparkles, Video } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";

const SAMPLE_HOOKS = [
  {
    formula: "ขัดความเชื่อ",
    hook: "เงินเดือนขึ้นทุกปีแต่เงินเก็บเท่าเดิม ไม่ใช่เพราะคุณใช้เงินเก่ง… แต่เพราะคุณติดกับดักนี้โดยไม่รู้ตัว",
    sceneCount: 8,
    durationLabel: "~0:56 / 1:00",
  },
  {
    formula: "เปิดช่องว่างความอยากรู้",
    hook: "รู้ไหมทำไมคนเงินเดือนเท่ากัน แต่อีกคนมีเงินเก็บ 6 หลักได้ภายในปีเดียว",
    sceneCount: 8,
    durationLabel: "~0:54 / 1:00",
  },
  {
    formula: "ตัวเลขช็อค",
    hook: "แค่เปลี่ยนวิธีแบ่งเงิน 15% วันเงินออก ชีวิตการเงินคุณจะต่างจากเดิมทันทีใน 90 วัน",
    sceneCount: 8,
    durationLabel: "~0:58 / 1:00",
  },
] as const;

export function HeroScriptLockedPreview({ entitlementSource, isTrial }: { entitlementSource: string; isTrial: boolean }) {
  const [sampleIndex, setSampleIndex] = useState(0);

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

  const activeSample = SAMPLE_HOOKS[sampleIndex] ?? SAMPLE_HOOKS[0];

  return (
    <div className="relative flex-1 overflow-y-auto px-4 py-8 md:px-8 md:py-12">
      <div
        className="mx-auto max-w-5xl overflow-hidden rounded-3xl border p-6 shadow-2xl md:p-10"
        style={{
          borderColor: HS_COLOR.violetBorder,
          background: "radial-gradient(circle at top right, rgba(139,92,246,.18), transparent 45%), var(--ui-card-bg)",
        }}
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)] lg:items-center">
          <div className="min-w-0">
            <div
              className="mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: HS_COLOR.violetBorder, background: HS_COLOR.violetSoft, color: HS_COLOR.violet }}
            >
              <Sparkles className="h-3.5 w-3.5" /> ฟีเจอร์พรีเมียมสำหรับสมาชิก
            </div>
            <h1
              className="max-w-xl text-3xl font-bold leading-tight tracking-tight md:text-5xl"
              style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
            >
              เปลี่ยนไอเดียให้เป็นสคริปต์ที่พร้อมถ่ายและพร้อมตัดต่อ
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 md:text-base" style={{ color: "var(--ui-text-secondary)" }}>
              Hero Script ช่วยคิดหัวข้อ เลือก Hook 5 สูตร เขียนสคริปต์ภาษาไทยพร้อมคุมเวลาพูดจริง และส่งเข้า Video Editor แบ่งซีนให้ในคลิกเดียว
            </p>

            <ul className="mt-5 space-y-2 text-xs sm:text-sm" style={{ color: "var(--ui-text-secondary)" }}>
              {[
                "สร้างสคริปต์ + 5 สูตร Hook ไวรัลจบในคลิกเดียว",
                "คุมความยาวพูดจริง (30 / 60 / 90 วิ) พร้อมปุ่มกระชับอัตโนมัติ",
                "ส่งเข้า Video Editor แบ่งซีน B-roll และซับไทยทันที",
              ].map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <Check className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.cta }} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/pricing?source=hero_script_preview"
                onClick={trackUpgrade}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition hover:brightness-110"
                style={{ background: HS_COLOR.violetGradient, boxShadow: HS_COLOR.violetShadow, fontFamily: HS_FONT.heading }}
              >
                ดูแผนรายเดือน / รายปี
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/docs/hero-script"
                onClick={() => trackEvent("hero_script_guide_docs_clicked", { properties: { surface: "preview" } })}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border px-5 text-sm font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-secondary)" }}
              >
                <BookOpen className="h-4 w-4" /> อ่านวิธีใช้งาน
              </Link>
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--ui-text-muted)" }}>
              <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
              {isTrial
                ? "ฟีเจอร์พรีเมียมนี้ไม่รวมในช่วงทดลอง — อัปเกรดเพื่อปลดล็อกทันที"
                : "สมัคร PRO/BUSINESS เพื่อเขียนและส่งสคริปต์เข้า Editor"}
            </p>
          </div>

          {/* Interactive Read-Only Sample Preview */}
          <div
            className="min-w-0 rounded-2xl border p-4 sm:p-5"
            style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg-2)" }}
          >
            <div className="mb-3.5 flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: HS_COLOR.violetSoft, color: HS_COLOR.violet }}
                >
                  <NotebookPen className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug" style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}>
                    ตัวอย่างผลลัพธ์จริง (กดสลับ Hook ได้)
                  </p>
                  <p className="text-[11px] leading-snug" style={{ color: "var(--ui-text-muted)" }}>
                    หัวข้อ: ทำไมเงินเดือนขึ้นแต่เงินเก็บไม่เหลือ
                  </p>
                </div>
              </div>
              <span
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: HS_COLOR.ctaBg, color: HS_COLOR.cta }}
              >
                <Clock className="h-3 w-3 shrink-0" /> {activeSample.durationLabel}
              </span>
            </div>

            {/* Sample Hook Switcher Pills */}
            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="ลองสลับสูตร Hook ตัวอย่าง">
              {SAMPLE_HOOKS.map((sample, idx) => {
                const active = idx === sampleIndex;
                return (
                  <button
                    key={sample.formula}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSampleIndex(idx)}
                    className="min-h-8 rounded-full border px-2.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60"
                    style={{
                      borderColor: active ? HS_COLOR.hookBorder : "var(--ui-card-border)",
                      background: active ? HS_COLOR.hookBg : "transparent",
                      color: active ? HS_COLOR.hook : "var(--ui-text-secondary)",
                    }}
                  >
                    {sample.formula}
                  </button>
                );
              })}
            </div>

            {/* Structured Script Blocks */}
            <div className="space-y-2.5 text-xs">
              <div className="rounded-xl border p-3" style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}>
                <span className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: HS_COLOR.hookBg, color: HS_COLOR.hook }}>
                  HOOK · 0:00–0:04
                </span>
                <p className="leading-relaxed" style={{ color: "var(--ui-text-primary)" }}>{activeSample.hook}</p>
              </div>

              <div className="rounded-xl border p-3" style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}>
                <span className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: HS_COLOR.bodyBg, color: HS_COLOR.body }}>
                  เนื้อหา · แบ่ง {activeSample.sceneCount} ซีน B-roll
                </span>
                <p className="leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
                  1. ทุกครั้งที่เงินเดือนขึ้น ค่าใช้จ่ายพื้นฐานเราจะขยับตามโดยไม่รู้ตัว<br />
                  2. วิธีแก้ง่ายที่สุดคือหักออม 15% ทันทีวันที่เงินออกก่อนเห็นยอด…
                </p>
              </div>

              <div className="rounded-xl border p-3" style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}>
                <span className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: HS_COLOR.ctaBg, color: HS_COLOR.cta }}>
                  CTA · ปิดท้าย
                </span>
                <p className="leading-relaxed" style={{ color: "var(--ui-text-primary)" }}>
                  คุณเคยเจอภาวะนี้ไหม? พิมพ์ “เคย” ไว้ใต้คลิป เดี๋ยวแจกสูตรแบ่ง 3 บัญชีให้
                </p>
              </div>
            </div>

            <div
              className="mt-3.5 flex items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-xs"
              style={{ background: HS_COLOR.violetSoft, color: "var(--ui-text-primary)" }}
            >
              <span className="flex items-center gap-2 font-medium">
                <Video className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} />
                พร้อมส่งเข้า Video Editor ตัดต่อในคลิกเดียว
              </span>
              <Film className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
