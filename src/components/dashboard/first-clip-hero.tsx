"use client";

/**
 * First-Clip day-one dashboard hero (#305) + one number before the first clip (#304).
 *
 * Everything a brand-new creator sees above the fold: a 3-step stepper whose
 * current step comes from real render/export state, ONE primary CTA, and ONE
 * number (render minutes left). Rendered only while
 * `shouldShowFirstClipHero()` is true — every other account keeps today's
 * dashboard untouched.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, Check, ClipboardCopy, Loader2, NotebookPen, Settings2, Sparkles } from "lucide-react";
import { trackEvent } from "@/lib/client-telemetry";
import { QuotaStatus } from "@/components/quota-status";
import {
  approxShortClips,
  firstClipStepIndex,
  type FirstClipState,
} from "@/lib/first-clip-dashboard";

const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;

const STEP_TITLES = ["วางสคริปต์", "เรนเดอร์ ~3 นาที", "ส่งออก"] as const;
const STEP_HINTS = ["", "ปิดหน้าได้", "ได้ไฟล์ลง TikTok/Reels"] as const;

/** Ready-to-paste starter script — 1 บรรทัด = 1 เซ็กเมนต์ (กติกาเดียวกับ Step 1 ของตัวตัดต่อ) */
const SAMPLE_SCRIPT = [
  "3 นิสัยที่ทำให้คลิปแรกของคุณไม่มีคนดู",
  "ข้อแรก เปิดคลิปช้าเกินไป คนเลื่อนผ่านตั้งแต่ 2 วินาทีแรก",
  "ข้อสอง พูดยาวรวดเดียวไม่มีจังหวะหยุด คนฟังตามไม่ทัน",
  "ข้อสาม ไม่มีซับ คนดูส่วนใหญ่เปิดคลิปแบบปิดเสียง",
  "แก้สามข้อนี้ คลิปต่อไปของคุณไปได้ไกลกว่าเดิมแน่นอน",
  "กดติดตามไว้ พรุ่งนี้มาต่อเรื่องการเขียนฮุกให้คนหยุดดู",
].join("\n");

const STEP_EVENT_PREFIX = "hero-first-clip-step:";

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.sessionStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

