"use client";

// Shared client-side fetcher for /api/user/me.
//
// หน้า dashboard เรียก /api/user/me จากหลาย component พร้อมกัน (sidebar,
// banners, modals, editor pages) — แต่ละตัวเรียกแยกกัน ทำให้ route นี้ (ซึ่ง
// แตะ Clerk auth + Prisma + syncUsageWindow) ถูกยิงพร้อมกันหลายครั้งต่อ
// page-load → ช้าสะสม + ชน SQLite. ตัวนี้ dedup ให้เหลือ network call เดียว
// ต่อ TTL แล้วแชร์ผลลัพธ์ให้ทุก caller.

export interface MeData {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  plan?: string;
  effectivePlan?: string;
  usageCount?: number;
  usageLimit?: number;
  usagePeriodStartedAt?: string | null;
  usageResetAt?: string | null;
  avatar?: string | null;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  internalAiTester?: boolean;
  heroAiBeta?: boolean;
  heroAiImageEligible?: boolean;
  heroScriptAllowed?: boolean;
  heroScriptPreview?: boolean;
  heroScriptCohort?: "internal" | "paid" | "trial" | "free" | "preview";
  [key: string]: unknown;
}

const TTL_MS = 5000;

let cached: MeData | null = null;
let cachedAt = 0;
let inFlight: Promise<MeData | null> | null = null;

/**
 * Fetch /api/user/me แบบ dedup + cache. หลาย caller ที่เรียกพร้อมกันใน TTL
 * เดียวกันจะได้ผลจาก network call เดียว.
 * @param force ข้าม cache (เช่น หลังจ่ายเงิน/อัปเกรดเสร็จ ต้องการค่าล่าสุด)
 */
export async function fetchMe(force = false): Promise<MeData | null> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL_MS) return cached;
  if (!force && inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch("/api/user/me");
      if (!res.ok) return cached; // คง cache เดิมไว้ถ้า fail
      const data = (await res.json()) as MeData;
      cached = data;
      cachedAt = Date.now();
      return data;
    } catch {
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** ล้าง cache (เช่น หลัง logout หรือเปลี่ยน account) */
export function clearMeCache() {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
