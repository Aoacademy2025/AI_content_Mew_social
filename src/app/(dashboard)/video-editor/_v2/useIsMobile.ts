"use client";

import { useEffect, useState } from "react";

/**
 * viewport breakpoint เดียวของ editor v2: <1024px = mobile.
 * SSR-safe — ค่าเริ่มต้น false (desktop) แล้วอ่านค่าจริงใน useEffect ตอน mount
 * (กัน hydration mismatch: server ไม่มี window/matchMedia).
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}
