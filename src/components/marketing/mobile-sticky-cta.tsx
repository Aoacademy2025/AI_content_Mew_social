"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

const ACCENT = "linear-gradient(135deg,#9D7BFF 0%,#7857F6 55%,#6844EF 100%)";

export function MobileStickyCta() {
  const [pricingInView, setPricingInView] = useState(false);

  useEffect(() => {
    const pricing = document.querySelector("#pricing");
    if (!pricing) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = pricing.getBoundingClientRect();
        setPricingInView(rect.bottom > window.innerHeight * 0.18 && rect.top < window.innerHeight * 0.82);
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0c0912]/92 px-3 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl sm:hidden">
      <Link
        href="/register"
        data-mobile-sticky-cta
        data-pricing-active={pricingInView ? "true" : "false"}
        className="sale-v2-cta flex min-h-12 w-full items-center justify-center gap-2 rounded-[13px] text-[14px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
        style={{ background: ACCENT }}
      >
        {pricingInView ? "ทดลอง Pro ฟรี 7 วัน" : "สร้างคลิปแรกฟรี"}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}