/** Fire `first_clip_path_step` once per state per browser session. */
function useStepTelemetry(state: FirstClipState) {
  const lastRef = useRef<FirstClipState | null>(null);
  useEffect(() => {
    if (lastRef.current === state) return;
    lastRef.current = state;
    const key = `${STEP_EVENT_PREFIX}${state}`;
    const storage = sessionStore();
    try {
      if (storage?.getItem(key)) return;
      storage?.setItem(key, "1");
    } catch {
      // sessionStorage unavailable (private mode) — still emit, at most once per mount.
    }
    trackEvent("first_clip_path_step", {
      step: state,
      properties: { step: state, stepIndex: firstClipStepIndex(state) },
    });
  }, [state]);
}

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex flex-col gap-2.5 sm:flex-row sm:items-stretch sm:gap-3">
      {STEP_TITLES.map((title, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li
            key={title}
            className="flex flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5"
            style={{
              background: active ? VIOLET_TILE_BG : "transparent",
              border: `1px solid ${active ? VIOLET_TILE_BORDER : "var(--ui-divider)"}`,
            }}
            aria-current={active ? "step" : undefined}
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
              style={done
                ? { background: "rgba(52,211,153,.15)", color: "#34D399", border: "1px solid rgba(52,211,153,.35)" }
                : active
                  ? { background: VIOLET_GRAD, color: "#fff" }
                  : { background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-muted)", border: "1px solid var(--ui-badge-neutral-border)" }}
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : step}
            </span>
            <span className="min-w-0">
              <span
                className="block text-[12.5px] font-semibold leading-tight"
                style={{ color: active ? "var(--ui-text-primary)" : "var(--ui-text-secondary)" }}
              >
                {title}
              </span>
              {STEP_HINTS[index] && (
                <span className="block text-[11px] leading-tight" style={{ color: "var(--ui-text-muted)" }}>
                  {STEP_HINTS[index]}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ctaLabel(state: FirstClipState): string {
  if (state === "rendering") return "ดูความคืบหน้า →";
  if (state === "rendered_not_exported") return "ส่งออกคลิปแรก →";
  return "สร้างคลิปแรกเลย →";
}

function SampleScriptCard() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(SAMPLE_SCRIPT);
      setCopied(true);
      toast.success("คัดลอกสคริปต์ตัวอย่างแล้ว — วางในช่องสคริปต์ได้เลย");
    } catch {
      toast.error("คัดลอกไม่สำเร็จ — เลือกข้อความแล้วกดคัดลอกเองได้");
    }
  }

  return (
    <div className="ve-card rounded-xl p-4">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 text-left"
        style={{ minHeight: 44 }}
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}
        >
          <ClipboardCopy className="h-[18px] w-[18px]" style={{ color: VIOLET }} strokeWidth={2.1} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>
            ยังไม่มีสคริปต์? ใช้ตัวอย่าง
          </span>
          <span className="mt-0.5 block text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
            สคริปต์สั้นพร้อมใช้ ~30 วินาที คัดลอกแล้ววางได้เลย
          </span>
        </span>
        <ArrowRight
          className="mt-0.5 h-4 w-4 shrink-0 transition-transform"
          style={{ color: "var(--ui-text-muted)", transform: open ? "rotate(90deg)" : undefined }}
        />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 text-[12px] leading-relaxed"
            style={{
              background: "var(--ui-card-bg-2)",
              border: "1px solid var(--ui-divider)",
              color: "var(--ui-text-secondary)",
              fontFamily: "inherit",
            }}
          >
            {SAMPLE_SCRIPT}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyScript}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors"
              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              {copied ? "คัดลอกแล้ว" : "คัดลอกสคริปต์"}
            </button>
            <Link
              href="/video-editor"
              prefetch={true}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold transition-colors"
              style={{ color: VIOLET_LIGHT }}
            >
              เปิดตัวตัดต่อ <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function FirstClipHero({
  state,
  minutesLimit,
  minutesUsed,
  heroScriptAllowed,
}: {
  state: FirstClipState;
  /** null when the minute quota flag is off — the compact chip takes over. */
  minutesLimit: number | null;
  minutesUsed: number | null;
  heroScriptAllowed: boolean;
}) {
  useStepTelemetry(state);

  const current = firstClipStepIndex(state);
  const minutesLeft = minutesLimit != null
    ? Math.max(0, minutesLimit - (minutesUsed ?? 0))
    : null;
  const clips = minutesLeft != null ? approxShortClips(minutesLeft) : 0;

  return (
    <>
      {/* Hero card — stepper + ONE CTA + ONE number */}
      <div className="ve-rise ve-card mb-4 rounded-2xl p-5 sm:p-6" style={{ animationDelay: "100ms" }}>
        <p className="mb-3 flex items-center gap-2 text-[12px] font-semibold" style={{ ...HEAD, color: VIOLET_LIGHT }}>
          {state === "rendering"
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Sparkles className="h-3.5 w-3.5" />}
          เส้นทางคลิปแรก
        </p>

        <Stepper current={current} />

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
          <Link
            href="/video-editor"
            prefetch={true}
            onClick={() => trackEvent("first_clip_cta_clicked", {
              step: state,
              properties: { step: state, stepIndex: current },
            })}
            className="inline-flex items-center justify-center rounded-xl px-5 py-3 text-[14px] font-bold text-white transition-all hover:brightness-110"
            style={{ background: VIOLET_GRAD, minHeight: 44 }}
          >
            {ctaLabel(state)}
          </Link>

          {/* ONE number */}
          {minutesLeft != null ? (
            <p className="text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>
              เหลือ{" "}
              <strong className="font-semibold" style={{ color: "var(--ui-text-primary)" }}>
                {minutesLeft} นาที
              </strong>
              ให้ลอง ≈ {clips} คลิปสั้น · ไม่ต้องใส่บัตร
            </p>
          ) : (
            // Minute quota flag off → no minutes in /api/user/me. Fall back to the
            // compact chip so the screen still shows exactly one number.
            <QuotaStatus variant="chip" compact />
          )}
        </div>
      </div>

      {/* Two ways to get a script */}
      <div className="ve-rise mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2" style={{ animationDelay: "140ms" }}>
        <SampleScriptCard />
        <Link
          href="/hero-script"
          prefetch={true}
          className="ve-card ve-card-hover group flex items-start gap-3 rounded-xl p-4"
          style={{ minHeight: 44 }}
        >
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px]"
            style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}
          >
            <NotebookPen className="h-[18px] w-[18px]" style={{ color: VIOLET }} strokeWidth={2.1} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>
                ให้ AI เขียนสคริปต์จากหัวข้อ
              </span>
              {!heroScriptAllowed && (
                <span className="flex h-4 items-center rounded-full bg-violet-500 px-1.5 text-[9px] font-bold leading-none text-white">
                  PRO
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
              บอกหัวข้อ Hero Script ร่างฮุก เนื้อหา และ CTA ให้
            </span>
          </span>
          <ArrowRight
            className="mt-0.5 h-4 w-4 shrink-0 transition-all group-hover:translate-x-0.5"
            style={{ color: "var(--ui-text-muted)" }}
          />
        </Link>
      </div>

      {/* Everything else can wait */}
      <Link
        href="/settings"
        prefetch={true}
        className="ve-rise mb-8 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-4 py-3 text-[11.5px] transition-colors hover:bg-[rgba(139,92,246,.06)]"
        style={{
          animationDelay: "180ms",
          border: "1px dashed var(--ui-divider)",
          color: "var(--ui-text-muted)",
          minHeight: 44,
        }}
      >
        <Settings2 className="h-3.5 w-3.5 shrink-0" />
        <span>ต่อยอดได้ทีหลัง: พิธีกร AI · เสียงโคลน · อัปโหลดคลิปตัวเอง · คลัง Pexels ส่วนตัว</span>
        <span className="inline-flex items-center gap-1 font-semibold" style={{ color: VIOLET_LIGHT }}>
          ตั้งค่าใน Settings <ArrowRight className="h-3 w-3" />
        </span>
      </Link>
    </>
  );
}
