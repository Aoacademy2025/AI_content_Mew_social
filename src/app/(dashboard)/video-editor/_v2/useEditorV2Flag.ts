"use client";

import { useEffect, useState } from "react";

/**
 * Editor v2 rollout switch (2 ชั้น — ดู docs/superpowers/plans/2026-07-02-video-editor-v2-redesign.md):
 * 1. env default: NEXT_PUBLIC_EDITOR_V2=1 → ทุกคนเห็น v2 (build-time)
 * 2. per-person override: เปิดหน้าด้วย ?ui=v2 หรือ ?ui=v1 → จำลง localStorage
 *    ใช้ QA v2 บน prod ก่อน flip ให้ทุกคน / เป็นทางหนีกลับ v1 หลัง flip
 *
 * SSR/hydration: ฝั่ง server ไม่รู้จัก override → เรนเดอร์ตาม env default ก่อนเสมอ
 * แล้วค่อยสลับหลัง mount ถ้า override ไม่ตรง (คนไม่มี override = ไม่มีการสลับ ไม่มี flash)
 */

const V2_DEFAULT = process.env.NEXT_PUBLIC_EDITOR_V2 === "1";
const STORAGE_KEY = "editor-ui";

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function useEditorV2(): boolean {
  const [override, setOverride] = useState<"v1" | "v2" | null>(null);

  useEffect(() => {
    try {
      const storage = browserStorage();
      const q = new URLSearchParams(window.location.search).get("ui");
      if (q === "v1" || q === "v2") storage?.setItem(STORAGE_KEY, q);
      const stored = storage?.getItem(STORAGE_KEY);
      if (stored === "v1" || stored === "v2") setOverride(stored);
    } catch {
      // localStorage unavailable (private mode ฯลฯ) → ใช้ env default
    }
  }, []);

  return override ? override === "v2" : V2_DEFAULT;
}
