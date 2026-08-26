"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, X } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import { fetchMe, type MeData } from "@/lib/use-me";
import {
  canRevealFirstClipConvertPrompt,
  firstClipConvertTrialLine,
  trialDaysLeftFrom,
  FIRST_CLIP_CONVERT_REVEAL_DELAY_MS,
  type FirstClipConvertDecision,
} from "@/lib/first-clip-convert";
import {
  FIRST_CLIP_COMPLETED_EVENT,
  FIRST_CLIP_EXPORTED_VIEW_EVENT,
  FIRST_CLIP_RENDER_ACTIVE_EVENT,
  FIRST_CLIP_VIEWED_EVENT,
  readRenderActiveDetail,
} from "@/lib/first-clip-convert-events";

const SURFACE = "first_clip_convert";

/**
 * "The customer has seen the exported clip" survives a navigation.
 * ดูใน Gallery is a plain anchor (a full document load), so without this the
 * ask would be lost exactly on the path the design asks us to use.
 */
const ARMED_KEY = "hero-first-clip-convert-armed";

function sessionStore() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type ShownDecision = Extract<FirstClipConvertDecision, { show: true }>;

function thb(amount: number): string {
  return `฿${amount.toLocaleString("th-TH")}`;
}

/** Render minutes left this window, or null when the minute meter is off. */
function minutesLeftFrom(me: MeData | null): number | null {
  if (!me || me.minuteQuota !== true) return null;
  const limit = typeof me.minutesLimit === "number" ? me.minutesLimit : null;
  const used = typeof me.minutesUsed === "number" ? me.minutesUsed : null;
  if (limit == null || used == null) return null;
  return Math.max(0, Math.floor(limit - used));
}

/**
 * The single convert ask after a customer's first exported clip (issue #303).
 *
 * Mounted exactly once, by DashboardLayout. It never opens on burn-complete:
 * the exported clip has to be on screen first (or downloaded / opened in the
 * Gallery), it never interrupts a render in flight, and "ไว้ทีหลัง" is stored
 * server-side with a 30-day cooldown instead of a sessionStorage flag.
 */
