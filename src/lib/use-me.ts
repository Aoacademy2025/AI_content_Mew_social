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
  recommendedAutoMixDefault?: boolean;
  firstClipPath?: boolean;
  firstClipPathReason?: "on_path" | "conversion_trial" | "internal" | "not_paid_equivalent" | "has_completed_video";
  firstClipProgress?: { activeRender: boolean; renderedClip: boolean } | null;
  minuteQuota?: boolean;
  minutesUsed?: number;
  minutesLimit?: number;
  heroScriptAllowed?: boolean;
  heroScriptPreview?: boolean;
  heroScriptCohort?: "internal" | "paid" | "coupon" | "bundle" | "grant" | "trial" | "free" | "preview";
  brandVisualAllowed?: boolean;
  brandVisualCohort?: "off" | "internal" | "not-entitled" | "rollout-wait" | "treatment-10" | "treatment-50" | "treatment-100";
  brandVisualRolloutBucket?: number | null;
  starterAiImageAllowance?: {
    eligible: boolean;
    fundingSource: "starter_allowance" | "credits";
    windowStartedAt: string;
    windowEndsAt: string;
    limitImages: number;
    reservedImages: number;
    usedImages: number;
    remainingImages: number;
    accessMode: "trial" | "paid" | "locked" | "legacy";
  } | null;
  featureAccess?: {
    heroAiImage?: { canUse: boolean; canPreview: boolean; mode: string; source: string; reason: string; remainingTrialImages: number };
    heroAiScript?: { canUse: boolean; canPreview: boolean; mode: string; source: string; reason: string };
    brandVisual?: { canUse: boolean; mode: string; source: string; reason: string; rolloutBucket: number | null };
  };
  [key: string]: unknown;
}

const TTL_MS = 5000;

let cached: MeData | null = null;
let cachedAt = 0;
let inFlight: Promise<MeData | null> | null = null;

/**
 * The API returns both a boolean convenience field and the durable rollout
 * cohort. Treat an admitted cohort as authoritative too: this keeps a client
 * that crossed a rolling deploy from hiding Brand Visual when an older cached
 * response omitted only the newly-added boolean. `off` and `control` remain
 * fail-closed, so the master rollback still closes new admission.
 */
export function resolveBrandVisualClientAccess(me: MeData | null | undefined): boolean {
  if (me?.brandVisualAllowed === true) return true;
  return me?.brandVisualCohort === "internal"
    || me?.brandVisualCohort === "treatment-10"
    || me?.brandVisualCohort === "treatment-50"
    || me?.brandVisualCohort === "treatment-100";
}

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
      // Entitlements and rollout cohorts can change while a long-lived Editor
      // tab is open. Never let the browser HTTP cache preserve an older shape
      // across a production rollout; the short in-module TTL above is the only
      // intended deduplication layer.
      const res = await fetch("/api/user/me", { cache: "no-store" });
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