export function FirstClipConvertPrompt() {
  const pathname = usePathname();
  const [decision, setDecision] = useState<ShownDecision | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [exportedViewShown, setExportedViewShown] = useState(false);
  const [renderActive, setRenderActive] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<"monthly" | "annual" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownTrackedRef = useRef(false);

  const load = useCallback(async () => {
    const [res, meData] = await Promise.all([
      authenticatedFetch("/api/convert/first-clip"),
      fetchMe().catch(() => null),
    ]);
    setMe(meData);
    if (!res.ok) return;
    const data = await res.json() as FirstClipConvertDecision;
    setDecision(data.show ? data : null);
  }, []);

  useEffect(() => {
    // The completed event stays the source: it tells us a clip finished, so the
    // qualifying decision is fetched now and is ready by the time the customer
    // has actually seen the export.
    const onCompleted = () => { void load(); };
    const openGate = () => {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      try { sessionStore()?.setItem(ARMED_KEY, "1"); } catch { /* private mode */ }
      setExportedViewShown(true);
      void load();
    };
    const onExportedView = () => {
      if (revealTimerRef.current) return;
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        openGate();
      }, FIRST_CLIP_CONVERT_REVEAL_DELAY_MS);
    };
    const onRenderActive = (event: Event) => { setRenderActive(readRenderActiveDetail(event)); };

    let armed = false;
    try { armed = sessionStore()?.getItem(ARMED_KEY) === "1"; } catch { /* private mode */ }
    if (armed) {
      setExportedViewShown(true);
      void load();
    }

    window.addEventListener(FIRST_CLIP_COMPLETED_EVENT, onCompleted);
    window.addEventListener(FIRST_CLIP_EXPORTED_VIEW_EVENT, onExportedView);
    window.addEventListener(FIRST_CLIP_VIEWED_EVENT, openGate);
    window.addEventListener(FIRST_CLIP_RENDER_ACTIVE_EVENT, onRenderActive);
    return () => {
      window.removeEventListener(FIRST_CLIP_COMPLETED_EVENT, onCompleted);
      window.removeEventListener(FIRST_CLIP_EXPORTED_VIEW_EVENT, onExportedView);
      window.removeEventListener(FIRST_CLIP_VIEWED_EVENT, openGate);
      window.removeEventListener(FIRST_CLIP_RENDER_ACTIVE_EVENT, onRenderActive);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    };
  }, [load]);

  const visible = canRevealFirstClipConvertPrompt({
    decisionShown: decision != null,
    exportedViewShown,
    renderActive,
    dismissed,
    pathname,
  });

  const trialDaysLeft = trialDaysLeftFrom(me?.trialEndsAt ?? null, new Date());
  const plan = (me?.effectivePlan ?? me?.plan ?? "FREE") as string;

  useEffect(() => {
    if (!visible || shownTrackedRef.current) return;
    shownTrackedRef.current = true;
    trackEvent("paywall_shown", {
      step: SURFACE,
      properties: { surface: SURFACE, daysLeft: trialDaysLeft, plan },
    });
  }, [visible, trialDaysLeft, plan]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { sessionStore()?.removeItem(ARMED_KEY); } catch { /* private mode */ }
    trackEvent("paywall_dismissed", {
      step: SURFACE,
      properties: { surface: SURFACE, daysLeft: trialDaysLeft, plan },
    });
    void authenticatedFetch("/api/convert/first-clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    }).catch(() => {
      // The local state already hid it; the cooldown simply retries next time.
    });
  }, [trialDaysLeft, plan]);

  async function checkout(period: "monthly" | "annual") {
    setBusy(period);
    setError(null);
    trackEvent("pricing_cta_clicked", {
      step: "first_clip_convert",
      properties: {
        period,
        founding: Boolean(decision?.founding),
        surface: "first_clip_convert_prompt",
      },
    });
    try {
      const body: { plan: "PRO"; period: "monthly" | "annual"; couponCode?: string } = {
        plan: "PRO",
        period,
      };
      if (period === "annual" && decision?.founding) body.couponCode = "FOUNDING100";
      const res = await authenticatedFetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error || "ไม่สามารถเปิดหน้าชำระเงินได้");
        setBusy(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("ไม่สามารถเปิดหน้าชำระเงินได้");
      setBusy(null);
    }
  }

  if (!visible || !decision) return null;

  const { benefits } = decision;
  const checks = [
    `เก็บคลิปไว้ดาวน์โหลดได้ ${benefits.storageDays} วัน`,
    `${benefits.minutesPerMonth} นาที + ภาพ AI ${benefits.monthlyCredits} เครดิต ทุกเดือน`,
    "พิธีกร AI + เสียงโคลนของคุณ",
  ];
  const secondaryLabel = decision.founding
    ? `รายปี Founding ${thb(decision.founding.annualMonthlyThb)}/เดือน ชำระปีละครั้ง · เหลือ ${decision.founding.remaining}/${decision.founding.total}`
    : `รายปี ${thb(decision.annualMonthlyThb)}/เดือน ชำระปีละครั้ง · ประหยัด 2 เดือน`;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-4"
      style={{
        paddingTop: "max(1rem, env(safe-area-inset-top))",
        paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-clip-convert-title"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismiss} />
      <div className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-[#111118] p-6 shadow-2xl">
        <button
          type="button"
          onClick={dismiss}
          className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:text-zinc-300"
          aria-label="ปิด"
        >
          <X className="h-4 w-4" />
        </button>

        <p className="pr-10 text-[13px] font-semibold tracking-wide text-violet-300">คลิปแรกออกแล้ว</p>
        <h3 id="first-clip-convert-title" className="mt-1 pr-10 text-lg font-bold leading-snug text-white">
          ทำแบบนี้ได้อีก {benefits.minutesPerMonth} นาทีทุกเดือน
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
          {firstClipConvertTrialLine({ trialDaysLeft, minutesLeft: minutesLeftFrom(me) })}
        </p>

        <ul className="mt-4 space-y-2">
          {checks.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[13px] leading-relaxed text-zinc-300">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void checkout("monthly")}
          className="mt-5 min-h-11 w-full rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
          style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
        >
          {busy === "monthly"
            ? "กำลังเปิดหน้าชำระเงิน…"
            : `สมัคร PRO รายเดือน ${thb(decision.monthlyPriceThb)}/เดือน · ยกเลิกได้ทุกเมื่อ`}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void checkout("annual")}
          className="mt-2 min-h-11 w-full rounded-xl border border-white/10 px-4 py-2.5 text-[13px] font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-60"
        >
          {busy === "annual" ? "กำลังเปิดหน้าชำระเงิน…" : secondaryLabel}
        </button>

        {error && <p className="mt-3 text-center text-[13px] text-rose-300">{error}</p>}

        <p className="mt-3 text-center text-[13px] text-zinc-500">PromptPay หรือบัตร · ใบเสร็จอัตโนมัติ</p>
        <button
          type="button"
          onClick={dismiss}
          className="mt-2 min-h-11 w-full rounded-xl px-4 py-2 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ไว้ทีหลัง — ทำคลิปต่อ
        </button>
      </div>
    </div>
  );
}
